import type { Database } from '@nocobase/database';
import type { QueryInterface } from 'sequelize';

const TARGET_TABLE_NAMES = new Set(['userMemoryProfiles', 'user_memory_profiles']);
const TARGET_FIELD_NAMES = new Set(['userId', 'user_id']);
const TARGET_INDEX_NAMES = new Set(['user_memory_profiles_user_id']);

type LoggerLike = {
  warn(message: string, ...meta: unknown[]): void;
};

type ErrorRecord = Record<string, unknown>;
type AddIndexFn = QueryInterface['addIndex'];
type GuardedQueryInterface = QueryInterface & {
  __pluginUserMemoryDbSyncRaceGuard?: true;
};

function toRecord(value: unknown): ErrorRecord | undefined {
  if (value && typeof value === 'object') {
    return value as ErrorRecord;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function getNestedRecords(error: unknown): ErrorRecord[] {
  const records: ErrorRecord[] = [];
  const root = toRecord(error);
  if (!root) {
    return records;
  }

  records.push(root);
  const parent = toRecord(root.parent);
  if (parent) {
    records.push(parent);
  }
  const original = toRecord(root.original);
  if (original) {
    records.push(original);
  }

  return records;
}

function getTableName(tableName: unknown): string | undefined {
  if (typeof tableName === 'string') {
    return tableName;
  }

  const record = toRecord(tableName);
  return record ? asString(record.tableName) : undefined;
}

function getFieldName(field: unknown): string | undefined {
  if (typeof field === 'string') {
    return field;
  }

  const record = toRecord(field);
  return record ? asString(record.name) || asString(record.attribute) : undefined;
}

function getIndexFields(attributes: unknown): string[] {
  if (Array.isArray(attributes)) {
    return attributes.map(getFieldName).filter((field): field is string => Boolean(field));
  }

  const record = toRecord(attributes);
  const fields = record?.fields;
  if (Array.isArray(fields)) {
    return fields.map(getFieldName).filter((field): field is string => Boolean(field));
  }

  return [];
}

function getIndexName(attributes: unknown, options: unknown): string | undefined {
  const optionsRecord = toRecord(options);
  const attributesRecord = toRecord(attributes);

  return asString(optionsRecord?.name) || asString(attributesRecord?.name);
}

function matchesTargetIndexName(indexName: string | undefined): boolean {
  return Boolean(indexName && TARGET_INDEX_NAMES.has(indexName));
}

function mentionsTargetIndex(value: string): boolean {
  return Array.from(TARGET_INDEX_NAMES).some((indexName) => value.includes(indexName));
}

export function isUserMemoryProfilesUserIdIndex(tableName: unknown, attributes: unknown, options?: unknown): boolean {
  const indexName = getIndexName(attributes, options);
  if (matchesTargetIndexName(indexName)) {
    return true;
  }

  const normalizedTableName = getTableName(tableName);
  const fields = getIndexFields(attributes);

  return (
    Boolean(normalizedTableName && TARGET_TABLE_NAMES.has(normalizedTableName)) &&
    fields.length === 1 &&
    TARGET_FIELD_NAMES.has(fields[0])
  );
}

export function isDuplicateUserMemoryProfilesUserIdIndexError(error: unknown): boolean {
  const records = getNestedRecords(error);
  const codes = records.map((record) => asString(record.code) || asString(record.errno)).filter(Boolean);
  const messages = records
    .flatMap((record) => [asString(record.message), asString(record.sql), asString(record.constraint)])
    .filter((message): message is string => Boolean(message));

  const duplicateIndexError =
    codes.some((code) => code === '42P07' || code === '42710' || code === '1061') ||
    messages.some((message) => /already exists|Duplicate key name|index .* exists/i.test(message));

  return duplicateIndexError && messages.some(mentionsTargetIndex);
}

export function installUserMemoryDbSyncRaceGuard(db: Database, logger?: LoggerLike): void {
  const queryInterface = db.sequelize.getQueryInterface() as GuardedQueryInterface;
  if (queryInterface.__pluginUserMemoryDbSyncRaceGuard) {
    return;
  }

  const addIndex = queryInterface.addIndex.bind(queryInterface) as AddIndexFn;
  queryInterface.addIndex = (async (...args: Parameters<AddIndexFn>) => {
    try {
      return await addIndex(...args);
    } catch (error) {
      const [tableName, attributes, options] = args;
      if (
        isUserMemoryProfilesUserIdIndex(tableName, attributes, options) &&
        isDuplicateUserMemoryProfilesUserIdIndexError(error)
      ) {
        logger?.warn('[UserMemory] user_memory_profiles_user_id already exists during concurrent DB sync; continuing.');
        return undefined as Awaited<ReturnType<AddIndexFn>>;
      }
      throw error;
    }
  }) as AddIndexFn;

  queryInterface.__pluginUserMemoryDbSyncRaceGuard = true;
}
