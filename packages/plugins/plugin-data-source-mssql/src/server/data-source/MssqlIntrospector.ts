/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DatabaseIntrospector } from '@nocobase/data-source-manager';
import { tableInfo } from '@nocobase/data-source-manager';

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

export class MssqlIntrospector extends DatabaseIntrospector {
  /** Cache of { tableName → pk column names[] } loaded by preloadAllPrimaryKeys() */
  private primaryKeyCache: Map<string, string[]> | null = null;

  /**
   * Cache of { tableName → Set<columnName> } for columns with Full-Text Search indexes.
   * null = not yet loaded; empty Map = loaded but no FTS columns found (or FTS not installed).
   */
  private ftsColumnCache: Map<string, Set<string>> | null = null;

  protected getFieldTypeMap(): Record<string, string | string[]> {
    return mssqlFieldTypeMap;
  }

  /**
   * Load primary key info for ALL tables in one query and cache the result.
   * Call this once before starting the parallel introspection loop so that
   * getTableColumnsInfo() can use the cache instead of querying sys.indexes per table.
   */
  async preloadAllPrimaryKeys(schemaName = 'dbo'): Promise<void> {
    try {
      const sql = `
        SELECT o.name AS table_name, c.name AS column_name
        FROM sys.indexes i
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND c.column_id = ic.column_id
        INNER JOIN sys.objects o ON i.object_id = o.object_id
        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE i.is_primary_key = 1
          AND s.name = ${this.db.sequelize.escape(schemaName)}
        ORDER BY o.name, ic.key_ordinal
      `;
      const rows = (await this.db.sequelize.query(sql, { type: 'SELECT' })) as any[];

      const cache = new Map<string, string[]>();
      for (const row of rows) {
        const tbl = row.table_name as string;
        if (!cache.has(tbl)) cache.set(tbl, []);
        cache.get(tbl).push(row.column_name as string);
      }
      this.primaryKeyCache = cache;
      this.db.logger.debug(`[MSSQL] Preloaded PK info for ${cache.size} tables`);
    } catch (err) {
      this.db.logger.warn('[MSSQL] Failed to preload primary keys, will fall back to per-table query:', err);
      this.primaryKeyCache = null;
    }
  }

  /**
   * Load Full-Text Search index info for ALL columns in one query and cache the result.
   * Call this once before queries run so that text operators can route to CONTAINS() vs LIKE.
   */
  async preloadFTSIndexedColumns(schemaName = 'dbo'): Promise<void> {
    try {
      const sql = `
        SELECT t.name AS table_name, c.name AS column_name
        FROM sys.fulltext_index_columns fic
        INNER JOIN sys.columns c ON fic.object_id = c.object_id AND fic.column_id = c.column_id
        INNER JOIN sys.tables t ON fic.object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = ${this.db.sequelize.escape(schemaName)}
      `;
      const rows = (await this.db.sequelize.query(sql, { type: 'SELECT' })) as any[];

      const cache = new Map<string, Set<string>>();
      for (const row of rows) {
        const tbl = row.table_name as string;
        if (!cache.has(tbl)) cache.set(tbl, new Set<string>());
        cache.get(tbl).add(row.column_name as string);
      }
      this.ftsColumnCache = cache;
      this.db.logger.debug(`[MSSQL] Preloaded FTS index info for ${cache.size} tables`);
    } catch (err) {
      // FTS may not be installed on this SQL Server instance — that's fine, fall back to LIKE
      this.db.logger.debug('[MSSQL] FTS preload skipped (FTS not installed or insufficient permissions):', err);
      this.ftsColumnCache = new Map(); // empty = no FTS columns
    }
  }

  /**
   * Returns true if the given column has a Full-Text Search index.
   * Used by text operators to decide between CONTAINS() and LIKE.
   */
  hasFTSIndex(tableName: string, columnName: string): boolean {
    if (!this.ftsColumnCache) return false;
    return this.ftsColumnCache.get(tableName)?.has(columnName) ?? false;
  }

