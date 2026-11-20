// SPDX-License-Identifier: Apache-2.0

import { Database } from '@nocobase/database';
import { SequelizeDataSource } from '@nocobase/data-source-manager';
import type { CollectionOptions, LoadedCollections, LoadTablesOptions } from '@nocobase/data-source-manager';
import { MssqlCollectionManager } from './MssqlCollectionManager';
import { MssqlIntrospector } from './MssqlIntrospector';
import { type MssqlRepositoryRuntimeOptions } from './MssqlRepository';
import { MssqlDatetimeNoTzField } from '../fields/MssqlDatetimeNoTzField';
import { createMssqlOperators, type FullTextSearchMode } from '../operators/mssql-operators';
import type { Context } from '@nocobase/actions';
import { type Dialect } from 'sequelize';
import fs from 'fs';
import path from 'path';

const MSSQL_DRIVER_NAME = 'tedious';
const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 2000;
// Native tedious ISOLATION_LEVEL.READ_UNCOMMITTED value (persists across transactions via connectionIsolationLevel).
const TEDIOUS_ISOLATION_READ_UNCOMMITTED = 0x01;

interface TediousConnectionLike {
  lib?: {
    Request: new (sql: string, callback: (err?: Error | null) => void) => unknown;
  };
  queue?: {
    enqueue<T>(fn: () => Promise<T>): Promise<T>;
  };
  execSqlBatch?: (request: unknown) => void;
  execSql?: (request: unknown) => void;
  close?: () => void;
}

