// SPDX-License-Identifier: Apache-2.0

import { Repository, Collection, FindOptions, CountOptions, Model } from '@nocobase/database';
import { Op, QueryTypes, literal } from 'sequelize';
import { MssqlSmartCursorBuilder } from './MssqlSmartCursorBuilder';
import { isPureAscii, quoteAnsiStringLiteral, quoteIdentifier } from '../security/sql-quote';

export interface MssqlRepositoryRuntimeOptions {
  fastCount?: boolean;
  deferredJoinThreshold?: number;
  isAnsiStringColumn?: (tableName: string, columnName: string) => boolean;
  ftsSuspendCount?: number;
}

const DISABLE_FTS_FILTER = Symbol('mssqlDisableFtsFilter');

const DEFAULT_DEFERRED_JOIN_THRESHOLD = 200;
const MAX_DEFERRED_JOIN_LIMIT = 1000;

const SAFE_DEFERRED_JOIN_PK_TYPES = new Set([
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'MEDIUMINT',
  'STRING',
  'CHAR',
  'UUID',
  'UUIDV1',
  'UUIDV4',
  'VARCHAR',
  'NVARCHAR',
  'NCHAR',
]);

interface ModelRawAttributeLike {
  field?: string;
  type?: { key?: string; toString?: () => string };
}

function isSafeDeferredJoinPkType(
  model: { rawAttributes?: Record<string, ModelRawAttributeLike> },
  pkAttr: string,
): boolean {
  const attrType = model.rawAttributes?.[pkAttr]?.type;
  if (!attrType) {
    return true;
  }
  const typeKey = typeof attrType.key === 'string' ? attrType.key.toUpperCase() : '';
  if (typeKey) {
    return SAFE_DEFERRED_JOIN_PK_TYPES.has(typeKey);
  }
  return false;
}

interface DeferredJoinAttributePlan {
  supported: boolean;
  attributes: unknown;
  stripPk: boolean;
}

function prepareDeferredJoinAttributes(attributes: unknown, pkAttr: string): DeferredJoinAttributePlan {
  if (attributes === undefined) {
    return { supported: true, attributes: undefined, stripPk: false };
  }
  if (Array.isArray(attributes)) {
    const includesPk = attributes.some(
      (entry) => entry === pkAttr || (Array.isArray(entry) && entry[entry.length - 1] === pkAttr),
    );
    return includesPk
      ? { supported: true, attributes, stripPk: false }
      : { supported: true, attributes: [...attributes, pkAttr], stripPk: true };
  }
  if (attributes && typeof attributes === 'object') {
    const obj = attributes as { include?: unknown[]; exclude?: unknown[] };
    if (Array.isArray(obj.exclude) && obj.exclude.includes(pkAttr)) {
      return {
        supported: true,
        attributes: {
          ...obj,
          exclude: obj.exclude.filter((col) => col !== pkAttr),
        },
        stripPk: true,
      };
    }
    return { supported: true, attributes, stripPk: false };
  }
  return { supported: false, attributes, stripPk: false };
}

function readHydratedPkValue(row: Model, pkAttr: string): unknown {
  const rowWithDataValue = row as unknown as {
    getDataValue?: (key: string) => unknown;
    [key: string]: unknown;
  };
  if (typeof rowWithDataValue.getDataValue === 'function') {
    const rawVal = rowWithDataValue.getDataValue(pkAttr);
    if (rawVal !== undefined) {
      return rawVal;
    }
  }
  if (typeof row.get === 'function') {
    return row.get(pkAttr);
  }
  return rowWithDataValue[pkAttr];
}

function stripPrimaryKeyFromRow(row: Model, pkAttr: string): void {
  const typedRow = row as unknown as {
    dataValues?: Record<string, unknown>;
    _previousDataValues?: Record<string, unknown>;
  };
  if (typedRow.dataValues && typeof typedRow.dataValues === 'object') {
    delete typedRow.dataValues[pkAttr];
  }
  if (typedRow._previousDataValues && typeof typedRow._previousDataValues === 'object') {
    delete typedRow._previousDataValues[pkAttr];
  }
}

