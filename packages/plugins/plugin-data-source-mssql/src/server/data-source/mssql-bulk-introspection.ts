/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { quoteUnicodeStringLiteral } from '../security/sql-quote';

/**
 * Shape of one row returned by the bulk column introspection query.
 * Mirrors what Sequelize's `describeTable()` produces per column so that
 * `getTableColumnsInfo()` can build a compatible `{ [columnName]: {...} }` map
 * entirely from memory, instead of one `sp_columns`-style round trip per table.
 */
export interface MssqlBulkColumnRow {
  table_name: string;
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

/**
 * Build the bulk column introspection SQL for an entire schema.
 *
 * Adapted from dbgate-plugin-mssql's `sql/columns.js`, but bulk (schema-wide, not
 * per-object) so the whole catalog loads in one round trip. The schema name is
 * passed as a Unicode string literal — never interpolated raw — to avoid any
 * SQL-injection surface.
 *
 * Reads from the `sys.*` catalog (plus `sys.default_constraints` / `sys.computed_columns`)
 * rather than `INFORMATION_SCHEMA` so that identity/computed/default metadata is available.
 */
export function buildBulkColumnsSql(schemaName: string): string {
  const schema = quoteUnicodeStringLiteral(schemaName);
  return `
SELECT
  o.name AS table_name,
  c.name AS column_name,
  t.name AS data_type,
  c.max_length AS max_length,
  c.is_nullable AS is_nullable,
  c.is_identity AS is_identity,
  d.definition AS default_value,
  CAST(ep.value AS NVARCHAR(MAX)) AS column_comment
FROM sys.columns c
INNER JOIN sys.types t
  ON c.system_type_id = t.system_type_id AND c.user_type_id = t.user_type_id
INNER JOIN sys.tables o
  ON c.object_id = o.object_id
INNER JOIN sys.schemas u
  ON u.schema_id = o.schema_id
LEFT JOIN sys.default_constraints d
  ON c.default_object_id = d.object_id
LEFT JOIN sys.extended_properties ep
  ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description'
WHERE u.name = ${schema}
  AND o.is_ms_shipped = 0
ORDER BY o.name, c.column_id
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
