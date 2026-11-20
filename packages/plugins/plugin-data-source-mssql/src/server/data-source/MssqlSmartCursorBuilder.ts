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

/**
 * Cursor-based pagination strategy interface
 */
interface CursorStrategy {
  buildWhere(
    baseWhere: Record<string | symbol, unknown> | undefined,
    record?: CursorRow,
  ): Record<string | symbol, unknown> | undefined;
  buildSort(): Array<[string, SortDirection]>;
  hasCursorValues(record?: CursorRow): boolean;
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
 * Single column cursor strategy - for tables with single-column primary key or unique index
 */
class SingleColumnCursorStrategy implements CursorStrategy {
  public columnName: string;
  public direction: SortDirection;
  private physicalColumn?: string;

  constructor(columnName: string, direction: SortDirection = 'ASC', physicalColumn?: string) {
    this.columnName = columnName;
    this.direction = direction;
    this.physicalColumn = physicalColumn;
  }

  buildSort(): Array<[string, SortDirection]> {
    return [[this.columnName, this.direction]];
  }

  hasCursorValues(record?: CursorRow): boolean {
    return record !== undefined && readRecordField(record, this.columnName, this.physicalColumn) !== undefined;
  }

  buildWhere(
    baseWhere: Record<string | symbol, unknown> | undefined,
    record?: CursorRow,
  ): Record<string | symbol, unknown> | undefined {
    if (!record) {
      return baseWhere;
    }
    const op = this.direction === 'DESC' ? Op.lt : Op.gt;
    const cursorValue = readRecordField(record, this.columnName, this.physicalColumn);
    const cursorCondition = { [this.columnName]: { [op]: cursorValue } };
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

  constructor(columns: string[], directions?: string[], physicalColumns?: Array<string | undefined>) {
    this.columns = columns;
    this.directions = columns.map((_, index) => normalizeDirection(directions?.[index]));
    this.physicalColumns = columns.map((_, index) => physicalColumns?.[index]);
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

  buildWhere(
    baseWhere: Record<string | symbol, unknown> | undefined,
    record?: CursorRow,
  ): Record<string | symbol, unknown> | undefined {
    if (!record) {
      return baseWhere;
    }
    const whereConditions: Array<Record<string, unknown>> = [];

    for (let i = 0; i < this.columns.length; i++) {
      const column = this.columns[i];
      const op = this.directions[i] === 'DESC' ? Op.lt : Op.gt;
      const condition: Record<string, unknown> = {};

      for (let j = 0; j < i; j++) {
        condition[this.columns[j]] = readRecordField(record, this.columns[j], this.physicalColumns[j]);
      }

      condition[column] = { [op]: readRecordField(record, column, this.physicalColumns[i]) };
      whereConditions.push(condition);
    }

    const cursorCondition = { [Op.or]: whereConditions };
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
  private cachedStrategy: CursorStrategy | null = null;

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
   * Uses MSSQL system views to find an optimal unique index for cursor pagination and caches the result.
   */
  private async getBestCursorStrategy(): Promise<CursorStrategy> {
    if (this.cachedStrategy) {
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
        CASE WHEN ic.is_descending_key = 1 THEN 'DESC' ELSE 'ASC' END as DIRECTION
      FROM 
        sys.indexes i
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND c.column_id = ic.column_id
      WHERE 
        i.object_id = OBJECT_ID(?)
        AND i.type > 0
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
      const attrToPhysical = new Map<string, string>();

      if (!indexRows || indexRows.length === 0) {
        this.cachedStrategy = this.getFallbackStrategy();
        return this.cachedStrategy;
      }

      for (const row of indexRows) {
        const indexName = row.INDEX_NAME;
        const physicalColumnName = row.COLUMN_NAME;
        const columnName = this.resolveAttributeName(physicalColumnName);
        attrToPhysical.set(columnName, physicalColumnName);
        const indexType = row.INDEX_TYPE;
        const direction = normalizeDirection(row.DIRECTION);

        let dirMap = indexDirections.get(indexName);
        if (!dirMap) {
          dirMap = new Map();
          indexDirections.set(indexName, dirMap);
        }
        dirMap.set(columnName, direction);

        let index = indexes.get(indexName);
        if (!index) {
          index = {
            name: indexName,
            columns: [],
            isPrimary: indexType === 1,
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
        if (index.columns.length === 1) {
          return new SingleColumnCursorStrategy(index.columns[0], directions[0], physicalColumns[0]);
        }
        return new CompositeKeyCursorStrategy(index.columns, directions, physicalColumns);
      };

      // 1. Primary key (guaranteed unique)
      for (const index of indexes.values()) {
        if (index.isPrimary && index.columns.length > 0) {
          this.cachedStrategy = buildStrategyForIndex(index);
          return this.cachedStrategy;
        }
      }

      // 2. Unique index (prefer single column)
      let singleColumnUniqueIndex: IndexInfo | null = null;
      let multiColumnUniqueIndex: IndexInfo | null = null;

      for (const index of indexes.values()) {
        if (index.isUnique && !index.isPrimary && index.columns.length > 0) {
          if (index.columns.length === 1 && !singleColumnUniqueIndex) {
            singleColumnUniqueIndex = index;
          } else if (index.columns.length > 1 && !multiColumnUniqueIndex) {
            multiColumnUniqueIndex = index;
          }
        }
      }

      if (singleColumnUniqueIndex) {
        this.cachedStrategy = buildStrategyForIndex(singleColumnUniqueIndex);
        return this.cachedStrategy;
      }

      if (multiColumnUniqueIndex) {
        this.cachedStrategy = buildStrategyForIndex(multiColumnUniqueIndex);
        return this.cachedStrategy;
      }

      // 3. Non-unique index alone would skip duplicate rows across batch boundaries; append unique
      // filterTargetKey columns as tie-breakers when available, otherwise fall back to filterTargetKey.
      const tieBreakers = Array.isArray(this.collection.filterTargetKey)
        ? this.collection.filterTargetKey
        : this.collection.filterTargetKey
          ? [this.collection.filterTargetKey]
          : [];

      for (const index of indexes.values()) {
        if (index.columns.length > 0 && !index.isPrimary && !index.isUnique && tieBreakers.length > 0) {
          const combinedCols = [...index.columns];
          const combinedDirs: SortDirection[] = index.columns.map(
            (col) => indexDirections.get(index.name)?.get(col) || 'ASC',
          );
          for (const tb of tieBreakers) {
            const attrTb = this.resolveAttributeName(tb);
            if (!combinedCols.includes(attrTb)) {
              combinedCols.push(attrTb);
              combinedDirs.push('ASC');
            }
          }
          const combinedPhysical = combinedCols.map(
            (col) => attrToPhysical.get(col) ?? this.resolvePhysicalColumnName(col),
          );
          this.cachedStrategy =
            combinedCols.length === 1
              ? new SingleColumnCursorStrategy(combinedCols[0], combinedDirs[0], combinedPhysical[0])
              : new CompositeKeyCursorStrategy(combinedCols, combinedDirs, combinedPhysical);
          return this.cachedStrategy;
        }
      }

      this.cachedStrategy = this.getFallbackStrategy();
      return this.cachedStrategy;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[MssqlSmartCursorBuilder] Error getting index info: ${message}\n`);
      return this.getFallbackStrategy();
    }
  }

  /**
   * Fallback strategy when no index information is available
   */
  private getFallbackStrategy(): CursorStrategy {
    if (Array.isArray(this.collection.filterTargetKey)) {
      const cols = this.collection.filterTargetKey.map((col) => this.resolveAttributeName(col));
      return new CompositeKeyCursorStrategy(
        cols,
        undefined,
        cols.map((col) => this.resolvePhysicalColumnName(col)),
      );
    }
    const attr = this.resolveAttributeName(this.collection.filterTargetKey || 'id');
    return new SingleColumnCursorStrategy(attr, 'ASC', this.resolvePhysicalColumnName(attr));
  }

  /**
   * Cursor-based pagination query function.
   * Honors `options.limit` (e.g. `EXPORT_LIMIT`) as an upper bound across all batches.
   */
  async chunk(options: FindOptions) {
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
        runOptions.where = cursorStrategy.buildWhere(baseWhere, cursorRecord);
      } else {
        runOptions.where = baseWhere;
        isFirst = false;
      }

      runOptions.limit = currentLimit;

      if (options.beforeFind) {
        await options.beforeFind(runOptions);
      }

      const records = await findFn(_.omit(runOptions, 'callback', 'beforeFind', 'afterFind', 'chunkSize', 'find'));

      if (options.afterFind) {
        await options.afterFind(records, runOptions);
      }

      if (records.length === 0) {
        hasMoreData = false;
        continue;
      }

      const batch = remaining !== undefined && records.length > remaining ? records.slice(0, remaining) : records;
      await callbackFn(batch, runOptions);
      totalProcessed += batch.length;

      // Stop when overallLimit is reached or fewer than currentLimit rows were returned.
      if ((overallLimit !== undefined && totalProcessed >= overallLimit) || records.length < currentLimit) {
        hasMoreData = false;
        continue;
      }

      const nextCursor = batch[batch.length - 1] as unknown as CursorRow;
      if (!cursorStrategy.hasCursorValues(nextCursor)) {
        hasMoreData = false;
        continue;
      }
      cursorRecord = nextCursor;
    }
  }
}
