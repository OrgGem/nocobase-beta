/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Database } from '@nocobase/database';
import { SequelizeDataSource, DatabaseIntrospector } from '@nocobase/data-source-manager';
import { MssqlCollectionManager } from './MssqlCollectionManager';
import { MssqlIntrospector } from './MssqlIntrospector';
import type { Context } from '@nocobase/actions';
import { Op, literal, type Dialect } from 'sequelize';
import fs from 'fs';
import path from 'path';

function escapeLike(value: string) {
  return value.replace(/[_%]/g, '\\$&');
}

const MSSQL_DRIVER_NAME = 'tedious';

const resolveMssqlDriverPath = () => {
  const candidates = [
    // In production build: __dirname is dist/server/data-source
    // tedious is copied to dist/tedious
    path.join(__dirname, '../../tedious'),

    // In development matches: src/server/data-source
    // tedious might be in root node_modules or plugin node_modules
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
          const resolved = require.resolve(MSSQL_DRIVER_NAME, { paths: [basePath] });
          return resolved;
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // continue searching
    }
  }

  // Fallback to standard node resolution
  try {
    const resolved = require.resolve(MSSQL_DRIVER_NAME);
    return resolved;
  } catch (error) {
    console.error(`[MSSQL] Failed to resolve tedious driver. Error: ${error.message}`);
  }

  return undefined;
};

const formatDatabaseOptions = (options: MssqlDataSourceOptions = {}) => {
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
      ...(dialectOptions?.options || {}),
      ...(encrypt === undefined ? {} : { encrypt }),
      // Use UTC to avoid timezone offset format issues with DATETIME columns
      useUTC: true,
      // Timeout tuning: tedious defaults to 15s which is too low for large tables
      requestTimeout: dialectOptions?.options?.requestTimeout ?? 120000, // 2 min (default: 15s)
      connectTimeout: dialectOptions?.options?.connectTimeout ?? 30000, // 30s connection timeout
      cancelTimeout: dialectOptions?.options?.cancelTimeout ?? 10000, // 10s cancel timeout
    },
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
    logging,
    pool: {
      max: 10, // more connections than default 5
      min: 2, // keep 2 warm connections
      acquire: 30000, // 30s to acquire connection — fail fast instead of blocking 60s
      idle: 10000, // 10s idle before release
      ...(pool || {}), // user overrides
    },
    underscored,
    logger: sqlLogger || logger,
  };
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
  dialectOptions?: {
    options?: Record<string, any>;
    [key: string]: any;
  };
  collectionManager?: {
    database?: Database;
    [key: string]: any;
  };
  timezone?: string;
  logging?: boolean | ((...args: any[]) => void);
  pool?: any;
  underscored?: boolean;
  sqlLogger?: any;
  logger?: any;
  name?: string;
  cache?: any;
  storagePath?: string;
};