function normalizePkKey(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function hasWhereConditions(where: unknown): boolean {
  return Boolean(
    where &&
      typeof where === 'object' &&
      (Object.keys(where).length > 0 || Object.getOwnPropertySymbols(where).length > 0),
  );
}

function isUnfilteredCount(countOptions?: CountOptions & { where?: unknown; include?: unknown[] }): boolean {
  if (!countOptions) {
    return true;
  }
  const hasFilter = Boolean(countOptions.filter && Object.keys(countOptions.filter).length > 0);
  const hasFilterByTk =
    countOptions.filterByTk !== undefined &&
    countOptions.filterByTk !== null &&
    (!Array.isArray(countOptions.filterByTk) || countOptions.filterByTk.length > 0);
  const hasWhere = Boolean(
    countOptions.where &&
      typeof countOptions.where === 'object' &&
      (Object.keys(countOptions.where).length > 0 || Object.getOwnPropertySymbols(countOptions.where).length > 0),
  );
  const hasInclude = Array.isArray(countOptions.include) && countOptions.include.length > 0;
  return !hasFilter && !hasFilterByTk && !hasWhere && !hasInclude;
}

function isPkOnlyAttributes(attributes: unknown, pkAttr: string): boolean {
  return Array.isArray(attributes) && attributes.length === 1 && attributes[0] === pkAttr;
}

function hasExplicitOrder(options: FindOptions): boolean {
  const order = (options as { order?: unknown }).order;
  if (order) {
    if (!Array.isArray(order) || order.length > 0) {
      return true;
    }
  }
  const sort = options.sort;
  if (typeof sort === 'string') {
    return sort.split(',').some((item) => item.trim().length > 0);
  }
  if (Array.isArray(sort)) {
    return sort.some((item) => typeof item === 'string' && item.trim().length > 0);
  }
  return false;
}

/**
 * Ensures every ORDER BY item refers to a direct column on the root model (not a computed alias
 * in `attributes.include` or an association), so replacing `attributes` with `[pkAttr]` in
 * Deferred Join query 1 cannot break ORDER BY resolution.
 */
function areOrderColumnsDirectAttributes(
  order: unknown,
  model: { rawAttributes?: Record<string, { field?: string }> },
): boolean {
  if (!order) {
    return true;
  }
  if (!Array.isArray(order)) {
    return false;
  }
  const rawAttributes = model.rawAttributes || {};
  const knownFields = new Set<string>(Object.keys(rawAttributes));
  for (const attr of Object.values(rawAttributes)) {
    if (attr?.field) {
      knownFields.add(attr.field);
    }
  }
  for (const item of order) {
    if (typeof item === 'string') {
      if (!knownFields.has(item)) return false;
      continue;
    }
    if (!Array.isArray(item) || item.length === 0 || item.length > 2 || typeof item[0] !== 'string') {
      return false;
    }
    if (!knownFields.has(item[0])) {
      return false;
    }
  }
  return true;
}

/**
 * MSSQL-specific Repository with:
 * - Deferred Join (late row lookup) for deep OFFSET pagination to avoid LOB/Key Lookup amplification
 * - Schema-qualified `sys.partitions` row count estimation (no VIEW DATABASE STATE required)
 * - Optional O(1) `fastCount` for unfiltered counts on large physical tables
 * - Optimized cursor-based `chunkWithCursor()` pagination
 */
export class MssqlRepository<
  TModelAttributes extends {} = Record<string, unknown>,
  TCreationAttributes extends {} = TModelAttributes,
> extends Repository<TModelAttributes, TCreationAttributes> {
  private mssqlCursorBuilder: MssqlSmartCursorBuilder;

  constructor(collection: Collection) {
    super(collection);

    const modelOptions = this.model.options as { schema?: string };
    this.mssqlCursorBuilder = new MssqlSmartCursorBuilder(
      this.database.sequelize,
      this.model.tableName,
      collection,
      modelOptions?.schema || this.database.options?.schema,
    );
  }

  private getRuntimeOptions(): MssqlRepositoryRuntimeOptions {
    const dbOpts = this.database?.options as { mssqlRuntimeOptions?: MssqlRepositoryRuntimeOptions } | undefined;
    return dbOpts?.mssqlRuntimeOptions || {};
  }

  private isPhysicalTable(): boolean {
    const col = this.collection as Collection & { isSql?: () => boolean; isView?: () => boolean };
    if (typeof col.isSql === 'function' && col.isSql()) {
      return false;
    }
    if (typeof col.isView === 'function' && col.isView()) {
      return false;
    }
    return true;
  }

  private async queryPartitionRowCount(): Promise<number | null> {
    if (!this.isPhysicalTable()) {
      return null;
    }
    const tableName = this.collection.tableName();
    const modelOptions = this.model.options as { schema?: string };
    const schema = modelOptions?.schema || this.database.options?.schema || 'dbo';
    const qualifiedName = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
    try {
      const results = (await this.database.sequelize.query(
        `
        SELECT SUM(rows) AS estimate
        FROM sys.partitions
        WHERE object_id = OBJECT_ID(?) AND index_id IN (0, 1)
      `,
        { replacements: [qualifiedName], type: QueryTypes.SELECT },
      )) as Array<{ estimate?: number | string | null }>;
      const estimate = results?.[0]?.estimate;
      return estimate !== undefined && estimate !== null ? Number(estimate) : null;
    } catch {
      return null;
    }
  }

  /**
   * Schema-qualified O(1) estimated row count via `sys.partitions` (works without VIEW DATABASE STATE).
   */
  async getEstimatedRowCount(): Promise<number> {
    return (await this.queryPartitionRowCount()) ?? 0;
  }

  /**
   * Uses instant `sys.partitions` metadata when `fastCount` is enabled and no filter is applied,
   * otherwise runs exact `COUNT(*)`.
   */
  async count(countOptions?: CountOptions): Promise<number> {
    const runtimeOpts = this.getRuntimeOptions();
    if (
      runtimeOpts.fastCount &&
      isUnfilteredCount(countOptions as CountOptions & { where?: unknown; include?: unknown[] })
    ) {
      const estimate = await this.queryPartitionRowCount();
      if (estimate !== null) {
        return estimate;
      }
    }
    return await super.count(countOptions);
  }

  /**
   * Overrides `find()` with Deferred Join (Late Row Lookup) for deep OFFSET queries on tables with
   * a single-column primary key. Instead of reading wide/LOB columns for every skipped OFFSET row,
   * query 1 fetches only the page's primary keys and query 2 fetches full columns for those exact keys.
   */
  async find(options: FindOptions = {}) {
    if (options?.targetCollection && options?.targetCollection !== this.collection.name) {
      return await super.find(options);
    }

    const runtimeOpts = this.getRuntimeOptions();
    const threshold = runtimeOpts.deferredJoinThreshold ?? DEFAULT_DEFERRED_JOIN_THRESHOLD;
    const rawOffset = Number(options.offset ?? 0);
    const rawLimit = options.limit !== undefined ? Number(options.limit) : undefined;
    const model = this.collection.model;
    const distinct = Boolean((options as { distinct?: boolean }).distinct);
    const hasTopLevelHaving = Boolean((options as { having?: unknown }).having);

    const canDeferJoin =
      threshold > 0 &&
      this.isPhysicalTable() &&
      Number.isFinite(rawOffset) &&
      rawOffset >= threshold &&
      rawLimit !== undefined &&
      Number.isFinite(rawLimit) &&
      rawLimit > 0 &&
      rawLimit <= MAX_DEFERRED_JOIN_LIMIT &&
      !options.raw &&
      !options.group &&
      !distinct &&
      !hasTopLevelHaving &&
      model.primaryKeyAttributes.length === 1;

    if (!canDeferJoin) {
      const hasNoPrimaryKey =
        model.primaryKeyField === null ||
        (Array.isArray(model.primaryKeyAttributes) && model.primaryKeyAttributes.length === 0);
      const isPaginated =
        (rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0) ||
        (Number.isFinite(rawOffset) && rawOffset > 0);
      if (hasNoPrimaryKey && isPaginated) {
        const nextOptions: FindOptions & { order?: unknown; include?: unknown } = { ...options };
        if (!hasExplicitOrder(options)) {
          // Sequelize's MSSQL addLimitAndOffset quotes model.primaryKeyField when no ORDER BY is
          // present, throwing TypeError on PK-less tables/views. `(SELECT NULL)` satisfies T-SQL's
          // mandatory ORDER BY for OFFSET/FETCH without sorting or assuming any column type.
          nextOptions.order = [literal('(SELECT NULL)')];
        }
        if (Array.isArray(nextOptions.include) && nextOptions.include.length === 0) {
          delete nextOptions.include;
        }
        return await super.find(nextOptions);
      }
      return await super.find(options);
    }

    const opts = {
      subQuery: false,
      ...this.buildQueryOptions(options),
    };
    if (opts.limit !== undefined) {
      opts.limit = Number(opts.limit);
    }

    const pkAttr = model.primaryKeyAttributes[0];
    const attrPlan = prepareDeferredJoinAttributes(opts.attributes, pkAttr);
    if (
      (opts.include && opts.include.length > 0) ||
      Boolean((opts as { having?: unknown }).having) ||
      isPkOnlyAttributes(opts.attributes, pkAttr) ||
      !attrPlan.supported ||
      !isSafeDeferredJoinPkType(model, pkAttr) ||
      !areOrderColumnsDirectAttributes(opts.order, model)
    ) {
      return await super.find(options);
    }

    const transaction = await this.getTransaction(options);
    const idRows = (await model.findAll({
      ...opts,
      attributes: [pkAttr],
      raw: true,
      transaction,
    })) as unknown as Array<Record<string, unknown>>;

    const pkField = (model.rawAttributes?.[pkAttr] as ModelRawAttributeLike | undefined)?.field;
    const pkValues: unknown[] = [];
    const seenKeys = new Set<string>();
    for (const row of idRows) {
      const rawVal = row[pkAttr] !== undefined ? row[pkAttr] : pkField ? row[pkField] : undefined;
      if (rawVal === undefined || rawVal === null) {
        return await super.find(options);
      }
      const key = normalizePkKey(rawVal);
      if (seenKeys.has(key)) {
        // Non-unique PK values would collapse/repeat rows during map rehydration — fall back safely.
        return await super.find(options);
      }
      seenKeys.add(key);
      pkValues.push(rawVal);
    }

    let rows: Model[] = [];
    if (pkValues.length > 0) {
      const isAnsiPk = Boolean(runtimeOpts.isAnsiStringColumn?.(this.collection.tableName(), pkField || pkAttr));
      const inValues =
        isAnsiPk && pkValues.every((value): value is string => typeof value === 'string' && isPureAscii(value))
          ? pkValues.map((value) => literal(quoteAnsiStringLiteral(value)))
          : pkValues;

      const pkWhere = { [pkAttr]: { [Op.in]: inValues } };
      const hydrateWhere = hasWhereConditions(opts.where) ? { [Op.and]: [opts.where, pkWhere] } : pkWhere;

      const hydrated = (await model.findAll({
        where: hydrateWhere,
        attributes: attrPlan.attributes as FindOptions['attributes'],
        transaction,
      })) as Model[];

      // Re-order hydrated rows to match the exact ORDER BY sequence returned by query 1.
      const byPk = new Map<string, Model>();
      for (const row of hydrated) {
        const key = readHydratedPkValue(row, pkAttr);
        if (key !== undefined && key !== null) {
          byPk.set(normalizePkKey(key), row);
        }
      }
      rows = pkValues.map((pk) => byPk.get(normalizePkKey(pk))).filter((row): row is Model => row !== undefined);
      if (attrPlan.stripPk) {
        for (const row of rows) {
          stripPrimaryKeyFromRow(row, pkAttr);
        }
      }
    }

    await this.collection.db.emitAsync('afterRepositoryFind', {
      findOptions: options,
      dataCollection: this.collection,
      data: rows,
    });

    return rows;
  }

  public buildQueryOptions(options: Record<string, unknown>) {
    if (!options?.[DISABLE_FTS_FILTER]) {
      return super.buildQueryOptions(options);
    }
    const dbOpts = this.database?.options as { mssqlRuntimeOptions?: MssqlRepositoryRuntimeOptions } | undefined;
    const runtimeOpts = dbOpts?.mssqlRuntimeOptions;
    if (runtimeOpts) {
      runtimeOpts.ftsSuspendCount = (runtimeOpts.ftsSuspendCount ?? 0) + 1;
    }
    try {
      return super.buildQueryOptions(options);
    } finally {
      if (runtimeOpts) {
        runtimeOpts.ftsSuspendCount = Math.max(0, (runtimeOpts.ftsSuspendCount ?? 1) - 1);
      }
    }
  }

  /**
   * For collections without a single PK / `filterTargetKey`, core's `Repository.destroy()` passes
   * the parsed filter directly to `model.destroy()` (`DELETE FROM [schema].[table] WHERE ...`,
   * with no `AS [model.name]` alias). Suspend FTS `CONTAINS([alias].[col], ...)` during that
   * filter parse so SQL Server never fails with Msg 4104 when `model.name !== tableName`.
   */
  async destroy(options?: Parameters<Repository<TModelAttributes, TCreationAttributes>['destroy']>[0]) {
    if (
      options &&
      typeof options === 'object' &&
      !Array.isArray(options) &&
      'filter' in options &&
      options.filter &&
      this.collection.model.primaryKeyAttributes.length !== 1 &&
      !this.collection.options?.filterTargetKey
    ) {
      return await super.destroy({
        ...options,
        [DISABLE_FTS_FILTER]: true,
      } as typeof options);
    }
    return await super.destroy(options);
  }

  /**
   * Cursor-based pagination query function optimized for MSSQL.
   * Ideal for large datasets (e.g., millions of rows).
   */
  async chunkWithCursor(
    options: FindOptions & {
      chunkSize: number;
      callback: (rows: Model[], options: FindOptions) => Promise<void>;
      beforeFind?: (options: FindOptions) => Promise<void>;
      afterFind?: (rows: Model[], options: FindOptions) => Promise<void>;
    },
  ) {
    return await this.mssqlCursorBuilder.chunk({
      ...options,
      find: this.find.bind(this),
    });
  }
}
