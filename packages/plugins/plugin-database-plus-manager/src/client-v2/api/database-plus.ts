export interface CollectionStats {
  name: string;
  tableName: string;
  tableExists: boolean;
  estimatedRowCount: number | null;
  rowCount: number | null;
  primaryKey: string | null;
  autoIncrement: { seqName?: string; currentVal: number } | null;
}

export interface StatisticsResult {
  collection: CollectionStats;
  views: unknown[];
}

export interface IndexInfo {
  name: string;
  fields?: unknown[];
  unique?: boolean;
  [key: string]: unknown;
}

export interface AggregateMeasure {
  field: string;
  aggregation: 'sum' | 'count' | 'avg' | 'min' | 'max';
  alias?: string;
  distinct?: boolean;
}

export interface AggregateDimension {
  field: string;
  type?: string;
  alias?: string;
  format?: string;
}

export interface ApiRequest {
  request(config: { url: string; method: string; data?: unknown }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function unwrapResponse<T>(response: unknown): T {
  let current: unknown = response;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current) || !('data' in current)) break;
    current = current.data;
  }
  return current as T;
}

export function fetchStatistics(api: ApiRequest, collection: string) {
  return api.request({ url: 'databasePlusManager:statistics', method: 'post', data: { collection } });
}

export function fetchIndexes(api: ApiRequest, tableName: string) {
  return api.request({ url: 'databasePlusManager:listIndexes', method: 'post', data: { tableName } });
}

export function createIndex(api: ApiRequest, tableName: string, name: string, fields: string[]) {
  return api.request({ url: 'databasePlusManager:addIndex', method: 'post', data: { tableName, name, fields } });
}

export function dropIndex(api: ApiRequest, tableName: string, indexName: string) {
  return api.request({ url: 'databasePlusManager:removeIndex', method: 'post', data: { tableName, indexName } });
}

export function runSql(api: ApiRequest, sql: string) {
  return api.request({ url: 'databasePlusManager:runSql', method: 'post', data: { sql } });
}

export function runAggregate(api: ApiRequest, params: Record<string, unknown>) {
  return api.request({ url: 'databasePlusManager:aggregate', method: 'post', data: params });
}
