/**
 * MSSQL External Data Source — direct tedious connection without Sequelize.
 *
 * Follows the same pattern as ElasticsearchDataSource:
 *   - Extends DataSource directly (not SequelizeDataSource)
 *   - Creates its own CollectionManager
 *   - Implements load/readTables/loadTables/testConnection
 *
 * Uses a connection pool so multiple API requests can execute queries concurrently.
 * Introspection sessions acquire a dedicated connection for their duration.
 *
 * Adapted from dbgate-plugin-mssql driver.js (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 */

import { DataSource, type CollectionOptions, type FieldOptions } from '@nocobase/data-source-manager';
import type { Context } from '@nocobase/actions';
import type { Logger } from '@nocobase/logger';
import { MssqlCollectionManager } from './MssqlCollectionManager';
import { MsSqlAnalyser } from '../introspector/MsSqlAnalyser';
import { tediousConnect, tediousQueryCore, tediousStream, tediousReadQuery } from '../driver/tediousDriver';
import { nativeConnect, nativeQueryCore, nativeStream, nativeReadQuery } from '../driver/nativeDriver';
import { driverBaseMethods } from '../driver/driverBase';
import { ConnectionPool } from '../driver/ConnectionPool';
import { VERSION_QUERY, dialectByVersion } from '../dialect';
import dialect from '../dialect';
import type {
  MssqlConnectionOptions,
  DatabaseHandle,
  QueryResult,
  EngineDriver,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  StreamOptions,
  SchemaInfo,
  MssqlVersion,
} from '../types';
import _ from 'lodash';

// ---- Type mapping (ES type → NocoBase field options) ----

