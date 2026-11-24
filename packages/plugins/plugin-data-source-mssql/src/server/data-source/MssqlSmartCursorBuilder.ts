// SPDX-License-Identifier: Apache-2.0

import { Sequelize, QueryTypes, Op } from 'sequelize';
import { Model } from '@nocobase/database';
import _ from 'lodash';
import { quoteIdentifier } from '../security/sql-quote';

type SortDirection = 'ASC' | 'DESC';

interface IndexInfo {
  name: string;
  columns: string[];
  isPrimary: boolean;
  isUnique: boolean;
}

interface CursorRow {
  getDataValue?: (key: string) => unknown;
  get?: (key: string) => unknown;
  [key: string]: unknown;
}

interface CursorCollectionLike {
  filterTargetKey: string | string[];
  model?: {
    rawAttributes?: Record<string, { field?: string }>;
  };
}

interface IndexMetadataRow {
  INDEX_NAME: string;
  COLUMN_NAME: string;
  SEQ_IN_INDEX: number;
  INDEX_TYPE: number;
  DIRECTION: string;
  IS_NULLABLE?: boolean | number;
}

interface FindOptions {
  chunkSize?: number;
  callback?: (rows: Model[], options: FindOptions) => Promise<void>;
  find?: (options: FindOptions) => Promise<Model[]>;
  beforeFind?: (options: FindOptions) => Promise<void>;
  afterFind?: (rows: Model[], options: FindOptions) => Promise<void>;
  where?: Record<string | symbol, unknown>;
  order?: Array<[string, SortDirection]>;
  limit?: number;
  [key: string]: unknown;
}

export interface MssqlChunkOptions extends FindOptions {
  stream?: (
    queryOptions: FindOptions,
    onBatch: (rows: Model[], queryOptions: FindOptions) => Promise<void>,
  ) => Promise<void>;
}

/**
 * Cursor-based pagination strategy interface
 */
interface CursorStrategy {
  getColumns(): string[];
  buildWhere(
    baseWhere: Record<string | symbol, unknown> | undefined,
    record?: CursorRow,
  ): Record<string | symbol, unknown> | null | undefined;
  buildSort(): Array<[string, SortDirection]>;
  hasCursorValues(record?: CursorRow): boolean;
  snapshotCursor(record: CursorRow): CursorRow;
}

interface CursorProjectionPlan {
  queryOptions: FindOptions;
  injectedColumns: string[];
}

function hasAttributeEntry(attributes: unknown[], column: string): boolean {
  return attributes.some((entry) => entry === column || (Array.isArray(entry) && entry[entry.length - 1] === column));
}

function prepareCursorProjection(options: FindOptions, cursorColumns: string[]): CursorProjectionPlan {
  if (cursorColumns.length === 0) {
    return { queryOptions: options, injectedColumns: [] };
  }

  // `attributes` takes precedence over `fields`/`except` in NocoBase OptionsParser.parseFields().
  const rawAttributes = options.attributes;
  if (rawAttributes !== undefined) {
    if (Array.isArray(rawAttributes)) {
      const missing = cursorColumns.filter((col) => !hasAttributeEntry(rawAttributes, col));
      if (missing.length > 0) {
        return {
          queryOptions: { ...options, attributes: [...rawAttributes, ...missing] },
          injectedColumns: missing,
        };
      }
      return { queryOptions: options, injectedColumns: [] };
    }
    if (rawAttributes && typeof rawAttributes === 'object') {
      const attrObj = rawAttributes as { include?: unknown[]; exclude?: unknown[] };
      if (Array.isArray(attrObj.exclude)) {
        const excludeList = attrObj.exclude;
        const excludedCursor = cursorColumns.filter((col) => excludeList.includes(col));
        if (excludedCursor.length > 0) {
          return {
            queryOptions: {
              ...options,
              attributes: {
                ...attrObj,
                exclude: excludeList.filter((col) => !excludedCursor.includes(String(col))),
              },
            },
            injectedColumns: excludedCursor,
          };
        }
      }
    }
    return { queryOptions: options, injectedColumns: [] };
  }

  let nextOptions: FindOptions = options;
  const injectedSet = new Set<string>();

  if (Array.isArray(options.fields)) {
    const fieldsList = options.fields as unknown[];
    const missing = cursorColumns.filter((col) => !fieldsList.includes(col));
    if (missing.length > 0) {
      nextOptions = { ...nextOptions, fields: [...fieldsList, ...missing] };
      for (const col of missing) {
        injectedSet.add(col);
      }
    }
  }

  if (Array.isArray(options.except)) {
    const exceptList = options.except as unknown[];
    const excludedCursor = cursorColumns.filter((col) => exceptList.includes(col));
    if (excludedCursor.length > 0) {
      nextOptions = {
        ...nextOptions,
        except: exceptList.filter((col) => !excludedCursor.includes(String(col))),
      };
      for (const col of excludedCursor) {
        injectedSet.add(col);
      }
    }
  }

  return { queryOptions: nextOptions, injectedColumns: [...injectedSet] };
}

