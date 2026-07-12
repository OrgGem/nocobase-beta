/**
 * Type definitions adapted from dbgate-types (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 *
 * This file adapts types from the dbgate project for use in the NocoBase
 * MSSQL V2 data source plugin.
 */

// ---- Query / Result types ----

export interface QueryResultColumn {
  columnName: string;
  dataType: string;
  driverNativeColumn?: any;
  notNull?: boolean;
  autoIncrement?: boolean;
  tableName?: string;
  tableSchema?: string;
  sourceColumnName?: string;
  isPrimaryKey?: boolean;
}

export interface QueryResult {
  rows: Record<string, any>[];
  columns: QueryResultColumn[];
}

// ---- Stream types ----

export interface StreamOptions {
  recordset: (columns: QueryResultColumn[], extra?: Record<string, unknown>) => void;
  row: (row: Record<string, any>) => void;
  error?: (error: Error) => void;
  done?: (result?: any) => void;
  info?: (info: StreamInfo) => void;
  changedCurrentDatabase?: (database: string) => void;
}

export interface StreamInfo {
  message: string;
  line?: number;
  procedure?: string;
  time: Date;
  severity: 'info' | 'error';
  rowsAffected?: number;
}

export interface QueryOptions {
  discardResult?: boolean;
  addDriverNativeColumn?: boolean;
  commandTimeout?: number;
  range?: { offset: number; limit: number };
}

// ---- Database Handle ----

export interface DatabaseHandle<TClient = any> {
  client: TClient;
  database?: string;
  conid?: string;
  connectionType?: string;
}

// ---- Connection types ----

export interface MssqlConnectionOptions {
  server?: string;
  host?: string;
  port?: number;
  user?: string;
  username?: string;
  password?: string;
  database?: string;
  schema?: string;
  authType?: 'tedious' | 'sspi' | 'sql' | 'msentra' | 'azureManagedIdentity' | 'ntlm';
  accessToken?: string;
  windowsDomain?: string;
  ssl?: SslOptions;
  trustServerCertificate?: boolean;
  encrypt?: boolean;
  defaultIsolationLevel?: string;
  requestTimeout?: number;
  connectTimeout?: number;
  [key: string]: any;
}