const resolveMssqlDriverPath = () => {
  const candidates = [
    // In production build: __dirname is dist/server/data-source; tedious is copied to dist/tedious.
    path.join(__dirname, '../../tedious'),
    // In development: src/server/data-source; tedious might be in root or plugin node_modules.
    path.join(__dirname, '../../../node_modules'),
    // Legacy/Backup paths
    path.join(__dirname, '../tedious'),
    path.join(__dirname, '../../node_modules'),
    process.cwd(),
    __dirname,
  ];

  for (const candidate of candidates) {
    try {
      const basePath = fs.existsSync(candidate) ? candidate : undefined;
      if (basePath) {
        if (candidate.endsWith('tedious') && fs.existsSync(path.join(candidate, 'package.json'))) {
          return require.resolve(candidate);
        }

        try {
          return require.resolve(MSSQL_DRIVER_NAME, { paths: [basePath] });
        } catch {
          // ignore
        }
      }
    } catch {
      // continue searching
    }
  }

  try {
    return require.resolve(MSSQL_DRIVER_NAME);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[MSSQL] Failed to resolve tedious driver. Error: ${message}\n`);
  }

  return undefined;
};

/**
 * Build the session-level `SET LOCK_TIMEOUT` statement executed on each new MSSQL connection when
 * configured. Isolation level (`readUncommitted`) is configured natively via tedious options so it
 * survives transaction boundaries without an extra round trip.
 */
export function buildSessionInitSql(options: Pick<MssqlDataSourceOptions, 'lockTimeout'>): string {
  if (typeof options.lockTimeout === 'number' && Number.isFinite(options.lockTimeout) && options.lockTimeout > 0) {
    return `SET LOCK_TIMEOUT ${Math.floor(options.lockTimeout)};`;
  }
  return '';
}

function executeOnTediousConnection(connection: TediousConnectionLike, sql: string): Promise<void> {
  const RequestCtor = connection?.lib?.Request;
  const execFn = connection?.execSqlBatch || connection?.execSql;
  if (!RequestCtor || typeof execFn !== 'function') {
    return Promise.resolve();
  }
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const request = new RequestCtor(sql, (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
      execFn.call(connection, request);
    });
  return connection.queue ? connection.queue.enqueue(run) : run();
}

export const formatDatabaseOptions = (options: MssqlDataSourceOptions = {}) => {
  const {
    host,
    port,
    username,
    password,
    database,
    schema,
    tablePrefix,
    dialectOptions,
    encrypt,
    trustServerCertificate,
    readOnlyIntent,
    requestTimeout,
    connectTimeout,
    lockTimeout,
    readUncommitted,
    fastCount,
    deferredJoinThreshold,
    slowQueryThresholdMs,
    timezone,
    logging,
    pool,
    underscored,
    sqlLogger,
    logger,
  } = options;

  const dialectModulePath = resolveMssqlDriverPath();
  const mergedDialectOptions = {
    ...(dialectOptions || {}),
    options: {
      // enableArithAbort: ON is the recommended SQL Server session setting. Leaving it OFF makes
      // the optimizer ignore indexed computed columns / indexed views and hurts plan reuse.
      enableArithAbort: true,
      ...(dialectOptions?.options || {}),
      ...(encrypt === undefined ? {} : { encrypt }),
      ...(trustServerCertificate === undefined ? {} : { trustServerCertificate }),
      ...(readOnlyIntent === undefined ? {} : { readOnlyIntent }),
      ...(readUncommitted === true
        ? {
            // Apply READ UNCOMMITTED only to autocommit session reads; leave tedious's `isolationLevel`
            // at READ COMMITTED so explicit write transactions (update/destroy/create) never read dirty rows.
            connectionIsolationLevel: TEDIOUS_ISOLATION_READ_UNCOMMITTED,
          }
        : {}),
      // useUTC is intentionally forced ON after user options so tedious reads/writes UTC consistently.
      useUTC: true,
      requestTimeout: requestTimeout ?? dialectOptions?.options?.requestTimeout ?? 120000,
      connectTimeout: connectTimeout ?? dialectOptions?.options?.connectTimeout ?? 30000,
      cancelTimeout: dialectOptions?.options?.cancelTimeout ?? 10000,
    },
  };

  const targetLogger = sqlLogger || logger;
  const threshold = slowQueryThresholdMs ?? DEFAULT_SLOW_QUERY_THRESHOLD_MS;
  const enableSlowQueryLog =
    typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0 && logging !== false;

  const effectiveLogging = enableSlowQueryLog
    ? (sql: string, timing?: number) => {
        if (typeof timing === 'number' && timing >= threshold) {
          const preview = typeof sql === 'string' && sql.length > 1000 ? `${sql.slice(0, 1000)}...` : sql;
          targetLogger?.warn?.(`[MSSQL] Slow query (${timing}ms): ${preview}`);
        }
        if (typeof logging === 'function') {
          logging(sql, timing);
        }
      }
    : logging;

  const mssqlRuntimeOptions: MssqlRepositoryRuntimeOptions = {
    ...(fastCount === undefined ? {} : { fastCount }),
    ...(deferredJoinThreshold === undefined ? {} : { deferredJoinThreshold }),
  };

  return {
    host,
    port,
    username,
    password,
    database,
    schema,
    tablePrefix,
    ...(dialectModulePath ? { dialectModulePath } : {}),
    dialectOptions: mergedDialectOptions,
    dialect: 'mssql' as Dialect,
    timezone,
    logging: effectiveLogging,
    ...(enableSlowQueryLog ? { benchmark: true } : {}),
    pool: {
      max: 10,
      min: 2,
      acquire: 30000,
      idle: 10000,
      ...(pool || {}),
    },
    underscored,
    logger: targetLogger,
    mssqlRuntimeOptions,
    ...(lockTimeout !== undefined ? { lockTimeout } : {}),
    ...(readUncommitted !== undefined ? { readUncommitted } : {}),
  };
};

/**
 * Lightweight database options for short-lived probe connections (`testConnection`, `readTables`)
 * so probes do not open warm pools (`min: 2`) or hang for 120s.
 */
export const formatProbeDatabaseOptions = (options: MssqlDataSourceOptions = {}) => {
  return formatDatabaseOptions({
    ...options,
    connectTimeout: options.connectTimeout ?? 10000,
    requestTimeout: options.requestTimeout ?? 15000,
    slowQueryThresholdMs: 0,
    pool: {
      max: 1,
      min: 0,
      acquire: 15000,
      idle: 1000,
      ...(options.pool || {}),
    },
  });
};

export type MssqlDataSourceOptions = {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  schema?: string;
  tablePrefix?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  readOnlyIntent?: boolean;
  requestTimeout?: number;
  connectTimeout?: number;
  lockTimeout?: number;
  readUncommitted?: boolean;
  fullTextSearchMode?: FullTextSearchMode;
  fastCount?: boolean;
  deferredJoinThreshold?: number;
  slowQueryThresholdMs?: number;
  dialectOptions?: {
    options?: Record<string, unknown>;
    [key: string]: unknown;
  };
  collectionManager?: {
    database?: Database;
    [key: string]: unknown;
  };
  timezone?: string;
  logging?: boolean | ((...args: unknown[]) => void);
  pool?: Record<string, unknown>;
  underscored?: boolean;
  sqlLogger?: { warn?: (...args: unknown[]) => void; [key: string]: unknown };
  logger?: { warn?: (...args: unknown[]) => void; [key: string]: unknown };
  name?: string;
  cache?: unknown;
  storagePath?: string;
  addAllCollections?: boolean;
  selectedCollections?: string[];
};

export class MssqlExternalDataSource extends SequelizeDataSource<MssqlIntrospector> {
  /**
   * Override createCollectionManager to provide MssqlCollectionManager, register MSSQL-specific
   * field types (`MssqlDatetimeNoTzField`), and configure session-level connection hooks.
   */
  createCollectionManager(options: MssqlDataSourceOptions = {}) {
    const databaseOptions = formatDatabaseOptions(options);
    const collectionOptions = options.collectionManager || {};
    const database =
      collectionOptions.database instanceof Database ? collectionOptions.database : new Database(databaseOptions);

    if (typeof database.registerFieldTypes === 'function') {
      database.registerFieldTypes({
        datetimeNoTz: MssqlDatetimeNoTzField,
      });
    }

    const sessionInitSql = buildSessionInitSql(options);
    if (sessionInitSql && database.sequelize) {
      database.sequelize.addHook('afterConnect', async (connection: unknown) => {
        const tediousConn = connection as TediousConnectionLike;
        try {
          await executeOnTediousConnection(tediousConn, sessionInitSql);
        } catch (error) {
          // Close the opened socket before rethrowing so failed afterConnect hooks never leak TCP connections.
          tediousConn?.close?.();
          throw error;
        }
      });
    }

    return new MssqlCollectionManager({
      ...collectionOptions,
      database,
    });
  }

  /**
   * Override createDatabaseIntrospector to provide MSSQL-specific introspection.
   */
  createDatabaseIntrospector(db: Database): MssqlIntrospector {
    return new MssqlIntrospector({ db });
  }

  constructor(options: MssqlDataSourceOptions) {
    super(options);
    const dbOpts = this.collectionManager.db?.options as
      | { mssqlRuntimeOptions?: MssqlRepositoryRuntimeOptions }
      | undefined;
    if (dbOpts?.mssqlRuntimeOptions && this.introspector) {
      dbOpts.mssqlRuntimeOptions.isAnsiStringColumn = (tableName, columnName) =>
        this.introspector.isAnsiStringColumn(tableName, columnName);
    }
    this.registerMssqlTextOperators();
  }

  /**
   * Register MSSQL-aware operators on the external database:
   * - T-SQL compliant LIKE wildcard escaping (`[[]`, `[%]`, `[_]`)
   * - Safe qualified CONTAINS() routing when enabled FTS indexes exist
   * - ANSI VARCHAR/CHAR SARGable literals (without `N` prefix) for ASCII inputs to prevent CONVERT_IMPLICIT scans
   */
  private registerMssqlTextOperators() {
    const db = this.collectionManager.db;
    if (typeof db?.registerOperators !== 'function') {
      return;
    }
    const introspector = this.introspector as MssqlIntrospector;
    const operators = createMssqlOperators(
      introspector,
      () => (this.options as MssqlDataSourceOptions)?.fullTextSearchMode ?? 'auto',
    );
    db.registerOperators(operators);
  }

  /**
   * Load data source: introspect tables/views and merge with persisted local data.
   */
  async load(options: { localData?: LoadedCollections } = {}) {
    const { localData = {} } = options;

    try {
      await this.collectionManager.db.sequelize.authenticate();
      this.logger?.info?.('[MSSQL] Database connection established successfully');
    } catch (error) {
      this.logger?.error?.('[MSSQL] Failed to authenticate database connection', error);
      throw error;
    }

    try {
      await this.collectionManager.db.checkVersion();
    } catch (error) {
      this.logger?.warn?.('[MSSQL] Database version check failed or not supported', error);
    }

    try {
      const dataSourceOptions = this.options as MssqlDataSourceOptions;
      // Existing sources may have addAllCollections=false without a stored selection: keep loading
      // all tables until an explicit selection is saved.
      const selectedTables =
        dataSourceOptions.addAllCollections === false && Array.isArray(dataSourceOptions.selectedCollections)
          ? [...new Set(dataSourceOptions.selectedCollections.filter((name) => typeof name === 'string' && name))]
          : undefined;
      const tables = selectedTables ?? (await this.introspector.getTables());
      this.logger?.info?.(`[MSSQL] Loading ${tables.length} tables in database`);

      const schema = this.collectionManager.db.options.schema || 'dbo';
      const total = tables.length;
      let loaded = 0;

      // Bulk-preload column metadata, PKs, and indexes in one query each when loading the full
      // schema or multiple selected tables (eliminates N+1 describeTable / sp_helpindex round trips).
      if (!selectedTables) {
        await this.introspector.preloadAllColumns(schema);
        await this.introspector.preloadAllPrimaryKeys(schema);
        await this.introspector.preloadAllIndexes?.(schema);
      } else if (selectedTables.length > 1) {
        await this.introspector.preloadAllColumns(schema, selectedTables);
        await this.introspector.preloadAllPrimaryKeys(schema, selectedTables);
        await this.introspector.preloadAllIndexes?.(schema, selectedTables);
      }

      if (tables.length) {
        await this.introspector.preloadFTSIndexedColumns(schema, selectedTables);
      }
      this.registerMssqlTextOperators();

      const BATCH_SIZE = 5;
      for (let i = 0; i < tables.length; i += BATCH_SIZE) {
        const batch = tables.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (tableName) => {
            const tableInfo = { tableName, schema };
            try {
              const name = this.introspector.tableInfoToCollectionOptions(tableInfo).name;
              const introspected = await this.introspector.getCollection({
                tableInfo,
                localOptions: localData[name] || localData[tableName] || {},
              });
              const [collectionOptions] = this.mergeWithLoadedCollections([introspected], localData);

              collectionOptions.introspected = true;
              collectionOptions.repository = 'mssql-repo';
              // Skip COUNT(*) for external MSSQL tables — use LIMIT+1 pagination instead
              collectionOptions.simplePaginate = true;

              this.collectionManager.defineCollection(collectionOptions);
              loaded++;
              this.emitLoadingProgress({ total, loaded });
            } catch (error) {
              this.logger?.error?.(`[MSSQL] Failed to introspect table ${tableName}:`, error);
            }
          }),
        );
      }

      this.logger?.info?.(`[MSSQL] Successfully loaded ${loaded}/${total} collections`);
    } catch (error) {
      this.logger?.error?.('[MSSQL] Failed to introspect database', error);
      throw error;
    }
  }

  /**
   * Read all tables and views from the external MSSQL database.
   */
  async readTables(): Promise<Array<{ name: string }>> {
    const tables = await this.introspector.getTables();
    return tables.map((name: string) => ({ name }));
  }

  /**
   * Load specific tables from the external MSSQL database and persist selection on create/update.
   */
  async loadTables(ctx: Context, tables: string[] = [], options: LoadTablesOptions = {}): Promise<void> {
    const { resourceName, actionName, params } = ctx.action || {};
    if (resourceName === 'dataSources' && (actionName === 'create' || actionName === 'update')) {
      const values = params.values;
      const addAllCollections = values?.addAllCollections ?? values?.options?.addAllCollections;
      if (addAllCollections === false && Array.isArray(params.values?.collections)) {
        values.options = {
          ...values.options,
          addAllCollections: false,
          selectedCollections: [
            ...new Set(tables.filter((name): name is string => typeof name === 'string' && name.length > 0)),
          ],
        };
      }
    }

    const collections = await this.prepareTables(tables, options.localData);
    for (const collection of collections) {
      this.collectionManager.defineCollection(collection);
    }
  }

  async prepareTables(
    tables: string[],
    localData: LoadedCollections = {},
    options: { skipFtsPreload?: boolean } = {},
  ): Promise<CollectionOptions[]> {
    const collections: CollectionOptions[] = [];
    const schema = this.collectionManager.db.options.schema || 'dbo';
    this.logger?.info?.(`[MSSQL] Loading ${tables.length} specific tables:`, tables);

    if (tables.length > 1) {
      await this.introspector.preloadAllColumns?.(schema, tables);
      await this.introspector.preloadAllPrimaryKeys?.(schema, tables);
      await this.introspector.preloadAllIndexes?.(schema, tables);
    }
    if (tables.length > 0 && !options.skipFtsPreload) {
      await this.introspector.preloadFTSIndexedColumns?.(schema, tables, { merge: true });
    }

    for (const tableName of tables) {
      const tableInfo = {
        tableName,
        schema,
      };

      try {
        const name = this.introspector.tableInfoToCollectionOptions(tableInfo).name;
        const introspected = await this.introspector.getCollection({
          tableInfo,
          localOptions: localData[name] || localData[tableName] || {},
        });
        const [collectionOptions] = this.mergeWithLoadedCollections([introspected], localData);
        collectionOptions.introspected = true;
        collectionOptions.repository = 'mssql-repo';
        collectionOptions.simplePaginate = true;

        collections.push(collectionOptions);
        this.logger?.debug?.(`[MSSQL] Loaded table ${tableName} as collection`);
      } catch (error) {
        this.logger?.error?.(`[MSSQL] Failed to load table ${tableName}:`, error);
        throw error;
      }
    }
    return collections;
  }

  /**
   * Return public connection options (safe to expose to client).
   */
  publicOptions() {
    const opts = (this.options as MssqlDataSourceOptions) || {};
    return {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      database: opts.database,
      schema: opts.schema,
      tablePrefix: opts.tablePrefix,
      encrypt: opts.encrypt,
      trustServerCertificate: opts.trustServerCertificate,
      readOnlyIntent: opts.readOnlyIntent,
      requestTimeout: opts.requestTimeout,
      connectTimeout: opts.connectTimeout,
      lockTimeout: opts.lockTimeout,
      readUncommitted: opts.readUncommitted,
      fullTextSearchMode: opts.fullTextSearchMode,
      fastCount: opts.fastCount,
      deferredJoinThreshold: opts.deferredJoinThreshold,
      slowQueryThresholdMs: opts.slowQueryThresholdMs,
      addAllCollections: opts.addAllCollections,
      selectedCollections: opts.selectedCollections,
      isExternal: true,
      isDBInstance: true,
    };
  }

  async close() {
    await this.collectionManager.db?.close();
  }

  static async testConnection(options?: MssqlDataSourceOptions): Promise<boolean> {
    if (!options) {
      throw new Error('Connection options are required to test MSSQL connectivity');
    }

    if (!options.host || typeof options.host !== 'string' || !options.host.trim()) {
      throw new Error('Host is required to test the connection');
    }

    if (!options.database || typeof options.database !== 'string' || !options.database.trim()) {
      throw new Error('Database name is required to test the connection');
    }

    if (!options.username || typeof options.username !== 'string' || !options.username.trim()) {
      throw new Error('Username is required to test the connection');
    }

    if (!options.password || typeof options.password !== 'string' || !options.password.trim()) {
      throw new Error('Password is required to test the connection');
    }

    const database = new Database(formatProbeDatabaseOptions(options));

    try {
      await database.sequelize.authenticate();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const connectionError = new Error(`Failed to connect to MSSQL database: ${message}`) as Error & {
        cause?: unknown;
      };
      connectionError.cause = error;
      throw connectionError;
    } finally {
      await database.close();
    }
  }
}