  /**
   * Override getTableList to handle MSSQL's object-format table names.
   * MSSQL's showAllTables() may return {tableName: 'Name', schema: 'dbo'} objects.
   */
  async getTableList(): Promise<string[]> {
    const tables = await this.db.sequelize.getQueryInterface().showAllTables();
    return tables.map((table: any) => {
      if (typeof table === 'string') {
        return table;
      }
      // Object format: {tableName: 'TableName', schema: 'dbo'}
      if (table && typeof table === 'object') {
        return table.tableName || table.name || String(Object.values(table).find((v) => typeof v === 'string'));
      }
      return String(table);
    });
  }

  /**
   * Override getTableColumnsInfo to handle MSSQL-specific column metadata.
   * Adds PK detection fallback via sys.indexes query.
   */
  async getTableColumnsInfo(tableInfo: tableInfo) {
    const columns = await this.db.sequelize.getQueryInterface().describeTable(tableInfo);

    // Check if any column is already marked as PK
    let hasPrimaryKey = Object.values(columns).some((col: any) => col.primaryKey);

    if (!hasPrimaryKey) {
      const tableName = typeof tableInfo === 'string' ? tableInfo : tableInfo.tableName;
      const schemaName = typeof tableInfo === 'string' ? 'dbo' : tableInfo.schema || 'dbo';
      let pkColumns: string[] | undefined;

      if (this.primaryKeyCache !== null) {
        // Use bulk-loaded cache (no extra query per table)
        pkColumns = this.primaryKeyCache.get(tableName);
      } else {
        // No cache available — fall back to per-table sys.indexes query
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
          const pkResult = (await this.db.sequelize.query(pkSql, { type: 'SELECT' })) as any[];
          pkColumns = pkResult?.map((row) => row.column_name as string);
        } catch (err) {
          this.db.logger.warn(`[MSSQL] Failed to query PK for ${tableName}:`, err);
        }
      }

      if (pkColumns?.length) {
        for (const colName of pkColumns) {
          if (columns[colName]) {
            (columns[colName] as any).primaryKey = true;
            hasPrimaryKey = true;
          }
        }
      }
    }

    // If still no PK, try 'id' column as fallback
    if (!hasPrimaryKey && columns['id']) {
      (columns['id'] as any).primaryKey = true;
    }

    // Clean up MSSQL-specific default values (SQL expressions like (newid()), ((0)))
    for (const [name, col] of Object.entries(columns)) {
      const rawDefault = (col as any).defaultValue;
      if (rawDefault && typeof rawDefault === 'string' && rawDefault.startsWith('(') && rawDefault.endsWith(')')) {
        // SQL expression default — clear it so Sequelize doesn't try to use it as a literal
        (col as any).defaultValue = undefined;
      }
    }

    return columns;
  }

  /**
   * Override getTableConstraints to handle MSSQL-specific index format.
   */
  async getTableConstraints(tableInfo: tableInfo) {
    try {
      const tableName = typeof tableInfo === 'string' ? tableInfo : tableInfo.tableName;
      return await this.db.sequelize.getQueryInterface().showIndex(tableName);
    } catch (err) {
      // MSSQL may not support showIndex well for all table types
      this.db.logger.warn(
        `[MSSQL] Failed to get indexes for ${typeof tableInfo === 'string' ? tableInfo : tableInfo.tableName}:`,
        err,
      );
      return [];
    }
  }

  /**
   * Override to handle MSSQL auto-increment detection.
   * MSSQL uses IDENTITY columns, not serial/nextval sequences.
   */
  protected columnAttribute(columnsInfo: any, columnName: string, indexes: any) {
    const attr = super.columnAttribute(columnsInfo, columnName, indexes);

    // MSSQL IDENTITY columns are already detected by Sequelize as autoIncrement
    // No need for nextval/uuid_generate_v4 checks (those are PostgreSQL-specific)

    return attr;
  }

  /**
   * Override getViewList — MSSQL view listing support
   */
  async getViewList(): Promise<string[]> {
    try {
      const views = await this.db.queryInterface.listViews();
      return views.map((view: any) => (typeof view === 'string' ? view : view.name || String(view)));
    } catch {
      // View listing may not be supported
      return [];
    }
  }
}