function mapMssqlType(msType: string): Pick<FieldOptions, 'type' | 'interface' | 'uiSchema'> {
  const base = msType.replace(/\(.*\)/, '').toLowerCase();

  switch (base) {
    // Strings
    case 'varchar':
    case 'nvarchar':
    case 'char':
    case 'nchar':
      return { type: 'string', interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input' } };
    case 'text':
    case 'ntext':
      return { type: 'text', interface: 'textarea', uiSchema: { type: 'string', 'x-component': 'Input.TextArea' } };
    case 'xml':
      return { type: 'text', interface: 'textarea', uiSchema: { type: 'string', 'x-component': 'Input.TextArea' } };

    // Integers
    case 'int':
    case 'smallint':
    case 'tinyint':
      return { type: 'integer', interface: 'integer', uiSchema: { type: 'number', 'x-component': 'InputNumber' } };
    case 'bigint':
      return { type: 'bigInt', interface: 'integer', uiSchema: { type: 'number', 'x-component': 'InputNumber' } };

    // Decimals
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
    case 'float':
    case 'real':
      return { type: 'float', interface: 'number', uiSchema: { type: 'number', 'x-component': 'InputNumber' } };

    // Boolean
    case 'bit':
      return { type: 'boolean', interface: 'checkbox', uiSchema: { type: 'boolean', 'x-component': 'Checkbox' } };

    // Date/Time
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
      return { type: 'datetimeNoTz', interface: 'datetime', uiSchema: { type: 'string', 'x-component': 'DatePicker' } };
    case 'datetimeoffset':
      return { type: 'datetimeTz', interface: 'datetime', uiSchema: { type: 'string', 'x-component': 'DatePicker' } };
    case 'date':
      return { type: 'dateOnly', interface: 'date', uiSchema: { type: 'string', 'x-component': 'DatePicker' } };
    case 'time':
      return { type: 'time', interface: 'time', uiSchema: { type: 'string', 'x-component': 'TimePicker' } };

    // UUID
    case 'uniqueidentifier':
      return { type: 'uuid', interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input' } };

    // Binary
    case 'binary':
    case 'varbinary':
    case 'image':
      return { type: 'string', interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input' } };

    default:
      return { type: 'string', interface: 'input', uiSchema: { type: 'string', 'x-component': 'Input' } };
  }
}

function columnToFieldOptions(col: ColumnInfo): FieldOptions {
  const mapped = mapMssqlType(col.dataType);
  return {
    name: col.columnName,
    field: col.columnName,
    rawType: col.dataType,
    type: mapped.type,
    interface: mapped.interface,
    allowNull: col.notNull === false ? false : true,
    primaryKey: col.isPrimaryKey || false,
    autoIncrement: col.autoIncrement || false,
    defaultValue: col.defaultValue,
    uiSchema: {
      ...mapped.uiSchema,
      title: col.columnName,
    },
  };
}

// ---- Data Source Options ----

export type MssqlDataSourceOptions = MssqlConnectionOptions & {
  name?: string;
  displayName?: string;
  addAllCollections?: boolean;
  selectedCollections?: string[];
  collections?: any[];
  logger?: Logger;
  /** Maximum connections in the pool (default 5) */
  poolMaxSize?: number;
  [key: string]: any;
};

// ---- Driver implementation ----

function createDriver(): EngineDriver {
  return {
    engine: 'mssql-v2@nocobase',
    title: 'Microsoft SQL Server (V2)',
    defaultPort: 1433,
    defaultAuthTypeName: 'tedious',
    supportsTransactions: true,
    isolationLevels: ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SNAPSHOT', 'SERIALIZABLE'],
    defaultIsolationLevel: 'READ COMMITTED',
    supportsIncrementalAnalysis: false,
    dialect,
    dialectByVersion,
    analyserClass: MsSqlAnalyser,

    ...driverBaseMethods,

    async connect(conn: MssqlConnectionOptions): Promise<DatabaseHandle> {
      const { authType } = conn;
      const isWindows = process.platform === 'win32';
      const useNative = isWindows && (authType === 'sspi' || authType === 'sql');

      if (useNative) {
        try {
          return await nativeConnect(conn);
        } catch {
          // Fall back to tedious if native fails
        }
      }
      return tediousConnect(conn);
    },

    async close(dbhan: DatabaseHandle): Promise<void> {
      try {
        await dbhan.client.close();
      } catch {
        // Ignore close errors
      }
    },

    async query(dbhan: DatabaseHandle, sql: string, options?: any): Promise<QueryResult> {
      if (dbhan.connectionType === 'msnodesqlv8') {
        return nativeQueryCore(dbhan, sql, options);
      }
      return tediousQueryCore(dbhan, sql, options);
    },

    stream(dbhan: DatabaseHandle, sql: string, options: StreamOptions): void {
      if (dbhan.connectionType === 'msnodesqlv8') {
        return nativeStream(dbhan, sql, options);
      }
      return tediousStream(dbhan, sql, options);
    },

    async readQuery(dbhan: DatabaseHandle, sql: string, structure?: any): Promise<any> {
      if (dbhan.connectionType === 'msnodesqlv8') {
        return nativeReadQuery(dbhan, sql, structure);
      }
      return tediousReadQuery(dbhan, sql, structure);
    },

    async getVersion(dbhan: DatabaseHandle): Promise<MssqlVersion> {
      const res = (await this.query(dbhan, VERSION_QUERY)).rows[0] as Record<string, any>;

      if (res?.productVersion) {
        const splitted = String(res.productVersion).split('.');
        const number = parseInt(splitted[0]) || 0;
        (res as any).productVersionNumber = number;
      } else if (res) {
        (res as any).productVersionNumber = 0;
      }

      return res as unknown as MssqlVersion;
    },

    async listDatabases(dbhan: DatabaseHandle): Promise<{ name: string }[]> {
      const { rows } = await this.query(dbhan, 'SELECT name FROM sys.databases ORDER BY name');
      return rows;
    },

    async listSchemas(dbhan: DatabaseHandle): Promise<SchemaInfo[] | null> {
      const { rows } = await this.query(
        dbhan,
        'SELECT schema_id AS objectId, name AS schemaName FROM sys.schemas',
      );
      const defaultSchemaRes = await this.query(dbhan, 'SELECT SCHEMA_NAME() as name');
      const defaultSchema = defaultSchemaRes.rows[0]?.name;

      return rows.map((x: any) => ({
        ...x,
        isDefault: x.schemaName === defaultSchema,
      }));
    },

    getAuthTypes() {
      const res: any[] = [];
      if (process.platform === 'win32') {
        res.push(
          { title: 'Windows (SSPI)', name: 'sspi', disabledFields: ['password', 'port', 'user'] },
          { title: 'SQL Server (Native)', name: 'sql', disabledFields: ['port'] },
        );
      }
      res.push({ title: 'SQL Server (tedious)', name: 'tedious' });
      return res;
    },
  };
}

// ---- Main DataSource Class ----

export class MssqlDataSource extends DataSource {
  private pool: ConnectionPool | null = null;
  private driver: EngineDriver;
  private _version: MssqlVersion | null = null;

  declare logger: Logger;
  declare collectionManager: MssqlCollectionManager;

  constructor(public options: MssqlDataSourceOptions) {
    super(options);
    this.driver = createDriver();
  }

  get name(): string {
    return this.options.name || 'mssql-v2';
  }

  createCollectionManager(_options: any = {}): MssqlCollectionManager {
    return new MssqlCollectionManager({
      dataSource: this,
      driver: this.driver,
    });
  }

  /**
   * Build connection options from the data source config.
   */
  private buildConnectionOptions(): MssqlConnectionOptions {
    return {
      server: this.options.server || this.options.host,
      host: this.options.host,
      port: this.options.port,
      user: this.options.user || this.options.username,
      username: this.options.username,
      password: this.options.password,
      database: this.options.database,
      authType: this.options.authType || 'tedious',
      accessToken: this.options.accessToken,
      windowsDomain: this.options.windowsDomain,
      ssl: this.options.ssl,
      trustServerCertificate: this.options.trustServerCertificate,
      encrypt: this.options.encrypt,
    };
  }

  /**
   * Ensure the connection pool is initialized and a first connection succeeds.
   */
  private async ensurePool(): Promise<ConnectionPool> {
    if (this.pool) return this.pool;

    const connOptions = this.buildConnectionOptions();
    const poolSize = this.options.poolMaxSize ?? 5;

    this.pool = new ConnectionPool(
      connOptions,
      (opts, logger) => this.driver.connect(opts),
      poolSize,
      this.logger,
    );

    // Verify connectivity by making an initial connection, then release it
    let dbhan: DatabaseHandle | null = null;
    try {
      dbhan = await this.pool.acquire();
      this._version = await this.driver.getVersion(dbhan);
      this.logger?.info?.(
        `[MSSQL-V2] Connected to ${this._version.versionText || 'SQL Server'} (${this._version.productVersion})`,
      );
    } catch (error) {
      // Pool verification failed — clean up
      await this.pool.closeAll();
      this.pool = null;
      throw error;
    } finally {
      if (dbhan) this.pool.release(dbhan);
    }

    return this.pool;
  }

  /**
   * Load the data source: connect, introspect, and define collections.
   */
  async load(options: { localData?: Record<string, any> } = {}): Promise<void> {
    const pool = await this.ensurePool();

    // Acquire a dedicated connection for the analysis session
    const dbhan = await pool.acquire();
    try {
      // Introspect database structure
      let dbInfo: DatabaseInfo;
      try {
        dbInfo = await this.driver.analyseFull(dbhan, this._version);
        this.logger?.info?.(
          `[MSSQL-V2] Loaded ${dbInfo.tables?.length || 0} tables, ` +
            `${dbInfo.views?.length || 0} views, ${dbInfo.procedures?.length || 0} procedures`,
        );
      } catch (error) {
        this.logger?.error?.('[MSSQL-V2] Failed to introspect database:', error);
        throw error;
      }

      // Define collections for each table
      const schema = this.options.schema || 'dbo';
      let loaded = 0;
      const total = dbInfo.tables?.length || 0;

      for (const table of dbInfo.tables || []) {
        try {
          const collectionOptions = this.tableToCollectionOptions(table, schema, options.localData?.[table.pureName]);
          this.collectionManager.defineCollection(collectionOptions);
          loaded++;
          this.emitLoadingProgress({ total, loaded });
        } catch (error) {
          this.logger?.error?.(`[MSSQL-V2] Failed to define collection for table ${table.pureName}:`, error);
        }
      }

      this.logger?.info?.(`[MSSQL-V2] Successfully loaded ${loaded}/${total} collections`);
    } finally {
      pool.release(dbhan);
    }
  }

  /**
   * Convert a dbgate TableInfo to a NocoBase CollectionOptions.
   */
  private tableToCollectionOptions(
    table: TableInfo,
    schema: string,
    localOptions?: any,
  ): CollectionOptions {
    const fields: FieldOptions[] = table.columns.map((col) => {
      // Mark primary key columns
      const isPk = table.primaryKey?.columns?.some((pk) => pk.columnName === col.columnName);
      return {
        ...columnToFieldOptions({ ...col, isPrimaryKey: isPk || col.isPrimaryKey }),
      };
    });

    // Determine filter target key
    const pkColumns = table.primaryKey?.columns?.map((c) => c.columnName) || [];
    const filterTargetKey = pkColumns.length === 1 ? pkColumns[0] : pkColumns.length > 1 ? pkColumns : '_id';

    const base: CollectionOptions = {
      name: table.pureName,
      tableName: table.pureName,
      title: table.objectComment || table.pureName,
      schema,
      fields,
      filterTargetKey,
      repository: 'mssql-v2-repo',
      timestamps: false,
      introspected: true,
      simplePaginate: true,
    };

    // Merge with local persisted options if available
    if (localOptions) {
      return { ...base, ...localOptions, name: base.name, tableName: base.tableName, fields: base.fields };
    }

    return base;
  }

  /**
   * Read all tables from the external database.
   */
  async readTables(): Promise<{ name: string }[]> {
    await this.ensurePool();
    const { rows } = await this.executeQuery(
      `SELECT o.name FROM sys.tables o
       INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
       WHERE s.name = '${this.options.schema || 'dbo'}'
       ORDER BY o.name`,
    );
    return rows.map((r: any) => ({ name: r.name }));
  }

  /**
   * Load specific tables from the external database.
   */
  async loadTables(ctx: Context, tables: string[]): Promise<void> {
    await this.ensurePool();
    const schema = this.options.schema || 'dbo';

    // Acquire a dedicated connection for the analysis session
    const dbhan = await this.pool!.acquire();
    try {
      for (const tableName of tables) {
        try {
          const analyser = new MsSqlAnalyser(dbhan, this.driver, this._version);
          const tableInfo = await analyser.singleObjectAnalysis(
            { pureName: tableName, schemaName: schema },
            'tables',
          );

          if (!tableInfo) {
            this.logger?.warn?.(`[MSSQL-V2] Table ${tableName} not found in schema ${schema}`);
            continue;
          }

          const collectionOptions = this.tableToCollectionOptions(tableInfo, schema);
          this.collectionManager.defineCollection(collectionOptions);
          this.logger?.debug?.(`[MSSQL-V2] Loaded table ${tableName} as collection`);
        } catch (error) {
          this.logger?.error?.(`[MSSQL-V2] Failed to load table ${tableName}:`, error);
          throw error;
        }
      }
    } finally {
      this.pool!.release(dbhan);
    }
  }

  /**
   * Return public connection options (safe to expose to client).
   */
  publicOptions(): Record<string, any> {
    return {
      server: this.options.server || this.options.host,
      port: this.options.port,
      username: this.options.user || this.options.username,
      database: this.options.database,
      schema: this.options.schema,
      authType: this.options.authType,
      encrypt: this.options.encrypt,
      isExternal: true,
      isDBInstance: true,
    };
  }

  /**
   * Close the connection pool.
   */
  async close(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.closeAll();
      } catch (error) {
        this.logger?.warn?.('[MSSQL-V2] Error closing connection pool:', error);
      }
      this.pool = null;
    }
  }

  /**
   * Test a connection with the given options.
   * Uses a single temporary connection (not the pool).
   */
  static async testConnection(options?: MssqlDataSourceOptions): Promise<boolean> {
    if (!options) {
      throw new Error('Connection options are required to test MSSQL connectivity');
    }

    if (!options.host && !options.server) {
      throw new Error('Host is required to test the connection');
    }

    if (!options.database) {
      throw new Error('Database name is required to test the connection');
    }

    const driver = createDriver();

    const connOptions: MssqlConnectionOptions = {
      server: options.server || options.host,
      host: options.host,
      port: options.port,
      user: options.user || options.username,
      username: options.username,
      password: options.password,
      database: options.database,
      authType: options.authType || 'tedious',
    };

    let dbhan: DatabaseHandle | null = null;
    try {
      dbhan = await driver.connect(connOptions);
      const version = await driver.getVersion(dbhan);
      if (!version || !version.version) {
        throw new Error('Unable to retrieve SQL Server version');
      }
      return true;
    } catch (error: any) {
      throw new Error(`Failed to connect to MSSQL: ${error.message}`);
    } finally {
      if (dbhan) {
        try {
          await driver.close(dbhan);
        } catch {
          // Ignore close errors during test
        }
      }
    }
  }

  /**
   * Execute a raw SQL query against the MSSQL connection.
   * Acquires a connection from the pool, runs the query, and releases it.
   * Used by the repository layer.
   */
  async executeQuery(sql: string, options?: any): Promise<QueryResult> {
    await this.ensurePool();
    const dbhan = await this.pool!.acquire();
    try {
      const result = await this.driver.query(dbhan, sql, options);
      this.pool!.release(dbhan);
      return result;
    } catch (error: any) {
      // Mark connection as broken on network/connection errors
      this.pool!.markBroken(dbhan);
      throw error;
    }
  }

  /**
   * Get the driver instance.
   */
  getDriver(): EngineDriver {
    return this.driver;
  }

  /**
   * Get the connection pool (for analyser sessions, etc.).
   */
  getPool(): ConnectionPool | null {
    return this.pool;
  }
}

export default MssqlDataSource;