function stripInjectedColumnsFromRows(rows: Model[], columns: string[]): void {
  if (columns.length === 0) {
    return;
  }
  for (const row of rows) {
    const typedRow = row as unknown as {
      dataValues?: Record<string, unknown>;
      _previousDataValues?: Record<string, unknown>;
      [key: string]: unknown;
    };
    const dataValues = typedRow.dataValues && typeof typedRow.dataValues === 'object' ? typedRow.dataValues : undefined;
    const prevDataValues =
      typedRow._previousDataValues && typeof typedRow._previousDataValues === 'object'
        ? typedRow._previousDataValues
        : undefined;
    for (const col of columns) {
      if (dataValues) {
        delete dataValues[col];
        if (prevDataValues) {
          delete prevDataValues[col];
        }
      } else if (Object.prototype.hasOwnProperty.call(typedRow, col)) {
        delete typedRow[col];
      }
    }
  }
}

function readSingleField(record: CursorRow, key: string): unknown {
  if (typeof record.getDataValue === 'function') {
    const raw = record.getDataValue(key);
    if (raw !== undefined) {
      return raw;
    }
  }
  if (typeof record.get === 'function') {
    const value = record.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return record[key];
}

function readRecordField(record: CursorRow, attrName: string, physicalColumn?: string): unknown {
  const value = readSingleField(record, attrName);
  if (value !== undefined) {
    return value;
  }
  if (physicalColumn && physicalColumn !== attrName) {
    return readSingleField(record, physicalColumn);
  }
  return undefined;
}

function normalizeDirection(direction?: string): SortDirection {
  return direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
}

/**
 * Builds a three-valued SQL Server strict comparison for a single cursor column, accounting for
 * `NULL` ordering (`NULL` sorts first in `ASC` and last in `DESC`). Returns `null` when no rows can
 * strictly follow `value` along `direction` (e.g. `DESC` at `NULL`).
 */
function buildStrictCursorCondition(
  column: string,
  direction: SortDirection,
  value: unknown,
  isNullable: boolean,
): Record<string | symbol, unknown> | null {
  if (value === null) {
    return direction === 'ASC' ? { [column]: { [Op.not]: null } } : null;
  }
  if (direction === 'ASC') {
    return { [column]: { [Op.gt]: value } };
  }
  if (isNullable) {
    return { [column]: { [Op.or]: [{ [Op.lt]: value }, { [Op.is]: null }] } };
  }
  return { [column]: { [Op.lt]: value } };
}

/**
 * Single column cursor strategy - for tables with single-column primary key or unique index
 */
class SingleColumnCursorStrategy implements CursorStrategy {
  public columnName: string;
  public direction: SortDirection;
  private physicalColumn?: string;
  private isNullable: boolean;

  constructor(columnName: string, direction: SortDirection = 'ASC', physicalColumn?: string, isNullable = false) {
    this.columnName = columnName;
    this.direction = direction;
    this.physicalColumn = physicalColumn;
    this.isNullable = isNullable;
  }

  getColumns(): string[] {
    return [this.columnName];
  }

  buildSort(): Array<[string, SortDirection]> {
    return [[this.columnName, this.direction]];
  }

  hasCursorValues(record?: CursorRow): boolean {
    return record !== undefined && readRecordField(record, this.columnName, this.physicalColumn) !== undefined;
  }

  snapshotCursor(record: CursorRow): CursorRow {
    return {
      [this.columnName]: readRecordField(record, this.columnName, this.physicalColumn),
    };
  }

  buildWhere(
    baseWhere: Record<string | symbol, unknown> | undefined,
    record?: CursorRow,
  ): Record<string | symbol, unknown> | null | undefined {
    if (!record) {
      return baseWhere;
    }
    const cursorValue = readRecordField(record, this.columnName, this.physicalColumn);
    const cursorCondition = buildStrictCursorCondition(this.columnName, this.direction, cursorValue, this.isNullable);
    if (!cursorCondition) {
      return null;
    }
    if (!baseWhere) {
      return cursorCondition;
    }
    // Preserve any existing filter on the cursor column or symbol-keyed compound predicates (Op.and/Op.or).
    const hasConflict =
      Object.prototype.hasOwnProperty.call(baseWhere, this.columnName) ||
      Object.getOwnPropertySymbols(baseWhere).length > 0;
    if (hasConflict) {
      return { [Op.and]: [baseWhere, cursorCondition] };
    }
    return { ...baseWhere, ...cursorCondition };
  }
}

/**
 * Composite key cursor strategy - for tables with composite primary key or multi-column unique index
 */
class CompositeKeyCursorStrategy implements CursorStrategy {
  private columns: string[];
  private directions: SortDirection[];
  private physicalColumns: Array<string | undefined>;
  private nullables: boolean[];

  constructor(
    columns: string[],
    directions?: string[],
    physicalColumns?: Array<string | undefined>,
    nullables?: boolean[],
  ) {
    this.columns = columns;
    this.directions = columns.map((_, index) => normalizeDirection(directions?.[index]));
    this.physicalColumns = columns.map((_, index) => physicalColumns?.[index]);
    this.nullables = columns.map((_, index) => Boolean(nullables?.[index]));
  }

  getColumns(): string[] {
    return [...this.columns];
  }

  buildSort(): Array<[string, SortDirection]> {
    const orderBy: Array<[string, SortDirection]> = [];
    for (let i = 0; i < this.columns.length; i++) {
      orderBy.push([this.columns[i], this.directions[i]]);
    }
    return orderBy;
  }

  hasCursorValues(record?: CursorRow): boolean {
    if (!record) {
      return false;
    }
    return this.columns.every((col, idx) => readRecordField(record, col, this.physicalColumns[idx]) !== undefined);
  }

  snapshotCursor(record: CursorRow): CursorRow {
    const snapshot: CursorRow = {};
    for (let i = 0; i < this.columns.length; i++) {
      const col = this.columns[i];
      snapshot[col] = readRecordField(record, col, this.physicalColumns[i]);
    }
    return snapshot;
  }

  buildWhere(
    baseWhere: Record<string | symbol, unknown> | undefined,
    record?: CursorRow,
  ): Record<string | symbol, unknown> | null | undefined {
    if (!record) {
      return baseWhere;
    }
    const whereConditions: Array<Record<string | symbol, unknown>> = [];

    for (let i = 0; i < this.columns.length; i++) {
      const column = this.columns[i];
      const colVal = readRecordField(record, column, this.physicalColumns[i]);
      const strictCond = buildStrictCursorCondition(column, this.directions[i], colVal, this.nullables[i]);
      if (!strictCond) {
        continue;
      }

      const condition: Record<string | symbol, unknown> = {};
      for (let j = 0; j < i; j++) {
        const prefixCol = this.columns[j];
        const prefixVal = readRecordField(record, prefixCol, this.physicalColumns[j]);
        condition[prefixCol] = prefixVal === null ? { [Op.is]: null } : prefixVal;
      }

      condition[column] = strictCond[column];
      whereConditions.push(condition);
    }

    if (whereConditions.length === 0) {
      return null;
    }

    const cursorCondition = whereConditions.length === 1 ? whereConditions[0] : { [Op.or]: whereConditions };
    return baseWhere ? { [Op.and]: [baseWhere, cursorCondition] } : cursorCondition;
  }
}

/**
 * MSSQL-specific SmartCursorBuilder
 * Provides cursor-based pagination for efficient large dataset processing
 */
export class MssqlSmartCursorBuilder {
  private sequelize: Sequelize;
  private tableName: string;
  private collection: CursorCollectionLike;
  private schema?: string;
  private strategyResolved = false;
  private cachedStrategy: CursorStrategy | null = null;
  private cachedFallbackOrder?: Array<[string, SortDirection]>;

  constructor(sequelize: Sequelize, tableName: string, collection: CursorCollectionLike, schema?: string) {
    this.sequelize = sequelize;
    this.tableName = tableName;
    this.collection = collection;
    this.schema = schema;
  }

  /**
   * Maps a physical SQL Server column name from `sys.columns` to its Sequelize model attribute name
   * so `order`, `where`, and `record.get()` align even when `rawAttributes[attr].field !== attr`.
   */
  private resolveAttributeName(physicalColumn: string): string {
    const rawAttributes = this.collection.model?.rawAttributes;
    if (!rawAttributes) {
      return physicalColumn;
    }
    if (Object.prototype.hasOwnProperty.call(rawAttributes, physicalColumn)) {
      return physicalColumn;
    }
    for (const [attrName, attrDef] of Object.entries(rawAttributes)) {
      if (attrDef?.field === physicalColumn) {
        return attrName;
      }
    }
    return physicalColumn;
  }

  private resolvePhysicalColumnName(attrName: string): string | undefined {
    return this.collection.model?.rawAttributes?.[attrName]?.field;
  }

  /**
   * Fully schema-qualified, bracket-quoted object name for OBJECT_ID(). NocoBase stores the schema
   * separately from tableName, so passing a bare tableName makes OBJECT_ID() resolve only the
   * connection's default schema and silently miss every table living in any other schema.
   */
  private getQualifiedTableName(): string {
    const quotedTable = quoteIdentifier(this.tableName);
    return this.schema ? `${quoteIdentifier(this.schema)}.${quotedTable}` : quotedTable;
  }

  /**
   * Auto-detect the best cursor strategy based on table structure.
   * Uses keyset pagination only when a primary key or unique index guarantees strict row uniqueness;
   * otherwise returns `null` so `chunk()` uses single-query streaming without multi-query OFFSET drift.
   */
  public async getBestCursorStrategy(): Promise<CursorStrategy | null> {
    if (this.strategyResolved) {
      return this.cachedStrategy;
    }

    const indexInfoSql = `
      SELECT 
        i.name AS INDEX_NAME,
        c.name AS COLUMN_NAME,
        ic.key_ordinal AS SEQ_IN_INDEX,
        CASE 
          WHEN i.is_primary_key = 1 THEN 1
          WHEN i.is_unique = 1 THEN 2
          ELSE 3 
        END as INDEX_TYPE,
        CASE WHEN ic.is_descending_key = 1 THEN 'DESC' ELSE 'ASC' END as DIRECTION,
        c.is_nullable AS IS_NULLABLE
      FROM 
        sys.indexes i
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND c.column_id = ic.column_id
      WHERE 
        i.object_id = OBJECT_ID(?)
        AND i.type > 0
        AND i.has_filter = 0
        AND i.is_disabled = 0
        AND ic.is_included_column = 0
      ORDER BY 
        i.name, 
        ic.key_ordinal
    `;

    try {
      const indexRows = (await this.sequelize.query(indexInfoSql, {
        type: QueryTypes.SELECT,
        replacements: [this.getQualifiedTableName()],
        raw: true,
      })) as IndexMetadataRow[];

      const indexes: Map<string, IndexInfo> = new Map();
      const indexDirections: Map<string, Map<string, SortDirection>> = new Map();
      const indexNullables: Map<string, Map<string, boolean>> = new Map();
      const attrToPhysical = new Map<string, string>();

      if (!indexRows || indexRows.length === 0) {
        this.strategyResolved = true;
        this.cachedStrategy = null;
        return null;
      }

      for (const row of indexRows) {
        const indexName = row.INDEX_NAME;
        const physicalColumnName = row.COLUMN_NAME;
        const columnName = this.resolveAttributeName(physicalColumnName);
        attrToPhysical.set(columnName, physicalColumnName);
        const indexType = row.INDEX_TYPE;
        const direction = normalizeDirection(row.DIRECTION);
        const isPrimary = indexType === 1;
        const isNullable = isPrimary ? false : Boolean(row.IS_NULLABLE);

        let dirMap = indexDirections.get(indexName);
        if (!dirMap) {
          dirMap = new Map();
          indexDirections.set(indexName, dirMap);
        }
        dirMap.set(columnName, direction);

        let nullMap = indexNullables.get(indexName);
        if (!nullMap) {
          nullMap = new Map();
          indexNullables.set(indexName, nullMap);
        }
        nullMap.set(columnName, isNullable);

        let index = indexes.get(indexName);
        if (!index) {
          index = {
            name: indexName,
            columns: [],
            isPrimary,
            isUnique: indexType < 3,
          };
          indexes.set(indexName, index);
        }
        index.columns[row.SEQ_IN_INDEX - 1] = columnName;
      }

      // Remove any sparse holes defensively
      for (const index of indexes.values()) {
        index.columns = index.columns.filter((col): col is string => typeof col === 'string' && col.length > 0);
      }

      const buildStrategyForIndex = (index: IndexInfo): CursorStrategy => {
        const directions = index.columns.map((col) => indexDirections.get(index.name)?.get(col) || 'ASC');
        const physicalColumns = index.columns.map(
          (col) => attrToPhysical.get(col) ?? this.resolvePhysicalColumnName(col),
        );
        const nullables = index.columns.map((col) =>
          index.isPrimary ? false : indexNullables.get(index.name)?.get(col) ?? false,
        );
        if (index.columns.length === 1) {
          return new SingleColumnCursorStrategy(index.columns[0], directions[0], physicalColumns[0], nullables[0]);
        }
        return new CompositeKeyCursorStrategy(index.columns, directions, physicalColumns, nullables);
      };

      const rawAttributes = this.collection.model?.rawAttributes;
      const isUsableIndex = (index: IndexInfo): boolean =>
        index.columns.length > 0 &&
        (!rawAttributes || index.columns.every((col) => Object.prototype.hasOwnProperty.call(rawAttributes, col)));

      // 1. Primary key (guaranteed unique)
      for (const index of indexes.values()) {
        if (index.isPrimary && isUsableIndex(index)) {
          this.cachedStrategy = buildStrategyForIndex(index);
          this.strategyResolved = true;
          return this.cachedStrategy;
        }
      }

      // 2. Unique index (prefer single column)
      let singleColumnUniqueIndex: IndexInfo | null = null;
      let multiColumnUniqueIndex: IndexInfo | null = null;

      for (const index of indexes.values()) {
        if (index.isUnique && !index.isPrimary && isUsableIndex(index)) {
          if (index.columns.length === 1 && !singleColumnUniqueIndex) {
            singleColumnUniqueIndex = index;
          } else if (index.columns.length > 1 && !multiColumnUniqueIndex) {
            multiColumnUniqueIndex = index;
          }
        }
      }

      if (singleColumnUniqueIndex) {
        this.cachedStrategy = buildStrategyForIndex(singleColumnUniqueIndex);
        this.strategyResolved = true;
        return this.cachedStrategy;
      }

      if (multiColumnUniqueIndex) {
        this.cachedStrategy = buildStrategyForIndex(multiColumnUniqueIndex);
        this.strategyResolved = true;
        return this.cachedStrategy;
      }

      // No guaranteed-unique index exists; preserve any usable non-unique index ordering for offset fallback
      // rather than risking silent row loss across batch boundaries with keyset pagination.
      for (const index of indexes.values()) {
        if (!index.isPrimary && !index.isUnique && isUsableIndex(index)) {
          this.cachedFallbackOrder = index.columns.map(
            (col) => [col, indexDirections.get(index.name)?.get(col) || 'ASC'] as [string, SortDirection],
          );
          break;
        }
      }

      this.strategyResolved = true;
      this.cachedStrategy = null;
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[MssqlSmartCursorBuilder] Error getting index info: ${message}\n`);
      return null;
    }
  }

  /**
   * Executes one single non-offset query when no unique index exists, avoiding row drift across
   * repeated OFFSET scans on SQL Server tables/views with duplicate keys or heap ordering.
   */
  private async chunkWithoutUniqueKey(
    options: MssqlChunkOptions,
    overallLimit: number | undefined,
    findFn: NonNullable<FindOptions['find']>,
    callbackFn: NonNullable<FindOptions['callback']>,
  ): Promise<void> {
    const chunkSize = options.chunkSize || 1000;
    const hasCallerSort = Boolean(
      (Array.isArray(options.order) ? options.order.length > 0 : options.order) ||
        (typeof options.sort === 'string'
          ? options.sort.trim().length > 0
          : Array.isArray(options.sort) && options.sort.length > 0),
    );

    const singleQueryOptions = _.omit(
      options,
      'callback',
      'beforeFind',
      'afterFind',
      'chunkSize',
      'find',
      'stream',
      'offset',
    ) as FindOptions;
    singleQueryOptions.where = options.where;
    if (overallLimit !== undefined) {
      singleQueryOptions.limit = overallLimit;
    } else {
      delete singleQueryOptions.limit;
    }
    delete singleQueryOptions.offset;
    if (!hasCallerSort && this.cachedFallbackOrder) {
      singleQueryOptions.order = this.cachedFallbackOrder;
      singleQueryOptions.parseSort = false;
    }

    if (typeof options.stream === 'function') {
      let firstBatch = true;
      if (options.beforeFind) {
        await options.beforeFind(singleQueryOptions);
      }
      await options.stream(singleQueryOptions, async (batch, batchOptions) => {
        if (!firstBatch && options.beforeFind) {
          await options.beforeFind(batchOptions);
        }
        firstBatch = false;
        if (options.afterFind) {
          await options.afterFind(batch, batchOptions);
        }
        if (batch.length > 0) {
          await callbackFn(batch, batchOptions);
        }
      });
      return;
    }

    if (options.beforeFind) {
      await options.beforeFind(singleQueryOptions);
    }
    const records = await findFn(singleQueryOptions);
    if (options.afterFind) {
      await options.afterFind(records, singleQueryOptions);
    }
    const bounded =
      overallLimit !== undefined && records.length > overallLimit ? records.slice(0, overallLimit) : records;
    for (let offset = 0; offset < bounded.length; offset += chunkSize) {
      await callbackFn(bounded.slice(offset, offset + chunkSize), singleQueryOptions);
    }
  }

  /**
   * Cursor-based pagination query function.
   * Honors `options.limit` (e.g. `EXPORT_LIMIT`) as an upper bound across all batches.
   */
  async chunk(options: MssqlChunkOptions) {
    const findFn = options.find;
    const callbackFn = options.callback;
    if (!findFn || !callbackFn) {
      throw new Error('chunk() requires both find and callback functions');
    }

    const overallLimit = options.limit !== undefined && options.limit !== null ? Number(options.limit) : undefined;
    if (overallLimit !== undefined && (!Number.isFinite(overallLimit) || overallLimit <= 0)) {
      return;
    }

    const cursorStrategy = await this.getBestCursorStrategy();
    if (!cursorStrategy) {
      await this.chunkWithoutUniqueKey(options, overallLimit, findFn, callbackFn);
      return;
    }
    let cursorRecord: CursorRow | undefined;
    let isFirst = true;

    // Avoid mutating the caller's options object; snapshot the caller's WHERE once so composite
    // cursors do not nest Op.and deeper on every batch.
    const baseWhere = options.where;
    const chunkSize = options.chunkSize || 1000;
    const runOptions: FindOptions = {
      ...options,
      order: cursorStrategy.buildSort(),
      parseSort: false,
      limit: overallLimit !== undefined ? Math.min(chunkSize, overallLimit) : chunkSize,
    };

    let totalProcessed = 0;
    let hasMoreData = true;
    while (hasMoreData) {
      const remaining = overallLimit !== undefined ? overallLimit - totalProcessed : undefined;
      if (remaining !== undefined && remaining <= 0) {
        break;
      }
      const currentLimit = remaining !== undefined ? Math.min(chunkSize, remaining) : chunkSize;

      if (!isFirst) {
        const nextWhere = cursorStrategy.buildWhere(baseWhere, cursorRecord);
        if (nextWhere === null) {
          hasMoreData = false;
          break;
        }
        runOptions.where = nextWhere;
      } else {
        runOptions.where = baseWhere;
        isFirst = false;
      }

      runOptions.limit = currentLimit;

      if (options.beforeFind) {
        await options.beforeFind(runOptions);
      }

      const { queryOptions, injectedColumns } = prepareCursorProjection(runOptions, cursorStrategy.getColumns());
      const records = await findFn(_.omit(queryOptions, 'callback', 'beforeFind', 'afterFind', 'chunkSize', 'find'));

      if (options.afterFind) {
        await options.afterFind(records, runOptions);
      }

      if (records.length === 0) {
        hasMoreData = false;
        continue;
      }

      const batch = remaining !== undefined && records.length > remaining ? records.slice(0, remaining) : records;
      const lastRecord = batch[batch.length - 1] as unknown as CursorRow;
      const nextCursor = cursorStrategy.hasCursorValues(lastRecord)
        ? cursorStrategy.snapshotCursor(lastRecord)
        : undefined;

      stripInjectedColumnsFromRows(batch, injectedColumns);
      await callbackFn(batch, runOptions);
      totalProcessed += batch.length;

      // Stop when overallLimit is reached or fewer than currentLimit rows were returned.
      if ((overallLimit !== undefined && totalProcessed >= overallLimit) || records.length < currentLimit) {
        hasMoreData = false;
        continue;
      }

      if (!nextCursor) {
        hasMoreData = false;
        continue;
      }
      cursorRecord = nextCursor;
    }
  }
}
