// SPDX-License-Identifier: Apache-2.0

import { Repository, Collection, FindOptions, CountOptions, Model } from '@nocobase/database';
import { createRequire } from 'module';
import _ from 'lodash';
import { HasOne, type HasOneOptions, Op, QueryTypes, Utils, literal } from 'sequelize';
import { MssqlSmartCursorBuilder, type MssqlChunkOptions } from './MssqlSmartCursorBuilder';
import { isReadOnlyViewCollection, MssqlReadOnlyViewError, type ViewCollectionLike } from './mssql-read-only-view';
import { isPureAscii, quoteAnsiStringLiteral, quoteIdentifier } from '../security/sql-quote';

export interface MssqlRepositoryRuntimeOptions {
  fastCount?: boolean;
  deferredJoinThreshold?: number;
  isAnsiStringColumn?: (tableName: string, columnName: string) => boolean;
  ftsSuspendCount?: number;
  maxUnkeyedBufferRows?: number;
  maxConcurrentStreams?: number;
}

const DISABLE_FTS_FILTER = Symbol('mssqlDisableFtsFilter');
const PREBUILT_QUERY_OPTIONS = Symbol('mssqlPrebuiltQueryOptions');

const DEFAULT_DEFERRED_JOIN_THRESHOLD = 200;
const MAX_DEFERRED_JOIN_LIMIT = 1000;
const DEFAULT_MAX_UNKEYED_BUFFER_ROWS = 10_000;
const DEFAULT_MAX_CONCURRENT_STREAMS = 4;
const KEY_IN_CHUNK_SIZE = 1000;

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
  unique?: unknown;
  type?: { key?: string; toString?: () => string };
}

interface StreamTargetModelLike {
  name: string;
  primaryKeyAttribute?: string;
  primaryKeyField?: string | null;
  primaryKeyAttributes?: string[];
  rawAttributes?: Record<string, ModelRawAttributeLike>;
  associations?: Record<string, StreamAssociationLike>;
  build?: (values?: Record<string, unknown>, options?: Record<string, unknown>) => Model;
  findAll(options: Record<string, unknown>): Promise<Model[]>;
}

interface StreamAssociationLike {
  associationType: string;
  as: string;
  foreignKey: string;
  sourceKey: string;
  targetKey: string;
  otherKey?: string;
  isSingleAssociation?: boolean;
  target: StreamTargetModelLike;
  through?: {
    model: StreamTargetModelLike;
    scope?: Record<string, unknown>;
  };
  oneFromTarget?: { as: string };
  options?: { realAs?: string };
}

interface ChildHydrationBudget {
  count: number;
  max: number;
}

class ChildRowBudgetExceededError extends Error {
  readonly associationName: string;

  constructor(associationName: string, max: number) {
    super(`Related record batch exceeded memory bound (${max}) for association "${associationName}"`);
    this.name = 'ChildRowBudgetExceededError';
    this.associationName = associationName;
  }
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<{ max: number; resolve: (release: () => void) => void }> = [];

  acquire(maxConcurrency: number): Promise<() => void> {
    const limit = Math.max(1, maxConcurrency);
    if (this.active < limit) {
      this.active += 1;
      return Promise.resolve(this.createReleaser());
    }
    return new Promise((resolve) => {
      this.waiters.push({ max: limit, resolve });
    });
  }

  private createReleaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active = Math.max(0, this.active - 1);
      const nextIdx = this.waiters.findIndex((waiter) => this.active < waiter.max);
      if (nextIdx >= 0) {
        const [next] = this.waiters.splice(nextIdx, 1);
        this.active += 1;
        next.resolve(this.createReleaser());
      }
    };
  }
}

const streamSemaphores = new WeakMap<object, AsyncSemaphore>();

function getStreamSemaphore(key: object): AsyncSemaphore {
  let sem = streamSemaphores.get(key);
  if (!sem) {
    sem = new AsyncSemaphore();
    streamSemaphores.set(key, sem);
  }
  return sem;
}

interface IncludeItemLike {
  association: string | StreamAssociationLike;
  fromFilter?: boolean;
  where?: Record<string, unknown>;
  attributes?: unknown;
  options?: { sort?: unknown; [key: string]: unknown };
  include?: IncludeItemLike[];
  required?: boolean;
}

interface TediousColumnLike {
  value: unknown;
  metadata?: {
    colName?: string;
    type?: { id?: number };
  };
}

interface TediousRequestLike {
  on(event: 'row', listener: (columns: unknown) => void): unknown;
  pause?: () => void;
  resume?: () => void;
  cancel?: () => void;
}

interface TediousConnectionLike {
  lib?: {
    Request?: new (sql: string, callback: (err?: Error | null, rowCount?: number) => void) => TediousRequestLike;
  };
  queue?: {
    enqueue?: <T>(fn: () => Promise<T>) => Promise<T>;
  };
  execSql?: (request: TediousRequestLike) => void;
}

interface SequelizeQueryInstanceLike {
  handleSelectQuery(results: Array<Record<string, unknown>>): unknown[];
  formatError?: (err: Error, errStack?: string) => Error;
}

interface SequelizeConnectionConfigLike {
  pool?: { max?: number };
  replication?: { read?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

interface SequelizeStreamInternals {
  getDialect?: () => string;
  config?: SequelizeConnectionConfigLike;
  options?: { pool?: { max?: number } };
  connectionManager?: {
    config?: SequelizeConnectionConfigLike;
    pool?: { _draining?: boolean; read?: { _draining?: boolean } };
    _connect?: (config: Record<string, unknown>) => Promise<unknown>;
    _disconnect?: (connection: unknown) => Promise<void>;
    getConnection?: (options: { type?: string }) => Promise<unknown>;
    releaseConnection?: (connection: unknown) => Promise<void>;
  };
  dialect?: {
    queryGenerator?: {
      selectQuery?: (tableName: unknown, options: Record<string, unknown>, model: unknown) => string;
    };
    Query?: new (
      connection: unknown,
      sequelize: unknown,
      options: Record<string, unknown>,
    ) => SequelizeQueryInstanceLike;
  };
}

interface ModelStreamInternals {
  rawAttributes?: Record<string, ModelRawAttributeLike>;
  associations?: Record<string, StreamAssociationLike>;
  primaryKeyField?: string | null;
  primaryKeyAttributes?: string[];
  getTableName(options: Record<string, unknown>): unknown;
  runHooks?: (hookName: string, ...args: unknown[]) => Promise<void>;
  _injectScope?: (options: Record<string, unknown>) => void;
  _conformIncludes?: (options: Record<string, unknown>, model: unknown) => void;
  _validateIncludedElements?: (options: Record<string, unknown>, tableNames: Record<string, boolean>) => void;
  _expandAttributes?: (options: Record<string, unknown>) => void;
  _expandIncludeAll?: (options: Record<string, unknown>) => void;
  _injectDependentVirtualAttributes?: (attributes: unknown) => unknown;
  _paranoidClause?: (model: unknown, options: Record<string, unknown>) => Record<string, unknown>;
}

function resolveAssociation(
  parentModel: { associations?: Record<string, StreamAssociationLike> },
  inc: IncludeItemLike,
): StreamAssociationLike | undefined {
  return typeof inc.association === 'string' ? parentModel.associations?.[inc.association] : inc.association;
}

function collectReferencedAssociations(value: unknown, refs: Set<string>, literals: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    literals.push(value);
    return;
  }
  if (typeof value === 'object') {
    const valRecord = value as { val?: unknown };
    if (typeof valRecord.val === 'string') {
      literals.push(valRecord.val);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectReferencedAssociations(item, refs, literals);
      }
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') {
        const dollarMatch = key.match(/^\$([^.$]+)\./);
        if (dollarMatch) {
          refs.add(dollarMatch[1]);
        } else if (!key.startsWith('$')) {
          refs.add(key.split('.')[0]);
        }
      }
      collectReferencedAssociations((value as Record<PropertyKey, unknown>)[key], refs, literals);
    }
  }
}

