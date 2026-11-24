// SPDX-License-Identifier: Apache-2.0

import { DatabaseIntrospector } from '@nocobase/data-source-manager';
import { tableInfo } from '@nocobase/data-source-manager';
import { QueryTypes } from 'sequelize';
import {
  buildBulkColumnsSql,
  buildBulkIndexesSql,
  groupColumnsByTable,
  groupIndexesByTable,
  type MssqlBulkColumnRow,
  type MssqlBulkIndexRow,
  type MssqlShowIndexEntry,
  type MssqlTableColumns,
} from './mssql-bulk-introspection';

const ANSI_STRING_TYPE_RE = /^(?:VAR)?CHAR(?:\(|$)/i;

/**
 * MSSQL field type → NocoBase field type mapping.
 * Keys are lowercase SQL Server type names (without length/precision).
 */
const mssqlFieldTypeMap: Record<string, string | string[]> = {
  // String types
  varchar: ['string', 'uuid', 'nanoid'],
  nvarchar: ['string', 'uuid', 'nanoid'],
  char: ['string', 'uuid', 'nanoid'],
  nchar: ['string', 'uuid', 'nanoid'],
  text: 'text',
  ntext: 'text',

  // Numeric types
  int: ['integer', 'sort'],
  smallint: ['integer', 'boolean', 'sort'],
  tinyint: ['integer', 'boolean', 'sort'],
  bigint: ['bigInt', 'sort'],
  decimal: 'decimal',
  numeric: 'decimal',
  float: 'float',
  real: 'float',
  money: 'decimal',
  smallmoney: 'decimal',

  // Date/time types
  datetime: 'datetimeNoTz',
  datetime2: 'datetimeNoTz',
  smalldatetime: 'datetimeNoTz',
  datetimeoffset: 'datetimeTz',
  date: 'dateOnly',
  time: 'time',

  // Boolean
  bit: 'boolean',

  // UUID
  uniqueidentifier: 'uuid',

  // Binary
  varbinary: 'string',
  binary: 'string',
  image: 'string',

  // XML
  xml: 'text',
};

interface PrimaryKeyRow {
  table_name: string;
  column_name: string;
}

interface FtsColumnRow {
  table_name: string;
  column_name: string;
}

export class MssqlIntrospector extends DatabaseIntrospector {
  /** Cache of { tableName → pk column names[] } loaded by preloadAllPrimaryKeys() */
  private primaryKeyCache: Map<string, string[]> | null = null;
  private primaryKeyCacheFullSchema = false;
  private primaryKeyCacheSchema: string | null = null;

  /**
   * Cache of { tableName → describeTable-compatible column map } loaded in ONE
   * query by preloadAllColumns(). When present, getTableColumnsInfo() serves column
   * metadata from memory instead of a per-table describeTable() call.
   */
  private columnsCache: Map<string, MssqlTableColumns> | null = null;
  private columnsCacheSchema: string | null = null;

  /**
   * Cache of { tableName → Sequelize showIndex-compatible entries } loaded in ONE
   * query by preloadAllIndexes(). Eliminates per-table EXEC sys.sp_helpindex calls.
   */
  private indexesCache: Map<string, MssqlShowIndexEntry[]> | null = null;
  private indexesCacheFullSchema = false;
  private indexesCacheSchema: string | null = null;

  /**
   * Cache of { tableName → Set<columnName> } for columns with enabled Full-Text Search indexes.
   * null = not yet loaded; empty Map = loaded but no FTS columns found (or FTS not installed).
   */
  private ftsColumnCache: Map<string, Set<string>> | null = null;

  /**
   * Cache of { tableName → Set<columnName> } for non-Unicode ANSI string columns (`VARCHAR`, `CHAR`).
   * Used by MSSQL filter operators to avoid `N'...'` literals that trigger `CONVERT_IMPLICIT` scans.
   */
  private ansiStringColumnsCache: Map<string, Set<string>> = new Map();

  /**
   * Cache of { objectName → isView } populated from `getViewList()`, bulk `preloadAllColumns()`,
   * or single-object `sys.views` lookups so views are registered as read-only `ViewCollection`s.
   */
  private viewStatusCache: Map<string, boolean> | null = null;
  private viewStatusCacheFullSchema = false;
  private viewStatusCacheSchema: string | null = null;

  protected getFieldTypeMap(): Record<string, string | string[]> {
    return mssqlFieldTypeMap;
  }

  private recordAnsiStringColumns(tableName: string, columns: Record<string, { type?: string }>): void {
    const ansiCols = new Set<string>();
    for (const [colName, colMeta] of Object.entries(columns)) {
      if (typeof colMeta?.type === 'string' && ANSI_STRING_TYPE_RE.test(colMeta.type.trim())) {
        ansiCols.add(colName);
      }
    }
    this.ansiStringColumnsCache.set(tableName, ansiCols);
  }

  /**
   * Returns true if the given physical column is a non-Unicode `VARCHAR` or `CHAR` column.
   */
  isAnsiStringColumn(tableName: string, columnName: string): boolean {
    return this.ansiStringColumnsCache.get(tableName)?.has(columnName) ?? false;
  }

  /**
   * Clear all introspected schema caches (called on full data source reload/refresh).
   */
  clearCache(): void {
    this.primaryKeyCache = null;
    this.primaryKeyCacheFullSchema = false;
    this.primaryKeyCacheSchema = null;
    this.columnsCache = null;
    this.columnsCacheSchema = null;
    this.indexesCache = null;
    this.indexesCacheFullSchema = false;
    this.indexesCacheSchema = null;
    this.ftsColumnCache = null;
    this.ansiStringColumnsCache.clear();
    this.viewStatusCache = null;
    this.viewStatusCacheFullSchema = false;
    this.viewStatusCacheSchema = null;
  }

  /**
   * Invalidate cached metadata for specific tables so reloading a single table picks up altered
   * columns/PKs/indexes and newly created tables are never masked by a prior full-schema snapshot.
   */
  invalidateTables(tableNames?: string[]): void {
    if (!tableNames) {
      this.clearCache();
      return;
    }
    for (const name of tableNames) {
      this.columnsCache?.delete(name);
      this.primaryKeyCache?.delete(name);
      this.indexesCache?.delete(name);
      this.ftsColumnCache?.delete(name);
      this.ansiStringColumnsCache.delete(name);
      this.viewStatusCache?.delete(name);
    }
    this.primaryKeyCacheFullSchema = false;
    this.indexesCacheFullSchema = false;
    this.viewStatusCacheFullSchema = false;
  }

  /**
   * Load primary key info for tables in one query and cache the result.
   */
  async preloadAllPrimaryKeys(schemaName = 'dbo', tableNames?: string[]): Promise<void> {
    if (tableNames && !tableNames.length) {
      return;
    }
    try {
      const tableFilter = tableNames?.length
        ? `AND o.name IN (${tableNames.map((name) => this.db.sequelize.escape(name)).join(', ')})`
        : '';
      const sql = `
        SELECT o.name AS table_name, c.name AS column_name
        FROM sys.indexes i
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND c.column_id = ic.column_id
        INNER JOIN sys.objects o ON i.object_id = o.object_id
        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE i.is_primary_key = 1
          AND s.name = ${this.db.sequelize.escape(schemaName)}
          ${tableFilter}
        ORDER BY o.name, ic.key_ordinal
      `;
      const rows = (await this.db.sequelize.query(sql, { type: QueryTypes.SELECT })) as PrimaryKeyRow[];

      const canMerge = Boolean(tableNames && this.primaryKeyCache && this.primaryKeyCacheSchema === schemaName);
      const cache = canMerge && this.primaryKeyCache ? new Map(this.primaryKeyCache) : new Map<string, string[]>();
      if (tableNames) {
        for (const name of tableNames) {
          cache.set(name, []);
        }
      }
      for (const row of rows) {
        const tbl = row.table_name;
        const list = cache.get(tbl) ?? [];
        list.push(row.column_name);
        cache.set(tbl, list);
      }
      this.primaryKeyCache = cache;
      this.primaryKeyCacheSchema = schemaName;
      if (!tableNames) {
        this.primaryKeyCacheFullSchema = true;
      } else if (!canMerge) {
        this.primaryKeyCacheFullSchema = false;
      }
      this.db.logger?.debug?.(`[MSSQL] Preloaded PK info for ${cache.size} tables`);
    } catch (err) {
      this.db.logger?.warn?.('[MSSQL] Failed to preload primary keys, will fall back to per-table query:', err);
      if (!tableNames) {
        this.primaryKeyCache = null;
        this.primaryKeyCacheFullSchema = false;
        this.primaryKeyCacheSchema = null;
      }
    }
  }

  /**
   * Load column metadata for tables and views in the schema in ONE bulk query and cache it.
   */
  async preloadAllColumns(schemaName = 'dbo', tableNames?: string[]): Promise<void> {
    if (tableNames && !tableNames.length) {
      return;
    }
    try {
      const rows = (await this.db.sequelize.query(buildBulkColumnsSql(schemaName, tableNames), {
        type: QueryTypes.SELECT,
      })) as MssqlBulkColumnRow[];

      const grouped = groupColumnsByTable(rows);
      if (tableNames && this.columnsCache && this.columnsCacheSchema === schemaName) {
        for (const [tbl, cols] of grouped.entries()) {
          this.columnsCache.set(tbl, cols);
          this.recordAnsiStringColumns(tbl, cols);
        }
      } else {
        this.columnsCache = grouped;
        this.columnsCacheSchema = schemaName;
        for (const [tbl, cols] of grouped.entries()) {
          this.recordAnsiStringColumns(tbl, cols);
        }
      }

      const hasObjectType = rows.some(
        (row) => typeof row.object_type === 'string' && row.object_type.trim().length > 0,
      );
      if (hasObjectType) {
        const canMergeView = Boolean(tableNames && this.viewStatusCache && this.viewStatusCacheSchema === schemaName);
        const viewCache =
          canMergeView && this.viewStatusCache ? new Map(this.viewStatusCache) : new Map<string, boolean>();
        for (const row of rows) {
          if (typeof row.object_type === 'string') {
            viewCache.set(row.table_name, row.object_type.trim().toUpperCase() === 'V');
          }
        }
        this.viewStatusCache = viewCache;
        this.viewStatusCacheSchema = schemaName;
        if (!tableNames) {
          this.viewStatusCacheFullSchema = true;
        } else if (!canMergeView) {
          this.viewStatusCacheFullSchema = false;
        }
      }
      this.db.logger?.debug?.(`[MSSQL] Preloaded column metadata for ${grouped.size} objects`);
    } catch (err) {
      this.db.logger?.warn?.('[MSSQL] Failed to bulk-preload columns, will fall back to per-table describeTable:', err);
      if (!tableNames) {
        this.columnsCache = null;
        this.columnsCacheSchema = null;
      }
    }
  }

  /**
   * Load index metadata for tables and views in ONE query so getTableConstraints() does not run
   * per-table `EXEC sys.sp_helpindex` round trips.
   */
  async preloadAllIndexes(schemaName = 'dbo', tableNames?: string[]): Promise<void> {
    if (tableNames && !tableNames.length) {
      return;
    }
    try {
      const rows = (await this.db.sequelize.query(buildBulkIndexesSql(schemaName, tableNames), {
        type: QueryTypes.SELECT,
      })) as MssqlBulkIndexRow[];

      const grouped = groupIndexesByTable(rows);
      const canMerge = Boolean(tableNames && this.indexesCache && this.indexesCacheSchema === schemaName);
      const cache =
        canMerge && this.indexesCache ? new Map(this.indexesCache) : new Map<string, MssqlShowIndexEntry[]>();
      if (tableNames) {
        for (const name of tableNames) {
          cache.set(name, grouped.get(name) ?? []);
        }
      } else {
        for (const [tbl, entries] of grouped.entries()) {
          cache.set(tbl, entries);
        }
      }
      this.indexesCache = cache;
      this.indexesCacheSchema = schemaName;
      if (!tableNames) {
        this.indexesCacheFullSchema = true;
      } else if (!canMerge) {
        this.indexesCacheFullSchema = false;
      }
      this.db.logger?.debug?.(`[MSSQL] Preloaded index metadata for ${grouped.size} tables`);
    } catch (err) {
      this.db.logger?.warn?.('[MSSQL] Failed to bulk-preload indexes, will fall back to sp_helpindex:', err);
      if (!tableNames) {
        this.indexesCache = null;
        this.indexesCacheFullSchema = false;
        this.indexesCacheSchema = null;
      }
    }
  }

  /**
   * Load enabled Full-Text Search index info in one query and cache the result.
   * Joins `sys.fulltext_indexes` with `is_enabled = 1` so disabled FTS indexes never trigger Msg 7601.
   */
  async preloadFTSIndexedColumns(
    schemaName = 'dbo',
    tableNames?: string[],
    options: { merge?: boolean } = {},
  ): Promise<void> {
    if (tableNames && !tableNames.length) {
      if (!options.merge) {
        this.ftsColumnCache = new Map();
      }
      return;
    }
    try {
      const sql = `
        SELECT t.name AS table_name, c.name AS column_name
        FROM sys.fulltext_index_columns fic
        INNER JOIN sys.fulltext_indexes fi ON fic.object_id = fi.object_id AND fi.is_enabled = 1
        INNER JOIN sys.columns c ON fic.object_id = c.object_id AND fic.column_id = c.column_id
        INNER JOIN sys.tables t ON fic.object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = ${this.db.sequelize.escape(schemaName)}
        ${tableNames ? `AND t.name IN (${tableNames.map((name) => this.db.sequelize.escape(name)).join(', ')})` : ''}
      `;
      const rows = (await this.db.sequelize.query(sql, { type: QueryTypes.SELECT })) as FtsColumnRow[];

      const cache =
        options.merge && this.ftsColumnCache ? new Map(this.ftsColumnCache) : new Map<string, Set<string>>();
      if (options.merge && tableNames) {
        for (const name of tableNames) {
          cache.delete(name);
        }
      }
      for (const row of rows) {
        const tbl = row.table_name;
        const set = cache.get(tbl) ?? new Set<string>();
        set.add(row.column_name);
        cache.set(tbl, set);
      }
      this.ftsColumnCache = cache;
      this.db.logger?.debug?.(`[MSSQL] Preloaded enabled FTS index info for ${cache.size} tables`);
    } catch (err) {
      // FTS may not be installed on this SQL Server instance — that's fine, fall back to LIKE
      this.db.logger?.debug?.('[MSSQL] FTS preload skipped (FTS not installed or insufficient permissions):', err);
      if (!options.merge) {
        this.ftsColumnCache = new Map();
      }
    }
  }

  /**
   * Returns true if the given column has an enabled Full-Text Search index.
   * Preserved for introspection diagnostics; `$includes` / `$notIncludes` always use substring LIKE so reads and writes match.
   */
  hasFTSIndex(tableName: string, columnName: string): boolean {
    if (!this.ftsColumnCache) return false;
    return this.ftsColumnCache.get(tableName)?.has(columnName) ?? false;
  }

  /** List only tables in the configured schema; names are relative to that schema. */
  async getTableList(): Promise<string[]> {
    const rows = await this.db.sequelize.query<{ name: string }>(
      'SELECT t.name AS name FROM sys.tables t INNER JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = :schema',
      { replacements: { schema: this.db.options.schema || 'dbo' }, type: QueryTypes.SELECT },
    );
    return rows.map((row) => row.name);
  }

  /**
   * Override getTableColumnsInfo to handle MSSQL-specific column metadata.
   * Adds PK detection fallback via sys.indexes query and records ANSI string columns.
   */
  async getTableColumnsInfo(tableInfo: tableInfo) {
    const tableName = typeof tableInfo === 'string' ? tableInfo : tableInfo.tableName;
    const defaultSchema = this.db.options?.schema || 'dbo';
    const schemaName = typeof tableInfo === 'string' ? defaultSchema : tableInfo.schema || defaultSchema;
    const cached = this.columnsCacheSchema === schemaName ? this.columnsCache?.get(tableName) : undefined;

    // Serve from the bulk-preloaded cache when available (anti-N+1 path); otherwise
    // fall back to a per-table describeTable() call. Clone the cached map so per-table
    // PK/default mutations below never leak back into the shared cache.
    const columns = cached
      ? (Object.fromEntries(Object.entries(cached).map(([k, v]) => [k, { ...v }])) as typeof cached)
      : await this.db.sequelize.getQueryInterface().describeTable(tableInfo);

    this.recordAnsiStringColumns(tableName, columns as Record<string, { type?: string }>);

    // Check if any column is already marked as PK
    const hasPrimaryKey = Object.values(columns).some((col) => Boolean((col as { primaryKey?: boolean }).primaryKey));

    if (!hasPrimaryKey) {
      let pkColumns: string[] | undefined;

      const primaryKeyCache = this.primaryKeyCache;
      const hasCachedPk =
        primaryKeyCache !== null &&
        this.primaryKeyCacheSchema === schemaName &&
        (this.primaryKeyCacheFullSchema || primaryKeyCache.has(tableName));

      if (hasCachedPk) {
        pkColumns = primaryKeyCache.get(tableName);
      } else {
        try {
          const pkSql = `
            SELECT c.name AS column_name
            FROM sys.indexes i
            INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            INNER JOIN sys.columns c ON ic.object_id = c.object_id AND c.column_id = ic.column_id
            INNER JOIN sys.objects o ON i.object_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE i.is_primary_key = 1
              AND o.name = ${this.db.sequelize.escape(tableName)}
              AND s.name = ${this.db.sequelize.escape(schemaName)}
          `;
          const pkResult = (await this.db.sequelize.query(pkSql, { type: QueryTypes.SELECT })) as Array<{
            column_name: string;
          }>;
          pkColumns = pkResult?.map((row) => row.column_name);
          if (this.primaryKeyCache && this.primaryKeyCacheSchema === schemaName) {
            this.primaryKeyCache.set(tableName, pkColumns ?? []);
          }
        } catch (err) {
          this.db.logger?.warn?.(`[MSSQL] Failed to query PK for ${tableName}:`, err);
        }
      }

      if (pkColumns?.length) {
        for (const colName of pkColumns) {
          if (columns[colName]) {
            (columns[colName] as { primaryKey: boolean }).primaryKey = true;
          }
        }
      }
    }

    // Do NOT synthesize a fake PK on a non-unique `id` column: core DatabaseIntrospector already
    // handles view filterTargetKey separately, and fabricating primaryKey=true on a physical table
    // without a real PK allows update/destroy by filterByTk to mutate multiple rows.

    // Clean up MSSQL-specific default values (SQL expressions like `(newid())`, `(getdate())`, `((0))`) while
    // preserving database-default optionality (`allowNull = true`) before `DatabaseIntrospector.columnAttribute` runs.
    for (const col of Object.values(columns)) {
      const typedCol = col as { defaultValue?: unknown; allowNull?: boolean };
      const rawDefault = typedCol.defaultValue;
      if (rawDefault && typeof rawDefault === 'string' && rawDefault.startsWith('(') && rawDefault.endsWith(')')) {
        const innerDefault = rawDefault.replace(/^\(+|\)+$/g, '').trim();
        if (innerDefault.length > 0 && innerDefault.toUpperCase() !== 'NULL') {
          typedCol.allowNull = true;
        }
        typedCol.defaultValue = undefined;
      }
    }

    return columns;
  }

  /**
   * Override getTableConstraints to serve from the bulk-preloaded index cache when available,
   * falling back to a single-table `sys.indexes` query (excluding filtered and disabled indexes)
   * when not preloaded.
   */
  async getTableConstraints(tableInfo: tableInfo) {
    const name = typeof tableInfo === 'string' ? tableInfo : tableInfo.tableName;
    const defaultSchema = this.db.options?.schema || 'dbo';
    const schema = typeof tableInfo === 'string' ? defaultSchema : tableInfo.schema || defaultSchema;
    const indexesCache = this.indexesCache;
    const hasCachedIndexes =
      indexesCache !== null &&
      this.indexesCacheSchema === schema &&
      (this.indexesCacheFullSchema || indexesCache.has(name));
    if (hasCachedIndexes) {
      return indexesCache.get(name) ?? [];
    }

    try {
      const rows = (await this.db.sequelize.query(buildBulkIndexesSql(schema, [name]), {
        type: QueryTypes.SELECT,
      })) as MssqlBulkIndexRow[];
      const indexes = groupIndexesByTable(rows).get(name) ?? [];
      if (this.indexesCache && this.indexesCacheSchema === schema) {
        this.indexesCache.set(name, indexes);
      }
      return indexes;
    } catch (err) {
      this.db.logger?.warn?.(`[MSSQL] Failed to get indexes for ${name}:`, err);
      return [];
    }
  }

  /** List only views in the configured schema; the generic MSSQL query interface has no listViews. */
  async getViewList(): Promise<string[]> {
    const schema = this.db.options.schema || 'dbo';
    const rows = await this.db.sequelize.query<{ name: string }>(
      'SELECT v.name AS name FROM sys.views v INNER JOIN sys.schemas s ON s.schema_id = v.schema_id WHERE s.name = :schema',
      { replacements: { schema }, type: QueryTypes.SELECT },
    );
    const names = rows.map((row) => row.name);
    this.viewStatusCache = new Map(names.map((name) => [name, true]));
    this.viewStatusCacheSchema = schema;
    this.viewStatusCacheFullSchema = true;
    return names;
  }

  /**
   * Returns true if the given SQL Server object is a view (`sys.views`), using the cached schema
   * metadata when available and falling back to a lightweight single-object query otherwise.
   */
  async isView(tableInfo: tableInfo): Promise<boolean> {
    const tableName = typeof tableInfo === 'string' ? tableInfo : tableInfo.tableName;
    const defaultSchema = this.db.options?.schema || 'dbo';
    const schema = typeof tableInfo === 'string' ? defaultSchema : tableInfo.schema || defaultSchema;

    if (this.viewStatusCache && this.viewStatusCacheSchema === schema) {
      if (this.viewStatusCache.has(tableName)) {
        return this.viewStatusCache.get(tableName) ?? false;
      }
      if (this.viewStatusCacheFullSchema) {
        return false;
      }
    }

    try {
      const rows = (await this.db.sequelize.query(
        'SELECT 1 AS is_view FROM sys.views v INNER JOIN sys.schemas s ON s.schema_id = v.schema_id WHERE s.name = :schema AND v.name = :tableName',
        { replacements: { schema, tableName }, type: QueryTypes.SELECT },
      )) as Array<{ is_view?: number }>;
      const result = Array.isArray(rows) && rows.length > 0;
      if (!this.viewStatusCache || this.viewStatusCacheSchema !== schema) {
        this.viewStatusCache = new Map();
        this.viewStatusCacheSchema = schema;
        this.viewStatusCacheFullSchema = false;
      }
      this.viewStatusCache.set(tableName, result);
      return result;
    } catch (err) {
      this.db.logger?.debug?.(`[MSSQL] Failed to check whether ${tableName} is a view:`, err);
      return false;
    }
  }

  /**
   * Override getCollection so SQL Server views carry view metadata (`view: true`, `viewName`,
   * `template: 'view'`, `writableView: false` unless explicitly enabled) and instantiate core's
   * read-only `ViewCollection`.
   */
  async getCollection(options: Parameters<DatabaseIntrospector['getCollection']>[0]) {
    const isViewObject = await this.isView(options.tableInfo);
    if (!isViewObject) {
      return await super.getCollection(options);
    }

    const tableName = typeof options.tableInfo === 'string' ? options.tableInfo : options.tableInfo.tableName;
    const localWritable = Boolean((options.localOptions as { writableView?: boolean } | undefined)?.writableView);
    return await super.getCollection({
      ...options,
      mergedOptions: {
        ...(options.mergedOptions || {}),
        view: true,
        viewName: tableName,
        template: 'view',
        writableView: localWritable,
      },
    });
  }
}
