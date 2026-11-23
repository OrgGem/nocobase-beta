// SPDX-License-Identifier: Apache-2.0

import { quoteUnicodeStringLiteral } from '../security/sql-quote';

/**
 * Shape of one row returned by the bulk column introspection query.
 * Mirrors what Sequelize's `describeTable()` produces per column so that
 * `getTableColumnsInfo()` can build a compatible `{ [columnName]: {...} }` map
 * entirely from memory, instead of one `sp_columns`-style round trip per table.
 */
export interface MssqlBulkColumnRow {
  table_name: string;
  object_type?: string;
  column_name: string;
  data_type: string;
  max_length: number;
  is_nullable: boolean;
  is_identity: boolean;
  default_value: string | null;
  column_comment: string | null;
}

/**
 * A single column's metadata, keyed under its table in the per-table cache.
 * This is the exact per-column shape Sequelize's MSSQL `describeTable()` returns.
 */
export interface MssqlDescribeColumn {
  type: string;
  allowNull: boolean;
  defaultValue: string | undefined;
  primaryKey: boolean;
  autoIncrement: boolean;
  comment: string | null;
}

export type MssqlTableColumns = Record<string, MssqlDescribeColumn>;

export interface MssqlBulkIndexRow {
  table_name: string;
  index_name: string;
  column_name: string;
  key_ordinal: number;
  is_primary_key: boolean;
  is_unique: boolean;
  is_descending_key: boolean;
}

export interface MssqlShowIndexEntry {
  name: string;
  primary: boolean;
  unique: boolean;
  fields: Array<{ attribute: string; order: 'ASC' | 'DESC' }>;
}

function buildTableNameFilter(tableNames?: string[], alias = 'o'): string {
  if (!tableNames || tableNames.length === 0) {
    return '';
  }
  const literals = tableNames.map((name) => quoteUnicodeStringLiteral(name)).join(', ');
  return `\n  AND ${alias}.name IN (${literals})`;
}

/**
 * Build the bulk column introspection SQL for tables and views in a schema (optionally scoped to
 * specific object names).
 *
 * Reads from `sys.objects` (`type IN ('U', 'V')`) + `sys.columns` + `sys.default_constraints` so
 * both tables and views load in one round trip and user-defined alias types resolve cleanly to
 * their underlying SQL Server system type.
 */
export function buildBulkColumnsSql(schemaName: string, tableNames?: string[]): string {
  const schema = quoteUnicodeStringLiteral(schemaName);
  const tableFilter = buildTableNameFilter(tableNames, 'o');
  return `
SELECT
  o.name AS table_name,
  o.type AS object_type,
  c.name AS column_name,
  COALESCE(st.name, t.name) AS data_type,
  c.max_length AS max_length,
  c.is_nullable AS is_nullable,
  c.is_identity AS is_identity,
  d.definition AS default_value,
  CAST(ep.value AS NVARCHAR(MAX)) AS column_comment
FROM sys.columns c
INNER JOIN sys.types t
  ON c.system_type_id = t.system_type_id AND c.user_type_id = t.user_type_id
LEFT JOIN sys.types st
  ON c.system_type_id = st.system_type_id AND st.user_type_id = st.system_type_id
INNER JOIN sys.objects o
  ON c.object_id = o.object_id
INNER JOIN sys.schemas u
  ON u.schema_id = o.schema_id
LEFT JOIN sys.default_constraints d
  ON c.default_object_id = d.object_id
LEFT JOIN sys.extended_properties ep
  ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description'
WHERE u.name = ${schema}
  AND o.type IN ('U', 'V')
  AND o.is_ms_shipped = 0${tableFilter}
ORDER BY o.name, c.column_id
`;
}

/**
 * Build the bulk index introspection SQL for tables and indexed views in a schema.
 * Eliminates per-table `EXEC sys.sp_helpindex` round trips during collection introspection.
 */