function includeHasFilter(inc: IncludeItemLike): boolean {
  if (inc.where && Object.keys(inc.where).length > 0) {
    return true;
  }
  return Array.isArray(inc.include) && inc.include.some(includeHasFilter);
}

function isAssociationReferencedInWhere(
  assocName: string,
  refs: ReadonlySet<string>,
  literals: readonly string[],
  rawFilterJson: string,
): boolean {
  if (refs.has(assocName) || rawFilterJson.includes(assocName)) {
    return true;
  }
  return literals.some((text) => text.includes(`$${assocName}.`) || text.includes(`[${assocName}].`));
}

function isSafeBelongsToFilterTree(
  includes: IncludeItemLike[],
  parentModel: { associations?: Record<string, StreamAssociationLike> },
): boolean {
  for (const inc of includes) {
    const assoc = resolveAssociation(parentModel, inc);
    if (!assoc || assoc.associationType !== 'BelongsTo') {
      return false;
    }
    const target = assoc.target;
    const isUniqueTargetKey =
      (target.primaryKeyAttributes?.length === 1 && target.primaryKeyAttribute === assoc.targetKey) ||
      Boolean(target.rawAttributes?.[assoc.targetKey]?.unique);
    if (!isUniqueTargetKey) {
      return false;
    }
    if (Array.isArray(inc.include) && inc.include.length > 0 && !isSafeBelongsToFilterTree(inc.include, target)) {
      return false;
    }
  }
  return true;
}

function stripFilterIncludeAttributes(includes: IncludeItemLike[]): IncludeItemLike[] {
  return includes.map((inc) => ({
    ...inc,
    attributes: [],
    ...(Array.isArray(inc.include) && inc.include.length > 0
      ? { include: stripFilterIncludeAttributes(inc.include) }
      : {}),
  }));
}

function ensureAttributesContainKeys(attributes: unknown, keys: string[]): { attributes: unknown; injected: string[] } {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (!uniqueKeys.length || attributes === undefined) {
    return { attributes, injected: [] };
  }
  if (Array.isArray(attributes)) {
    const next = [...attributes];
    const injected: string[] = [];
    for (const key of uniqueKeys) {
      if (!hasAttributeName(next, key)) {
        next.push(key);
        injected.push(key);
      }
    }
    return { attributes: next, injected };
  }
  if (attributes && typeof attributes === 'object') {
    const attrObj = attributes as { include?: unknown[]; exclude?: unknown[] };
    if (Array.isArray(attrObj.exclude)) {
      const injected: string[] = [];
      const nextExclude = attrObj.exclude.filter((entry) => {
        if (typeof entry === 'string' && uniqueKeys.includes(entry)) {
          injected.push(entry);
          return false;
        }
        return true;
      });
      if (injected.length > 0) {
        return { attributes: { ...attrObj, exclude: nextExclude }, injected };
      }
    }
  }
  return { attributes, injected: [] };
}

function hasAttributeName(attributes: unknown[], name: string): boolean {
  return attributes.some((entry) => {
    if (typeof entry === 'string') {
      return entry === name;
    }
    if (Array.isArray(entry)) {
      return entry[1] === name || entry[0] === name;
    }
    return false;
  });
}

function requiredParentKeysForIncludes(
  includes: IncludeItemLike[],
  parentModel: { associations?: Record<string, StreamAssociationLike> },
): string[] | null {
  const keys: string[] = [];
  for (const inc of includes) {
    const assoc = resolveAssociation(parentModel, inc);
    if (!assoc) {
      return null;
    }
    if (assoc.associationType === 'BelongsTo' || assoc.associationType === 'BelongsToArray') {
      keys.push(assoc.foreignKey);
    } else if (
      assoc.associationType === 'HasOne' ||
      assoc.associationType === 'HasMany' ||
      assoc.associationType === 'BelongsToMany'
    ) {
      keys.push(assoc.sourceKey);
    } else {
      return null;
    }
    if (
      Array.isArray(inc.include) &&
      inc.include.length > 0 &&
      requiredParentKeysForIncludes(inc.include, assoc.target) === null
    ) {
      return null;
    }
  }
  return keys;
}

function hasRecursiveInclude(includes: IncludeItemLike[]): boolean {
  for (const inc of includes) {
    if (Boolean(inc.options?.recursively) || Boolean((inc as { recursively?: unknown }).recursively)) {
      return true;
    }
    if (Array.isArray(inc.include) && inc.include.length > 0 && hasRecursiveInclude(inc.include)) {
      return true;
    }
  }
  return false;
}

function stripInjectedInstanceAttrs(instances: Model[], injectedAttrs: string[]): void {
  if (!injectedAttrs.length || !instances.length) {
    return;
  }
  for (const instance of instances) {
    const typed = instance as unknown as {
      dataValues?: Record<string, unknown>;
      _previousDataValues?: Record<string, unknown>;
      [key: string]: unknown;
    };
    for (const attr of injectedAttrs) {
      if (typed.dataValues) {
        delete typed.dataValues[attr];
      }
      if (typed._previousDataValues) {
        delete typed._previousDataValues[attr];
      }
      delete typed[attr];
    }
  }
}

function chunkKeys<T>(keys: T[], size = KEY_IN_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < keys.length; i += size) {
    chunks.push(keys.slice(i, i + size));
  }
  return chunks;
}

function resolveBoundedOrder(targetModel: StreamTargetModelLike, explicitOrder: unknown): unknown {
  if (explicitOrder !== undefined) {
    return explicitOrder;
  }
  const pkAttrs = Array.isArray(targetModel.primaryKeyAttributes)
    ? targetModel.primaryKeyAttributes.filter((pk) => Boolean(targetModel.rawAttributes?.[pk]?.type))
    : [];
  if (pkAttrs.length > 0) {
    return pkAttrs.map((pk) => [pk, 'ASC']);
  }
  if (targetModel.primaryKeyAttribute && targetModel.rawAttributes?.[targetModel.primaryKeyAttribute]?.type) {
    return [[targetModel.primaryKeyAttribute, 'ASC']];
  }
  return [literal('(SELECT NULL)')];
}