export class MssqlExternalDataSource extends SequelizeDataSource<MssqlIntrospector> {
  /**
   * Override createCollectionManager to provide MssqlCollectionManager
   * which registers the MSSQL-specific repository.
   */
  createCollectionManager(options: MssqlDataSourceOptions = {}) {
    const databaseOptions = formatDatabaseOptions(options);
    const collectionOptions = options.collectionManager || {};
    const database =
      collectionOptions.database instanceof Database ? collectionOptions.database : new Database(databaseOptions);

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

  /**
   * Constructor: initializes the data source and sets up MSSQL-specific hooks.
   */
  constructor(options: MssqlDataSourceOptions) {
    super(options);
    this.setupMssqlHooks();
  }

  /**
   * Register MSSQL-aware text search operators on the external database.
   *
   * Strategy per operator:
   *   $includes / $notIncludes  → CONTAINS() when column has FTS index, else LIKE '%value%'
   *   $endWith  / $notEndWith   → always LIKE '%value' (FTS has no suffix-word search)
   *   $startsWith / $notStartsWith → unchanged (LIKE 'value%' already uses B-tree index)
   *
   * NOTE on CONTAINS() semantics:
   *   CONTAINS uses word-boundary matching, not pure substring matching.
   *   "barfoo" does NOT match CONTAINS(col, '"foo"'), but it does match LIKE '%foo%'.
   *   For most real-world search UIs (names, descriptions) this is an acceptable trade-off
   *   in exchange for O(log n) FTS index seeks vs O(n) full table scans.
   */
  private registerMssqlTextOperators() {
    const db = this.collectionManager.db;
    const introspector = this.introspector as MssqlIntrospector;

    /**
     * Build a safe CONTAINS() literal.
     * The column name comes from the model definition (not user input) so bracket-quoting is safe.
     * The search value is escaped via sequelize.escape() to prevent SQL injection.
     */
    const buildContains = (fieldName: string, tableName: string, value: string, negate = false) => {
      // Use prefix search (*) for intuitive search feel; wrap in double-quotes and escape internal quotes
      const ftsValue = '"' + value.trim().replace(/"/g, '""') + '*"';
      const escapedFts = db.sequelize.escape(ftsValue);
      const expr = `CONTAINS([${fieldName}], ${escapedFts})`;
      return literal(negate ? `NOT (${expr})` : expr);
    };

    db.registerOperators({
      $includes(value, ctx) {
        if (value === null) return { [Op.is]: null };
        const tableName: string = ctx.model?.tableName ?? '';
        const fieldName: string = ctx.fieldName ?? '';
        if (typeof value === 'string' && introspector.hasFTSIndex(tableName, fieldName)) {
          if (!value.trim()) {
            return { [Op.like]: `%${escapeLike(value)}%` }; // Fallback to LIKE for empty string because CONTAINS fails on "*"
          }
          return buildContains(fieldName, tableName, value);
        }
        // Fallback: standard LIKE
        if (Array.isArray(value)) {
          return { [Op.or]: value.map((v) => ({ [Op.like]: `%${escapeLike(v)}%` })) };
        }
        return { [Op.like]: `%${escapeLike(value)}%` };
      },

      $notIncludes(value, ctx) {
        if (value === null) return { [Op.not]: null };
        const tableName: string = ctx.model?.tableName ?? '';
        const fieldName: string = ctx.fieldName ?? '';
        if (typeof value === 'string' && introspector.hasFTSIndex(tableName, fieldName)) {
          if (!value.trim()) {
            return { [Op.notLike]: `%${escapeLike(value)}%` };
          }
          return buildContains(fieldName, tableName, value, true);
        }
        if (Array.isArray(value)) {
          return { [Op.and]: value.map((v) => ({ [Op.notLike]: `%${escapeLike(v)}%` })) };
        }
        return { [Op.notLike]: `%${escapeLike(value)}%` };
      },

      // $endWith / $notEndWith: FTS has no suffix-word search equivalent, keep LIKE
      $endWith(value, _ctx) {
        if (value === null) return { [Op.is]: null };
        if (Array.isArray(value)) {
          return { [Op.or]: value.map((v) => ({ [Op.like]: `%${escapeLike(v)}` })) };
        }
        return { [Op.like]: `%${escapeLike(value)}` };
      },

      $notEndWith(value, _ctx) {
        if (value === null) return { [Op.not]: null };
        if (Array.isArray(value)) {
          return { [Op.and]: value.map((v) => ({ [Op.notLike]: `%${escapeLike(v)}` })) };
        }
        return { [Op.notLike]: `%${escapeLike(value)}` };
      },
    });
  }

  /**
   * Set up MSSQL-specific Sequelize hooks for datetime handling.
   * MSSQL DATETIME doesn't support timezone offset format like '+00:00',
   * so we convert Date objects to 'YYYY-MM-DD HH:mm:ss.SSS' on save.
   *
   * NOTE: We intentionally do NOT transform dates in WHERE clauses.
   * The NocoBase core date operators already produce properly formatted strings
   * (via DatetimeNoTzField → 'YYYY-MM-DD HH:mm:ss') that MSSQL understands
   * natively. Using Sequelize.literal() for dates in WHERE clauses would:
   *   1. Bypass parameterized queries → no index usage → full table scans
   *   2. Add recursive overhead to every single query
   */
  private setupMssqlHooks() {
    const db = this.collectionManager.db;
    if (!db?.sequelize) return;

    const isDatetimeString = (value: string): boolean => {
      return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)?$/.test(value);
    };

    // Hook: Convert datetime values to MSSQL-compatible format on save only.
    // Uses plain string (not Sequelize.literal) so Sequelize can parameterize it.
    db.sequelize.addHook('beforeSave', (instance: any) => {
      if (!instance?.dataValues) return;

      for (const [key, value] of Object.entries(instance.dataValues)) {
        let dateValue: Date | null = null;

        if (value instanceof Date) {
          dateValue = value;
        } else if (typeof value === 'string' && isDatetimeString(value)) {
          dateValue = new Date(value);
        }

        if (dateValue && !isNaN(dateValue.getTime())) {
          // Format: 'YYYY-MM-DD HH:mm:ss.SSS' — MSSQL native datetime format
          instance.dataValues[key] = dateValue.toISOString().replace('T', ' ').replace('Z', '');
        }
      }
    });
  }

  /**
   * Load data source: introspect tables and merge with persisted local data.
   * This method is called by the core framework with `localData` populated from
   * the `dataSourcesCollections` / `dataSourcesFields` tables.
   */
  async load(options: any = {}) {
    const { localData = {} } = options;

    // Authenticate connection
    try {
      await this.collectionManager.db.sequelize.authenticate();
      this.logger?.info?.('[MSSQL] Database connection established successfully');
    } catch (error) {
      this.logger?.error?.('[MSSQL] Failed to authenticate database connection', error);
      throw error;
    }

    // Check database version
    try {
      await this.collectionManager.db.checkVersion();
    } catch (error) {
      this.logger?.warn?.('[MSSQL] Database version check failed or not supported', error);
    }

    // Introspect tables from the external database
    try {
      const tables = await this.introspector.getTables();
      this.logger?.info?.(`[MSSQL] Found ${tables.length} tables in database`);

      const schema = this.collectionManager.db.options.schema || 'dbo';
      const total = tables.length;
      let loaded = 0;

      // Pre-load all primary key info in one query before parallel introspection
      await (this.introspector as MssqlIntrospector).preloadAllPrimaryKeys(schema);

      // Pre-load FTS index info, then register smart text operators (CONTAINS vs LIKE routing)
      await (this.introspector as MssqlIntrospector).preloadFTSIndexedColumns(schema);
      this.registerMssqlTextOperators();

      // Parallelize introspection in batches to avoid connection pool exhaustion
      const BATCH_SIZE = 5;
      for (let i = 0; i < tables.length; i += BATCH_SIZE) {
        const batch = tables.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (tableName) => {
            const tableInfo = { tableName, schema };
            try {
              const collectionOptions = await this.introspector.getCollection({
                tableInfo,
                localOptions: localData[tableName] || {},
              });

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
   * Read all tables from the external MSSQL database.
   * Called by the core framework's loadDataSourceTablesIntoCollections middleware.
   * Returns objects with { name } so the CollectionsTable UI component can render correctly.
   */
  async readTables(): Promise<any> {
    const tables = await this.introspector.getTables();
    return tables.map((name: string) => ({ name }));
  }

  /**
   * Load specific tables from the external MSSQL database.
   * Called by the core framework's loadDataSourceTablesIntoCollections middleware
   * when creating/updating a data source with selected tables.
   *
   * This method persists selected tables to the `dataSourcesCollections` table
   * via the middleware pipeline.
   */
  async loadTables(ctx: Context, tables: string[]): Promise<any> {
    this.logger?.info?.(`[MSSQL] Loading ${tables.length} specific tables:`, tables);

    for (const tableName of tables) {
      const tableInfo = {
        tableName,
        schema: this.collectionManager.db.options.schema || 'dbo',
      };

      try {
        const collectionOptions = await this.introspector.getCollection({ tableInfo });
        collectionOptions.introspected = true;
        collectionOptions.repository = 'mssql-repo';
        collectionOptions.simplePaginate = true;

        this.collectionManager.defineCollection(collectionOptions);
        this.logger?.debug?.(`[MSSQL] Loaded table ${tableName} as collection`);
      } catch (error) {
        this.logger?.error?.(`[MSSQL] Failed to load table ${tableName}:`, error);
        throw error;
      }
    }
  }

  /**
   * Return public connection options (safe to expose to client).
   */
  publicOptions() {
    const opts = (this as any).options || {};
    return {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      database: opts.database,
      schema: opts.schema,
      tablePrefix: opts.tablePrefix,
      encrypt: opts.encrypt,
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

    const database = new Database(formatDatabaseOptions(options));

    try {
      await database.sequelize.authenticate();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const connectionError = new Error(`Failed to connect to MSSQL database: ${message}`) as Error & { cause?: any };
      connectionError.cause = error;
      throw connectionError;
    } finally {
      await database.close();
    }
  }
}