export interface SslOptions {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

// ---- Auth types ----

export interface EngineAuthType {
  title: string;
  name: string;
  disabledFields?: string[];
}

// ---- Database Info / Schema types ----

export interface NamedObjectInfo {
  pureName: string;
  schemaName?: string;
}

export interface SchemaInfo {
  objectId?: number;
  schemaName: string;
  isDefault?: boolean;
}

export interface ColumnInfo {
  objectId?: number;
  columnName: string;
  dataType: string;
  notNull?: boolean;
  autoIncrement?: boolean;
  defaultValue?: string;
  defaultConstraint?: string;
  computedExpression?: string;
  isPersisted?: boolean;
  hasAutoValue?: boolean;
  columnComment?: string;
  isPrimaryKey?: boolean;
  isSparse?: boolean;
}

export interface PrimaryKeyInfo {
  objectId: number;
  pureName: string;
  schemaName: string;
  columnName: string;
  constraintName: string;
}

export interface ForeignKeyInfo {
  schemaName: string;
  pureName: string;
  columnName: string;
  refSchemaName: string;
  refTableName: string;
  refColumnName: string;
  constraintName: string;
  updateAction: string;
  deleteAction: string;
  objectId: number;
}

export interface IndexInfo {
  object_id: number;
  constraintName: string;
  indexType: string;
  isUnique: boolean;
  index_id: number;
  is_unique_constraint: boolean;
  filterDefinition?: string;
}

export interface IndexColumnInfo {
  object_id: number;
  index_id: number;
  columnName: string;
  isDescending: boolean;
  isIncludedColumn: boolean;
}

export interface TableSizeInfo {
  objectId: number;
  tableRowCount: number;
}

export interface TableInfo {
  objectId: number;
  pureName: string;
  schemaName: string;
  createDate?: Date;
  modifyDate?: Date;
  objectComment?: string;
  contentHash?: string;
  columns: ColumnInfo[];
  primaryKey?: { columns: { columnName: string }[]; constraintName?: string };
  foreignKeys?: {
    constraintName: string;
    columns: string[];
    refSchemaName: string;
    refTableName: string;
    refColumns: string[];
    updateAction: string;
    deleteAction: string;
  }[];
  indexes?: {
    constraintName: string;
    indexType: string;
    isUnique: boolean;
    filterDefinition?: string;
    columns: IndexColumnInfo[];
  }[];
  uniques?: {
    constraintName: string;
    columns: Pick<IndexColumnInfo, 'columnName'>[];
  }[];
  tableRowCount?: number;
  engine?: string;
}

export interface ViewInfo {
  objectId: number;
  pureName: string;
  schemaName: string;
  createDate?: Date;
  modifyDate?: Date;
  objectComment?: string;
  contentHash?: string;
  createSql?: string;
  columns: ColumnInfo[];
  engine?: string;
}

export interface ProcedureInfo {
  objectId: number;
  pureName: string;
  schemaName: string;
  createDate?: Date;
  modifyDate?: Date;
  contentHash?: string;
  createSql?: string;
  parameters: ProcedureParameterInfo[];
  engine?: string;
}

export interface FunctionInfo {
  objectId: number;
  pureName: string;
  schemaName: string;
  createDate?: Date;
  modifyDate?: Date;
  contentHash?: string;
  createSql?: string;
  parameters: FunctionParameterInfo[];
  engine?: string;
}

export interface TriggerInfo {
  objectId: string;
  pureName: string;
  schemaName: string;
  tableName: string;
  triggerTiming: string;
  eventType: string;
  contentHash?: string;
  createSql?: string;
  engine?: string;
}

export interface ProcedureParameterInfo {
  parameterName: string;
  dataType: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  isOutput: boolean;
  parentObjectId: number;
}

export interface FunctionParameterInfo extends ProcedureParameterInfo {}

export interface DatabaseInfo {
  tables?: TableInfo[];
  views?: ViewInfo[];
  procedures?: ProcedureInfo[];
  functions?: FunctionInfo[];
  triggers?: TriggerInfo[];
  engine?: string;
}

// ---- Dialect types ----

export interface SqlDialect {
  limitSelect?: boolean;
  rangeSelect?: boolean;
  topRecords?: boolean;
  offsetFetchRangeSyntax?: boolean;
  rowNumberOverPaging?: boolean;
  defaultSchemaName?: string | null;
  multipleSchema?: boolean;
  stringEscapeChar?: string;
  fallbackDataType?: string;
  quoteIdentifier?(s: string): string;
  useDatalengthForEmptyString?(dataType: string): boolean;
  disableGroupingForDataType?(dataType: string): boolean;
  explicitDropConstraint?: boolean;
  enableConstraintsPerTable?: boolean;
  dropColumnDependencies?: string[];
  changeColumnDependencies?: string[];
  anonymousPrimaryKey?: boolean;
  dropIndexContainsTableSpec?: boolean;
  createColumn?: boolean;
  dropColumn?: boolean;
  changeColumn?: boolean;
  createIndex?: boolean;
  dropIndex?: boolean;
  createForeignKey?: boolean;
  dropForeignKey?: boolean;
  createPrimaryKey?: boolean;
  dropPrimaryKey?: boolean;
  createUnique?: boolean;
  dropUnique?: boolean;
  createCheck?: boolean;
  dropCheck?: boolean;
  renameSqlObject?: boolean;
  filteredIndexes?: boolean;
  dropReferencesWhenDropTable?: boolean;
  namedDefaultConstraint?: boolean;
  safeCommentChanges?: boolean;
  columnProperties?: {
    columnComment?: boolean;
    isSparse?: boolean;
    isPersisted?: boolean;
  };
  predefinedDataTypes?: string[];
  createColumnViewExpression?(columnName: string, dataType: string, source: any, alias?: string): any;
  getTableFormOptions?(intent: string): any[];
}

// ---- Driver types ----

export interface EngineDriver<TClient = any> {
  engine: string;
  title: string;
  defaultPort?: number;
  defaultAuthTypeName?: string;
  supportsTransactions?: boolean;
  isolationLevels?: string[];
  defaultIsolationLevel?: string;
  supportsIncrementalAnalysis?: boolean;
  dialect: SqlDialect;
  dialectByVersion?(version: any): SqlDialect;
  analyserClass?: any;
  icon?: any;

  connect(conn: MssqlConnectionOptions): Promise<DatabaseHandle<TClient>>;
  close(dbhan: DatabaseHandle<TClient>): Promise<any>;
  query(dbhan: DatabaseHandle<TClient>, sql: string, options?: QueryOptions): Promise<QueryResult>;
  stream(dbhan: DatabaseHandle<TClient>, sql: string, options: StreamOptions): void;
  readQuery(dbhan: DatabaseHandle<TClient>, sql: string, structure?: any): Promise<any>;
  getVersion(dbhan: DatabaseHandle<TClient>): Promise<{ version: string; versionText?: string }>;
  listDatabases(dbhan: DatabaseHandle<TClient>): Promise<{ name: string }[]>;
  listSchemas(dbhan: DatabaseHandle<TClient>): Promise<SchemaInfo[] | null>;

  getAuthTypes(): EngineAuthType[] | null;
  enrichColumnMetadata?(
    dbhan: DatabaseHandle<TClient>,
    sql: string,
    columns: QueryResultColumn[],
    dbinfo?: DatabaseInfo,
  ): Promise<QueryResultColumn[]>;

  setTransactionIsolationLevel?(dbhan: DatabaseHandle<TClient>, level: string): Promise<void>;
  getLogDbInfo?(dbhan: DatabaseHandle<TClient>): { database?: string; engine: string; conid?: string };
}

// ---- Version type ----

export interface MssqlVersion {
  version: string;
  productVersion?: string;
  productVersionNumber?: number;
  versionText?: string;
}