function hasWhereCondition(whereClause: Record<string, unknown> | undefined): boolean {
  return Boolean(whereClause && Reflect.ownKeys(whereClause).length > 0);
}

async function findAllWithinBudget(
  targetModel: StreamTargetModelLike,
  queryOptions: Record<string, unknown>,
  budget: ChildHydrationBudget,
  associationName: string,
): Promise<Model[]> {
  const remaining = budget.max - budget.count;
  if (remaining < 0) {
    throw new ChildRowBudgetExceededError(associationName, budget.max);
  }
  const rows = await targetModel.findAll({
    ...queryOptions,
    limit: remaining + 1,
    order: resolveBoundedOrder(targetModel, queryOptions.order),
  });
  if (rows.length > remaining) {
    throw new ChildRowBudgetExceededError(associationName, budget.max);
  }
  budget.count += rows.length;
  return rows;
}

function clearAttachedIncludes(
  instances: Model[],
  includes: IncludeItemLike[],
  parentModel: { associations?: Record<string, StreamAssociationLike> },
): void {
  if (!instances.length || !includes.length) {
    return;
  }
  for (const inc of includes) {
    const assoc = resolveAssociation(parentModel, inc);
    if (!assoc) {
      continue;
    }
    const keys = [
      assoc.as,
      ...(assoc.options?.realAs && assoc.options.realAs !== assoc.as ? [assoc.options.realAs] : []),
    ];
    for (const instance of instances) {
      const typed = instance as unknown as {
        dataValues?: Record<string, unknown>;
        [key: string]: unknown;
      };
      for (const key of keys) {
        if (typed.dataValues) {
          delete typed.dataValues[key];
        }
        delete typed[key];
      }
    }
  }
}

function cloneHydratedModelInstance(
  targetModel: StreamTargetModelLike,
  template: Model,
  childIncludeKeys: string[],
): Model {
  const cloned =
    typeof targetModel.build === 'function'
      ? targetModel.build({ ...template.dataValues }, { isNewRecord: false, raw: true })
      : (Object.assign(Object.create(Object.getPrototypeOf(template)), template, {
          dataValues: { ...template.dataValues },
        }) as Model);
  const typedClone = cloned as unknown as { dataValues: Record<string, unknown>; [key: string]: unknown };
  const typedTemplate = template as unknown as { dataValues: Record<string, unknown>; [key: string]: unknown };
  for (const key of childIncludeKeys) {
    if (key && key in typedTemplate.dataValues) {
      const value = typedTemplate.dataValues[key];
      if (typeof cloned.setDataValue === 'function') {
        cloned.setDataValue(key, value);
      } else {
        typedClone.dataValues[key] = value;
      }
      typedClone[key] = value;
    }
  }
  return cloned;
}

type MssqlParserStore = {
  get?: (typeId: number) => ((value: unknown) => unknown) | undefined;
};