export function buildBulkIndexesSql(schemaName: string, tableNames?: string[]): string {
  const schema = quoteUnicodeStringLiteral(schemaName);
  const tableFilter = buildTableNameFilter(tableNames, 'o');
  return `
SELECT
  o.name AS table_name,
  i.name AS index_name,
  c.name AS column_name,
  ic.key_ordinal AS key_ordinal,
  i.is_primary_key AS is_primary_key,
  i.is_unique AS is_unique,
  ic.is_descending_key AS is_descending_key
FROM sys.indexes i
INNER JOIN sys.index_columns ic
  ON i.object_id = ic.object_id AND i.index_id = ic.index_id
INNER JOIN sys.columns c
  ON ic.object_id = c.object_id AND ic.column_id = c.column_id
INNER JOIN sys.objects o
  ON i.object_id = o.object_id
INNER JOIN sys.schemas u
  ON u.schema_id = o.schema_id
WHERE u.name = ${schema}
  AND o.type IN ('U', 'V')
  AND o.is_ms_shipped = 0
  AND i.type > 0
  AND i.name IS NOT NULL
  AND i.has_filter = 0
  AND i.is_disabled = 0
  AND ic.is_included_column = 0${tableFilter}
ORDER BY o.name, i.name, ic.key_ordinal
`;
}

/**
 * Format a character/binary data type with its length, matching the Sequelize
 * `describeTable()` convention: `nvarchar(255)`, `varchar(MAX)`, etc.
 * `n*` types store length as bytes, so the char count is `max_length / 2`.
 */
export function formatColumnType(dataType: string, maxLength: number): string {
  const type = dataType.toUpperCase();
  const isCharOrBinary = /CHAR|BINARY/.test(type);
  if (!isCharOrBinary) {
    return type;
  }
  if (maxLength === -1) {
    return `${type}(MAX)`;
  }
  // nvarchar/nchar report max_length in bytes (2 bytes per char)
  const charLength = type.startsWith('N') && !type.includes('BINARY') ? maxLength / 2 : maxLength;
  return `${type}(${charLength})`;
}

/**
 * Group flat bulk-query rows into the per-table `describeTable`-compatible map:
 * `{ [tableName]: { [columnName]: MssqlDescribeColumn } }`.
 */
export function groupColumnsByTable(rows: MssqlBulkColumnRow[]): Map<string, MssqlTableColumns> {
  const byTable = new Map<string, MssqlTableColumns>();

  for (const row of rows) {
    let table = byTable.get(row.table_name);
    if (!table) {
      table = {};
      byTable.set(row.table_name, table);
    }

    table[row.column_name] = {
      type: formatColumnType(row.data_type, row.max_length),
      allowNull: !!row.is_nullable,
      defaultValue: row.default_value ?? undefined,
      primaryKey: false, // resolved separately via the PK cache
      autoIncrement: !!row.is_identity,
      comment: row.column_comment ?? null,
    };
  }

  return byTable;
}

/**
 * Group flat bulk index rows into Sequelize `showIndex()`-compatible arrays per table.
 */
export function groupIndexesByTable(rows: MssqlBulkIndexRow[]): Map<string, MssqlShowIndexEntry[]> {
  const byTable = new Map<string, Map<string, MssqlShowIndexEntry>>();

  for (const row of rows) {
    let tableIndexes = byTable.get(row.table_name);
    if (!tableIndexes) {
      tableIndexes = new Map<string, MssqlShowIndexEntry>();
      byTable.set(row.table_name, tableIndexes);
    }

    let entry = tableIndexes.get(row.index_name);
    if (!entry) {
      entry = {
        name: row.index_name,
        primary: Boolean(row.is_primary_key),
        unique: Boolean(row.is_unique),
        fields: [],
      };
      tableIndexes.set(row.index_name, entry);
    }

    entry.fields[Math.max(0, row.key_ordinal - 1)] = {
      attribute: row.column_name,
      order: row.is_descending_key ? 'DESC' : 'ASC',
    };
  }

  const result = new Map<string, MssqlShowIndexEntry[]>();
  for (const [tableName, indexMap] of byTable.entries()) {
    result.set(
      tableName,
      [...indexMap.values()].map((entry) => ({
        ...entry,
        fields: entry.fields.filter(Boolean),
      })),
    );
  }
  return result;
}