function loadMssqlParserStore(): ((dialect: string) => MssqlParserStore) | null {
  try {
    const req = createRequire(typeof __filename === 'string' ? __filename : `${process.cwd()}/package.json`);
    return req('sequelize/lib/dialects/parserStore') as (dialect: string) => MssqlParserStore;
  } catch {
    return null;
  }
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

  private assertWritableView(options?: unknown): void {
    const targetName =
      options && typeof options === 'object' && 'targetCollection' in options
        ? (options as { targetCollection?: unknown }).targetCollection
        : undefined;
    const targetCollection =
      typeof targetName === 'string' &&
      targetName !== this.collection.name &&
      typeof this.database?.getCollection === 'function'
        ? this.database.getCollection(targetName)
        : this.collection;
    if (isReadOnlyViewCollection(targetCollection as ViewCollectionLike)) {
      throw new MssqlReadOnlyViewError();
    }
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
    if (options?.[PREBUILT_QUERY_OPTIONS]) {
      return options[PREBUILT_QUERY_OPTIONS] as ReturnType<Repository['buildQueryOptions']>;
    }
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

  async create(options: Parameters<Repository<TModelAttributes, TCreationAttributes>['create']>[0]) {
    this.assertWritableView(options);
    return await super.create(options);
  }

  async createMany(options: Parameters<Repository<TModelAttributes, TCreationAttributes>['createMany']>[0]) {
    this.assertWritableView(options);
    return await super.createMany(options);
  }

  async update(options: Parameters<Repository<TModelAttributes, TCreationAttributes>['update']>[0]) {
    this.assertWritableView(options);
    return await super.update(options);
  }

  async updateMany(options: Parameters<Repository<TModelAttributes, TCreationAttributes>['updateMany']>[0]) {
    this.assertWritableView(options);
    return await super.updateMany(options);
  }

  async firstOrCreate(options: Parameters<Repository<TModelAttributes, TCreationAttributes>['firstOrCreate']>[0]) {
    this.assertWritableView(options);
    return await super.firstOrCreate(options);
  }

  async updateOrCreate(options: Parameters<Repository<TModelAttributes, TCreationAttributes>['updateOrCreate']>[0]) {
    this.assertWritableView(options);
    return await super.updateOrCreate(options);
  }

  /**
   * For collections without a single PK / `filterTargetKey`, core's `Repository.destroy()` passes
   * the parsed filter directly to `model.destroy()` (`DELETE FROM [schema].[table] WHERE ...`,
   * with no `AS [model.name]` alias). Suspend FTS `CONTAINS([alias].[col], ...)` during that
   * filter parse so SQL Server never fails with Msg 4104 when `model.name !== tableName`.
   */
  async destroy(options?: Parameters<Repository<TModelAttributes, TCreationAttributes>['destroy']>[0]) {
    this.assertWritableView(options);
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
   * Overrides `chunk()` so tables/views without a guaranteed-unique key never use multi-query
   * OFFSET pagination across separate SQL Server scans (even below the 200k cursor threshold).
   */
  async chunk(options: Parameters<Repository<TModelAttributes, TCreationAttributes>['chunk']>[0]): Promise<void> {
    const strategy = await this.mssqlCursorBuilder.getBestCursorStrategy();
    if (!strategy || this.collection.model.primaryKeyAttributes.length === 0) {
      if (!strategy || !hasExplicitOrder(options as unknown as FindOptions)) {
        await this.chunkWithCursor(options);
        return;
      }
      await this.runSingleQueryChunks(options);
      return;
    }
    return await super.chunk(options);
  }

  /**
   * Cursor-based pagination query function optimized for MSSQL.
   * Falls back to single-query tedious streaming when no guaranteed-unique index exists.
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
      stream: (singleQueryOptions, onBatch) => this.streamSingleQuery(singleQueryOptions, options, onBatch),
    } as MssqlChunkOptions);
  }

  private async runSingleQueryChunks(
    options: Parameters<Repository<TModelAttributes, TCreationAttributes>['chunk']>[0],
  ): Promise<void> {
    const overallLimit = options.limit !== undefined && options.limit !== null ? Number(options.limit) : undefined;
    if (overallLimit !== undefined && (!Number.isFinite(overallLimit) || overallLimit <= 0)) {
      return;
    }
    const singleQueryOptions = _.omit(
      options as unknown as Record<string, unknown>,
      'callback',
      'beforeFind',
      'afterFind',
      'chunkSize',
      'find',
      'stream',
      'offset',
    ) as FindOptions;
    if (overallLimit !== undefined) {
      singleQueryOptions.limit = overallLimit;
    } else {
      delete singleQueryOptions.limit;
    }
    delete singleQueryOptions.offset;

    let firstBatch = true;
    if (options.beforeFind) {
      await options.beforeFind(singleQueryOptions);
    }
    await this.streamSingleQuery(singleQueryOptions, options, async (batch, batchOpts) => {
      if (!firstBatch && options.beforeFind) {
        await options.beforeFind(batchOpts);
      }
      firstBatch = false;
      if (options.afterFind) {
        await options.afterFind(batch, { ...batchOpts, offset: 0 } as FindOptions & { offset: number });
      }
      if (batch.length > 0) {
        await options.callback(batch, batchOpts);
      }
    });
  }

  private async streamSingleQuery(
    singleQueryOptions: FindOptions,
    rawOptions: FindOptions & {
      chunkSize?: number;
      afterFind?: (rows: Model[], options: FindOptions) => Promise<void>;
    },
    onBatch: (rows: Model[], queryOptions: FindOptions) => Promise<void>,
  ): Promise<void> {
    const chunkSize = rawOptions.chunkSize || 1000;
    const rawLimit = singleQueryOptions.limit !== undefined ? Number(singleQueryOptions.limit) : undefined;
    const overallLimit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

    const runtimeOpts = (this.collection.db.options as { mssqlRuntimeOptions?: MssqlRepositoryRuntimeOptions })
      ?.mssqlRuntimeOptions;
    const maxBufferRows =
      typeof runtimeOpts?.maxUnkeyedBufferRows === 'number' &&
      Number.isFinite(runtimeOpts.maxUnkeyedBufferRows) &&
      runtimeOpts.maxUnkeyedBufferRows > 0
        ? Math.floor(runtimeOpts.maxUnkeyedBufferRows)
        : DEFAULT_MAX_UNKEYED_BUFFER_ROWS;

    const opts = {
      subQuery: false,
      ...this.buildQueryOptions(singleQueryOptions),
    } as Record<string, unknown>;
    const model = this.collection.model as unknown as ModelStreamInternals;
    const rawIncludes = Array.isArray(opts.include) ? (opts.include as IncludeItemLike[]) : [];
    const whereRefs = new Set<string>();
    const whereLiterals: string[] = [];
    collectReferencedAssociations(opts.where, whereRefs, whereLiterals);
    const rawFilterJson = singleQueryOptions.filter ? JSON.stringify(singleQueryOptions.filter) || '' : '';

    const filterIncludes = rawIncludes.filter(
      (inc) =>
        Boolean(inc.fromFilter) ||
        includeHasFilter(inc) ||
        (typeof inc.association === 'string' &&
          isAssociationReferencedInWhere(inc.association, whereRefs, whereLiterals, rawFilterJson)),
    );
    const appendIncludes = rawIncludes.filter((inc) => !inc.fromFilter);
    const requiredRootKeys = requiredParentKeysForIncludes(appendIncludes, model);
    let hydrateSliceSize = chunkSize;

    const deliverHydratedWindow = async (
      window: Model[],
      activeInjectedRootAttrs: string[],
      transaction?: unknown,
    ): Promise<void> => {
      const budget: ChildHydrationBudget = { count: 0, max: maxBufferRows };
      try {
        await this.hydrateStreamedBatchIncludes(model, window, appendIncludes, budget, transaction);
      } catch (err) {
        clearAttachedIncludes(window, appendIncludes, model);
        if (err instanceof ChildRowBudgetExceededError) {
          if (window.length <= 1) {
            throw new Error(
              `Cannot buffer more than ${maxBufferRows} related records in memory for a single "${this.collection.name}" record (association "${err.associationName}")`,
            );
          }
          const mid = Math.floor(window.length / 2);
          hydrateSliceSize = Math.min(hydrateSliceSize, mid);
          await deliverHydratedWindow(window.slice(0, mid), activeInjectedRootAttrs, transaction);
          await deliverHydratedWindow(window.slice(mid), activeInjectedRootAttrs, transaction);
          return;
        }
        throw err;
      }

      stripInjectedInstanceAttrs(window, activeInjectedRootAttrs);
      await this.collection.db.emitAsync('afterRepositoryFind', {
        findOptions: rawOptions,
        dataCollection: this.collection,
        data: window,
      });
      await onBatch(window, singleQueryOptions);
    };

    const fallbackToSingleFind = async () => {
      if (overallLimit === undefined || overallLimit > maxBufferRows) {
        throw new Error(
          `Cannot buffer unbounded or large result sets (limit=${
            overallLimit ?? 'unlimited'
          }, max=${maxBufferRows}) in memory for collection "${
            this.collection.name
          }" without a unique key when streaming is unavailable`,
        );
      }
      if (appendIncludes.length === 0) {
        const records = await this.find(singleQueryOptions);
        const bounded = records.length > overallLimit ? records.slice(0, overallLimit) : records;
        if (bounded.length === 0) {
          await onBatch([], singleQueryOptions);
          return;
        }
        for (let idx = 0; idx < bounded.length; idx += chunkSize) {
          await onBatch(bounded.slice(idx, idx + chunkSize), singleQueryOptions);
        }
        return;
      }

      if (requiredRootKeys === null || hasRecursiveInclude(appendIncludes)) {
        throw new Error(
          `Cannot buffer unbounded related records in memory for collection "${this.collection.name}" without a unique key when streaming is unavailable`,
        );
      }

      const transaction = await this.getTransaction(singleQueryOptions);
      const rootOpts = Utils.cloneDeep(opts) as Record<string, unknown>;
      rootOpts.limit = overallLimit;
      delete rootOpts.offset;

      let fallbackInjectedAttrs: string[] = [];
      if (requiredRootKeys.length > 0 && rootOpts.attributes !== undefined) {
        const attrPlan = ensureAttributesContainKeys(rootOpts.attributes, requiredRootKeys);
        rootOpts.attributes = attrPlan.attributes;
        fallbackInjectedAttrs = attrPlan.injected;
      }

      const hasNoPk =
        model.primaryKeyField === null ||
        (Array.isArray(model.primaryKeyAttributes) && model.primaryKeyAttributes.length === 0);
      if (hasNoPk && !hasExplicitOrder(rootOpts as FindOptions)) {
        rootOpts.order = [literal('(SELECT NULL)')];
      }

      let records: Model[];
      if (filterIncludes.length === 0) {
        delete rootOpts.include;
        if (rootOpts.where && Array.isArray(model.primaryKeyAttributes) && model.primaryKeyAttributes.length === 0) {
          rootOpts.where = Utils.mapWhereFieldNames(rootOpts.where as Record<string, unknown>, model as never);
        }
        records = await this.collection.model.findAll({
          ...(rootOpts as FindOptions),
          ...(transaction ? { transaction } : {}),
        });
      } else if (isSafeBelongsToFilterTree(filterIncludes, model)) {
        rootOpts.include = stripFilterIncludeAttributes(filterIncludes);
        rootOpts.subQuery = false;
        if (rootOpts.where && Array.isArray(model.primaryKeyAttributes) && model.primaryKeyAttributes.length === 0) {
          rootOpts.where = Utils.mapWhereFieldNames(rootOpts.where as Record<string, unknown>, model as never);
        }
        records = await this.collection.model.findAll({
          ...(rootOpts as FindOptions),
          ...(transaction ? { transaction } : {}),
        });
      } else {
        rootOpts.include = filterIncludes.map((inc) => ({ ...inc, attributes: [], fromFilter: true }));
        records = await super.find({
          ...(transaction ? { transaction } : {}),
          ...(singleQueryOptions.context ? { context: singleQueryOptions.context } : {}),
          [PREBUILT_QUERY_OPTIONS]: rootOpts,
        } as FindOptions);
      }

      const bounded = records.length > overallLimit ? records.slice(0, overallLimit) : records;
      if (bounded.length === 0) {
        await onBatch([], singleQueryOptions);
        return;
      }
      const queue = [...bounded];
      while (queue.length > 0) {
        const step = Math.max(1, Math.min(hydrateSliceSize, queue.length));
        const window = queue.splice(0, step);
        await deliverHydratedWindow(window, fallbackInjectedAttrs, transaction);
      }
    };

    const sequelize = this.database.sequelize as unknown as SequelizeStreamInternals;
    if (
      typeof sequelize?.getDialect !== 'function' ||
      sequelize.getDialect() !== 'mssql' ||
      Object.prototype.hasOwnProperty.call(sequelize, 'query') ||
      singleQueryOptions.transaction ||
      'replacements' in singleQueryOptions ||
      'bind' in singleQueryOptions
    ) {
      await fallbackToSingleFind();
      return;
    }

    if (Boolean(opts.group) || Boolean(opts.having) || Boolean(opts.distinct)) {
      await fallbackToSingleFind();
      return;
    }

    if (filterIncludes.length > 0 && !isSafeBelongsToFilterTree(filterIncludes, model)) {
      await fallbackToSingleFind();
      return;
    }

    if (requiredRootKeys === null || hasRecursiveInclude(appendIncludes)) {
      await fallbackToSingleFind();
      return;
    }

    const connectionManager = sequelize.connectionManager;
    const queryGenerator = sequelize.dialect?.queryGenerator;
    const QueryCtor = sequelize.dialect?.Query;
    const isDraining = Boolean(connectionManager?.pool?._draining || connectionManager?.pool?.read?._draining);
    const hasOwnGetConnection = Boolean(
      connectionManager && Object.prototype.hasOwnProperty.call(connectionManager, 'getConnection'),
    );
    const hasOwnPrivateConnect = Boolean(
      connectionManager && Object.prototype.hasOwnProperty.call(connectionManager, '_connect'),
    );
    const canUseDedicatedConnect =
      !isDraining &&
      typeof connectionManager?._connect === 'function' &&
      typeof connectionManager?._disconnect === 'function' &&
      (!hasOwnGetConnection || hasOwnPrivateConnect);
    const canUsePooledConnect =
      typeof connectionManager?.getConnection === 'function' &&
      typeof connectionManager?.releaseConnection === 'function';
    if (
      (!canUseDedicatedConnect && !canUsePooledConnect) ||
      typeof queryGenerator?.selectQuery !== 'function' ||
      typeof QueryCtor !== 'function'
    ) {
      await fallbackToSingleFind();
      return;
    }

    const prepared = Utils.cloneDeep(opts) as Record<string, unknown>;
    _.defaults(prepared, { hooks: true });
    if (overallLimit !== undefined) {
      prepared.limit = overallLimit;
    } else {
      delete prepared.limit;
    }
    delete prepared.offset;

    let injectedRootAttrs: string[] = [];
    if (requiredRootKeys.length > 0 && prepared.attributes !== undefined) {
      const attrPlan = ensureAttributesContainKeys(prepared.attributes, requiredRootKeys);
      prepared.attributes = attrPlan.attributes;
      injectedRootAttrs = attrPlan.injected;
    }

    if (filterIncludes.length > 0) {
      prepared.include = stripFilterIncludeAttributes(filterIncludes);
      prepared.hasJoin = true;
    } else {
      delete prepared.include;
    }

    const hasNoPrimaryKey =
      model.primaryKeyField === null ||
      (Array.isArray(model.primaryKeyAttributes) && model.primaryKeyAttributes.length === 0);
    if (hasNoPrimaryKey && prepared.limit !== undefined && !hasExplicitOrder(prepared as FindOptions)) {
      prepared.order = [literal('(SELECT NULL)')];
    }

    model._injectScope?.(prepared);
    if (prepared.hooks && typeof model.runHooks === 'function') {
      await model.runHooks('beforeFind', prepared);
    }
    model._conformIncludes?.(prepared, model);
    model._expandAttributes?.(prepared);
    model._expandIncludeAll?.(prepared);
    if (prepared.hooks && typeof model.runHooks === 'function') {
      await model.runHooks('beforeFindAfterExpandIncludeAll', prepared);
    }
    prepared.originalAttributes = model._injectDependentVirtualAttributes
      ? model._injectDependentVirtualAttributes(prepared.attributes)
      : prepared.attributes;
    if (Array.isArray(prepared.include) && prepared.include.length > 0) {
      const tableNames = { [String(model.getTableName(prepared))]: true };
      model._validateIncludedElements?.(prepared, tableNames);
    }
    if (!prepared.attributes) {
      prepared.attributes = Object.keys(model.rawAttributes || {});
      prepared.originalAttributes = model._injectDependentVirtualAttributes
        ? model._injectDependentVirtualAttributes(prepared.attributes)
        : prepared.attributes;
    }
    if (requiredRootKeys.length > 0 && prepared.attributes !== undefined) {
      const attrPlan = ensureAttributesContainKeys(prepared.attributes, requiredRootKeys);
      prepared.attributes = attrPlan.attributes;
      if (attrPlan.injected.length > 0) {
        injectedRootAttrs = [...new Set([...injectedRootAttrs, ...attrPlan.injected])];
        prepared.originalAttributes = model._injectDependentVirtualAttributes
          ? model._injectDependentVirtualAttributes(prepared.attributes)
          : prepared.attributes;
      }
    }
    if (prepared.where && Array.isArray(model.primaryKeyAttributes) && model.primaryKeyAttributes.length === 0) {
      prepared.where = Utils.mapWhereFieldNames(prepared.where as Record<string, unknown>, model as never);
    }
    Utils.mapFinderOptions(prepared, model as never);
    const selectOptions = (
      typeof model._paranoidClause === 'function' ? model._paranoidClause(model, prepared) : prepared
    ) as Record<string, unknown>;
    if (selectOptions.hooks && typeof model.runHooks === 'function') {
      await model.runHooks('beforeFindAfterOptions', selectOptions);
    }
    selectOptions.type = QueryTypes.SELECT;
    selectOptions.model = model;

    const sql = queryGenerator.selectQuery(model.getTableName(selectOptions), selectOptions, model);

    const rawPoolMax = Number(
      connectionManager?.config?.pool?.max ?? sequelize.options?.pool?.max ?? sequelize.config?.pool?.max ?? 5,
    );
    const poolMax = Number.isFinite(rawPoolMax) && rawPoolMax > 0 ? Math.floor(rawPoolMax) : 5;
    const configuredMaxStreams =
      typeof runtimeOpts?.maxConcurrentStreams === 'number' &&
      Number.isFinite(runtimeOpts.maxConcurrentStreams) &&
      runtimeOpts.maxConcurrentStreams > 0
        ? Math.floor(runtimeOpts.maxConcurrentStreams)
        : Math.max(1, Math.min(DEFAULT_MAX_CONCURRENT_STREAMS, poolMax));
    const maxStreams = canUseDedicatedConnect
      ? configuredMaxStreams
      : poolMax > 1
        ? Math.min(configuredMaxStreams, poolMax - 1)
        : 1;

    const releasePermit = await getStreamSemaphore(sequelize as object).acquire(maxStreams);
    let connection: (TediousConnectionLike & { queryType?: string }) | undefined;
    let usingDedicatedConnection = false;
    let shouldFallbackToSingleFind = false;

    const releaseStreamConnection = async () => {
      if (!connection) {
        return;
      }
      const target = connection;
      connection = undefined;
      if (usingDedicatedConnection) {
        await connectionManager?._disconnect?.(target).catch(() => undefined);
      } else {
        await connectionManager?.releaseConnection?.(target).catch(() => undefined);
      }
    };

    try {
      if (canUseDedicatedConnect && connectionManager?._connect) {
        const cmConfig = connectionManager.config ?? sequelize.config ?? {};
        const readConfigs = Array.isArray(cmConfig.replication?.read) ? cmConfig.replication.read : null;
        const connectConfig = readConfigs && readConfigs.length > 0 ? readConfigs[0] : cmConfig;
        connection = (await connectionManager._connect(connectConfig)) as TediousConnectionLike & {
          queryType?: string;
        };
        if (readConfigs && readConfigs.length > 0) {
          connection.queryType = 'read';
        }
        usingDedicatedConnection = true;
      } else if (connectionManager?.getConnection) {
        connection = (await connectionManager.getConnection({ type: 'SELECT' })) as TediousConnectionLike & {
          queryType?: string;
        };
      }

      const RequestCtor = connection?.lib?.Request;
      const execSql = connection?.execSql?.bind(connection);
      if (!connection || !RequestCtor || !execSql) {
        shouldFallbackToSingleFind = true;
      } else {
        const activeConnection = connection;
        const parserStoreFactory = loadMssqlParserStore();
        const parserStore = parserStoreFactory?.('mssql');
        const hydrateOptions =
          filterIncludes.length > 0 ? { ...selectOptions, hasJoin: false, include: undefined } : selectOptions;
        const sequelizeQuery = new QueryCtor(activeConnection, sequelize, hydrateOptions);

        const streamOnConnection = async () => {
          const rawBuffer: Array<Record<string, unknown>> = [];
          let totalEnqueued = 0;
          let totalDelivered = 0;
          let requestCompleted = false;
          let requestError: Error | null = null;
          let abortReason: 'limit_reached' | 'consumer_error' | null = null;
          let notifyConsumer: (() => void) | null = null;
          let resolveCompletion: () => void = () => undefined;

          const wakeConsumer = () => {
            const fn = notifyConsumer;
            notifyConsumer = null;
            fn?.();
          };

          const completionPromise = new Promise<void>((resolve) => {
            resolveCompletion = resolve;
          });

          const request = new RequestCtor(sql, (err?: Error | null) => {
            if (err && abortReason === null) {
              requestError = err;
            }
            requestCompleted = true;
            wakeConsumer();
            resolveCompletion();
          });

          const getNeededCount = () =>
            overallLimit !== undefined ? Math.min(chunkSize, Math.max(1, overallLimit - totalDelivered)) : chunkSize;

          request.on('row', (columns: unknown) => {
            if (abortReason !== null) {
              return;
            }
            const row: Record<string, unknown> = {};
            const colList = Array.isArray(columns)
              ? (columns as TediousColumnLike[])
              : Object.values((columns || {}) as Record<string, TediousColumnLike>);
            for (const col of colList) {
              const colName = col?.metadata?.colName;
              if (!colName) {
                continue;
              }
              const typeId = col.metadata?.type?.id;
              const parser = typeId !== undefined ? parserStore?.get?.(typeId) : undefined;
              let value = col.value;
              if (value !== null && value !== undefined && parser) {
                value = parser(value);
              }
              row[colName] = value;
            }
            rawBuffer.push(row);
            totalEnqueued += 1;

            if (rawBuffer.length >= getNeededCount() || (overallLimit !== undefined && totalEnqueued >= overallLimit)) {
              request.pause?.();
              wakeConsumer();
            }
          });

          execSql(request);

          const waitForSignal = () =>
            new Promise<void>((resolve) => {
              if (
                rawBuffer.length >= getNeededCount() ||
                requestCompleted ||
                (rawBuffer.length > 0 && abortReason !== null)
              ) {
                resolve();
                return;
              }
              notifyConsumer = resolve;
            });

          const deliverBatch = async (rawRows: Array<Record<string, unknown>>) => {
            const batch = sequelizeQuery.handleSelectQuery(rawRows) as Model[];
            if (selectOptions.hooks && typeof model.runHooks === 'function') {
              await model.runHooks('afterFind', batch, selectOptions);
            }
            if (appendIncludes.length === 0 || batch.length === 0) {
              stripInjectedInstanceAttrs(batch, injectedRootAttrs);
              await this.collection.db.emitAsync('afterRepositoryFind', {
                findOptions: rawOptions,
                dataCollection: this.collection,
                data: batch,
              });
              await onBatch(batch, singleQueryOptions);
              return;
            }

            while (batch.length > 0) {
              const step = Math.max(1, Math.min(hydrateSliceSize, batch.length));
              const window = batch.splice(0, step);
              await deliverHydratedWindow(window, injectedRootAttrs);
            }
          };

          try {
            let streaming = true;
            while (streaming) {
              await waitForSignal();
              while (rawBuffer.length > 0) {
                const remaining = overallLimit !== undefined ? overallLimit - totalDelivered : undefined;
                if (remaining !== undefined && remaining <= 0) {
                  streaming = false;
                  break;
                }
                const take = remaining !== undefined ? Math.min(chunkSize, remaining) : chunkSize;
                if (!requestCompleted && rawBuffer.length < take) {
                  break;
                }
                const slice = rawBuffer.splice(0, take);
                await deliverBatch(slice);
                totalDelivered += slice.length;
                if (overallLimit !== undefined && totalDelivered >= overallLimit) {
                  streaming = false;
                  break;
                }
                if (!requestCompleted && rawBuffer.length < getNeededCount()) {
                  request.resume?.();
                }
              }
              if (streaming && requestCompleted && rawBuffer.length === 0) {
                streaming = false;
              }
            }
            if (overallLimit !== undefined && totalDelivered >= overallLimit && !requestCompleted) {
              abortReason = 'limit_reached';
              request.cancel?.();
            }
          } catch (err) {
            abortReason = 'consumer_error';
            if (!requestCompleted) {
              request.cancel?.();
            }
            await completionPromise;
            throw err;
          }

          await completionPromise;
          if (requestError) {
            throw typeof sequelizeQuery.formatError === 'function'
              ? sequelizeQuery.formatError(requestError)
              : requestError;
          }
          if (totalDelivered === 0) {
            await onBatch([], singleQueryOptions);
          }
        };

        if (activeConnection.queue && typeof activeConnection.queue.enqueue === 'function') {
          await activeConnection.queue.enqueue(streamOnConnection);
        } else {
          await streamOnConnection();
        }
      }
    } finally {
      await releaseStreamConnection();
      releasePermit();
    }

    if (shouldFallbackToSingleFind) {
      await fallbackToSingleFind();
    }
  }

  private async hydrateStreamedBatchIncludes(
    parentModel: { associations?: Record<string, StreamAssociationLike> },
    parentInstances: Model[],
    includes: IncludeItemLike[],
    budget: ChildHydrationBudget,
    transaction?: unknown,
  ): Promise<void> {
    if (!parentInstances.length || !includes.length) {
      return;
    }

    for (const inc of includes) {
      const assoc = resolveAssociation(parentModel, inc);
      if (!assoc) {
        continue;
      }

      const childIncludes = Array.isArray(inc.include) ? inc.include : [];
      const nestedRequired = requiredParentKeysForIncludes(childIncludes, assoc.target) || [];
      const assocJoinKey =
        assoc.associationType === 'HasOne' || assoc.associationType === 'HasMany'
          ? [assoc.foreignKey]
          : assoc.associationType === 'BelongsTo' ||
              assoc.associationType === 'BelongsToArray' ||
              assoc.associationType === 'BelongsToMany'
            ? [assoc.targetKey]
            : [];
      const attrPlan = ensureAttributesContainKeys(inc.attributes, [...assocJoinKey, ...nestedRequired]);
      const childAttributes = attrPlan.attributes;

      const childCollection = this.database.modelCollection?.get(assoc.target as never);
      const customOrder =
        childCollection && inc.options?.sort !== undefined
          ? childCollection.repository?.buildQueryOptions?.({ sort: inc.options.sort })?.order
          : undefined;
      const defaultOrder =
        assoc.target.primaryKeyAttribute && assoc.target.rawAttributes?.[assoc.target.primaryKeyAttribute]?.type
          ? [[assoc.target.primaryKeyAttribute, 'ASC']]
          : undefined;
      const order = customOrder ?? defaultOrder;

      const childInstances: Model[] = [];
      let handledNestedIncludes = false;
      const { associationType } = assoc;

      if (associationType === 'HasOne' || associationType === 'HasMany') {
        const parentKeys = [
          ...new Set(parentInstances.map((p) => p.get(assoc.sourceKey)).filter((v) => v !== undefined && v !== null)),
        ];
        if (parentKeys.length > 0) {
          for (const keyChunk of chunkKeys(parentKeys)) {
            const where = inc.where
              ? { [Op.and]: [{ [assoc.foreignKey]: keyChunk }, inc.where] }
              : { [assoc.foreignKey]: keyChunk };
            const rows = await findAllWithinBudget(
              assoc.target,
              {
                where,
                attributes: childAttributes,
                ...(order ? { order } : {}),
                ...(transaction ? { transaction } : {}),
              },
              budget,
              assoc.as,
            );
            childInstances.push(...rows);
          }
        }
        const grouped = new Map<unknown, Model[]>();
        for (const child of childInstances) {
          const fk = child.get(assoc.foreignKey);
          const list = grouped.get(fk);
          if (list) {
            list.push(child);
          } else {
            grouped.set(fk, [child]);
          }
        }
        const accessorKey = associationType === 'HasOne' ? assoc.options?.realAs || assoc.as : assoc.as;
        for (const parent of parentInstances) {
          const matches = grouped.get(parent.get(assoc.sourceKey)) || [];
          const val = associationType === 'HasOne' ? matches[0] ?? null : matches;
          parent.setDataValue(assoc.as, val);
          (parent as unknown as Record<string, unknown>)[accessorKey] = val;
        }
      } else if (associationType === 'BelongsTo') {
        const parentKeys = [
          ...new Set(parentInstances.map((p) => p.get(assoc.foreignKey)).filter((v) => v !== undefined && v !== null)),
        ];
        if (parentKeys.length > 0) {
          for (const keyChunk of chunkKeys(parentKeys)) {
            const rows = await findAllWithinBudget(
              assoc.target,
              {
                where: { [assoc.targetKey]: keyChunk },
                attributes: childAttributes,
                ...(transaction ? { transaction } : {}),
              },
              budget,
              assoc.as,
            );
            childInstances.push(...rows);
          }
        }
        const targetByKey = new Map<unknown, Model>();
        for (const child of childInstances) {
          targetByKey.set(child.get(assoc.targetKey), child);
        }
        for (const parent of parentInstances) {
          const match = targetByKey.get(parent.get(assoc.foreignKey)) ?? null;
          parent.setDataValue(assoc.as, match);
          (parent as unknown as Record<string, unknown>)[assoc.as] = match;
        }
      } else if (associationType === 'BelongsToMany' && assoc.through) {
        const parentKeys = [
          ...new Set(parentInstances.map((p) => p.get(assoc.sourceKey)).filter((v) => v !== undefined && v !== null)),
        ];
        const throughAs = assoc.oneFromTarget?.as || assoc.through.model.name;
        const otherKey = assoc.otherKey;
        if (parentKeys.length > 0 && otherKey) {
          const pivotRows: Model[] = [];
          for (const keyChunk of chunkKeys(parentKeys)) {
            const pivotWhere = assoc.through.scope
              ? { [Op.and]: [{ [assoc.foreignKey]: keyChunk }, assoc.through.scope] }
              : { [assoc.foreignKey]: keyChunk };
            const rows = await findAllWithinBudget(
              assoc.through.model,
              {
                where: pivotWhere,
                ...(transaction ? { transaction } : {}),
              },
              budget,
              assoc.as,
            );
            pivotRows.push(...rows);
          }
          const targetKeys = [
            ...new Set(pivotRows.map((pivot) => pivot.get(otherKey)).filter((v) => v !== undefined && v !== null)),
          ];
          const uniqueTargets: Model[] = [];
          const targetCap = Math.max(1, budget.max);
          if (targetKeys.length > 0) {
            for (const targetChunk of chunkKeys(targetKeys)) {
              const targetWhere = hasWhereCondition(inc.where)
                ? { [Op.and]: [{ [assoc.targetKey]: targetChunk }, inc.where] }
                : { [assoc.targetKey]: targetChunk };
              const targetRows = await assoc.target.findAll({
                where: targetWhere,
                attributes: childAttributes,
                limit: targetCap + 1,
                order: resolveBoundedOrder(assoc.target, order),
                ...(transaction ? { transaction } : {}),
              });
              if (uniqueTargets.length + targetRows.length > targetCap) {
                throw new ChildRowBudgetExceededError(assoc.as, budget.max);
              }
              uniqueTargets.push(...targetRows);
            }
          }
          if (childIncludes.length > 0 && uniqueTargets.length > 0) {
            await this.hydrateStreamedBatchIncludes(assoc.target, uniqueTargets, childIncludes, budget, transaction);
          }
          handledNestedIncludes = true;

          const childIncludeKeys = childIncludes
            .map((childInc) => resolveAssociation(assoc.target, childInc)?.as)
            .filter((name): name is string => Boolean(name));
          const targetByKey = new Map<unknown, Model>();
          const targetRankByKey = new Map<unknown, number>();
          uniqueTargets.forEach((target, idx) => {
            const key = target.get(assoc.targetKey);
            if (!targetByKey.has(key)) {
              targetByKey.set(key, target);
              targetRankByKey.set(key, idx);
            }
          });
          if (attrPlan.injected.length > 0 && uniqueTargets.length > 0) {
            stripInjectedInstanceAttrs(uniqueTargets, attrPlan.injected);
          }

          const pivotsByParent = new Map<unknown, Model[]>();
          for (const pivot of pivotRows) {
            const fk = pivot.get(assoc.foreignKey);
            const list = pivotsByParent.get(fk);
            if (list) {
              list.push(pivot);
            } else {
              pivotsByParent.set(fk, [pivot]);
            }
          }
          const matchesByParentKey = new Map<unknown, Model[]>();
          const seenTargets = new Set<Model>();
          for (const [fk, rawPivots] of pivotsByParent.entries()) {
            rawPivots.sort(
              (a, b) =>
                (targetRankByKey.get(a.get(otherKey)) ?? Number.MAX_SAFE_INTEGER) -
                (targetRankByKey.get(b.get(otherKey)) ?? Number.MAX_SAFE_INTEGER),
            );
            const matches: Model[] = [];
            for (const pivot of rawPivots) {
              const template = targetByKey.get(pivot.get(otherKey));
              if (!template) {
                continue;
              }
              const child = seenTargets.has(template)
                ? cloneHydratedModelInstance(assoc.target, template, childIncludeKeys)
                : template;
              seenTargets.add(template);
              const typedChild = child as unknown as {
                dataValues: Record<string, unknown>;
                [key: string]: unknown;
              };
              typedChild[throughAs] = typedChild.dataValues[throughAs] = pivot;
              matches.push(child);
            }
            matchesByParentKey.set(fk, matches);
          }
          for (const parent of parentInstances) {
            const matches = [...(matchesByParentKey.get(parent.get(assoc.sourceKey)) || [])];
            parent.setDataValue(assoc.as, matches);
            (parent as unknown as Record<string, unknown>)[assoc.as] = matches;
          }
        } else {
          if (parentKeys.length > 0) {
            const hasOneOpts: HasOneOptions = {
              as: '_pivot_',
              foreignKey: assoc.otherKey,
              sourceKey: assoc.targetKey,
              ...(assoc.through.scope ? { scope: assoc.through.scope } : {}),
            };
            const pivotAssoc = new HasOne(assoc.target as never, assoc.through.model as never, hasOneOpts);
            for (const keyChunk of chunkKeys(parentKeys)) {
              const rows = await findAllWithinBudget(
                assoc.target,
                {
                  ...(hasWhereCondition(inc.where) ? { where: inc.where } : {}),
                  attributes: childAttributes,
                  include: [{ association: pivotAssoc, where: { [assoc.foreignKey]: keyChunk } }],
                  subQuery: false,
                  ...(order ? { order } : {}),
                  ...(transaction ? { transaction } : {}),
                },
                budget,
                assoc.as,
              );
              childInstances.push(...rows);
            }
          }
          const grouped = new Map<unknown, Model[]>();
          for (const child of childInstances) {
            const typedChild = child as unknown as {
              dataValues: Record<string, unknown>;
              _pivot_?: Model;
              [key: string]: unknown;
            };
            const pivot = typedChild._pivot_;
            if (pivot) {
              typedChild[throughAs] = typedChild.dataValues[throughAs] = pivot;
              delete typedChild.dataValues._pivot_;
              delete typedChild._pivot_;
              const fk = pivot.get(assoc.foreignKey);
              const list = grouped.get(fk);
              if (list) {
                list.push(child);
              } else {
                grouped.set(fk, [child]);
              }
            }
          }
          for (const parent of parentInstances) {
            const matches = grouped.get(parent.get(assoc.sourceKey)) || [];
            parent.setDataValue(assoc.as, matches);
            (parent as unknown as Record<string, unknown>)[assoc.as] = matches;
          }
        }
      } else if (associationType === 'BelongsToArray') {
        const keySet = new Set<unknown>();
        for (const parent of parentInstances) {
          const arr = parent.get(assoc.foreignKey);
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (item !== undefined && item !== null) {
                keySet.add(item);
              }
            }
          }
        }
        if (keySet.size > 0) {
          for (const keyChunk of chunkKeys([...keySet])) {
            const where = inc.where
              ? { [Op.and]: [{ [assoc.targetKey]: keyChunk }, inc.where] }
              : { [assoc.targetKey]: keyChunk };
            const rows = await findAllWithinBudget(
              assoc.target,
              {
                where,
                attributes: childAttributes,
                ...(order ? { order } : {}),
                ...(transaction ? { transaction } : {}),
              },
              budget,
              assoc.as,
            );
            childInstances.push(...rows);
          }
        }
        const targetByKey = new Map<unknown, Model>();
        for (const child of childInstances) {
          targetByKey.set(child.get(assoc.targetKey), child);
        }
        for (const parent of parentInstances) {
          const arr = parent.get(assoc.foreignKey);
          const matches = Array.isArray(arr)
            ? arr.map((k) => targetByKey.get(k)).filter((m): m is Model => Boolean(m))
            : [];
          parent.setDataValue(assoc.as, matches);
          (parent as unknown as Record<string, unknown>)[assoc.as] = matches;
        }
      }

      if (!handledNestedIncludes) {
        if (childIncludes.length > 0 && childInstances.length > 0) {
          await this.hydrateStreamedBatchIncludes(assoc.target, childInstances, childIncludes, budget, transaction);
        }
        if (attrPlan.injected.length > 0 && childInstances.length > 0) {
          stripInjectedInstanceAttrs(childInstances, attrPlan.injected);
        }
      }
    }
  }
}
