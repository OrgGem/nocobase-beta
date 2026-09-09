/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T-SQL identifier and literal quoting helpers, ported from dbgate-mssql-dumper
 * (src/security/identifiers.ts, src/security/literals.ts). Used wherever the plugin
 * builds raw SQL by hand (e.g. the CONTAINS() full-text operator) so that column
 * names and search values cannot break out of their quoting context.
 */

/** Regular (unquoted) T-SQL identifiers must match this shape. */
const SAFE_UNQUOTED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A subset of the ODBC/ISO reserved T-SQL keywords that commonly appear as
 * column names. When in doubt we bracket-quote anyway, so this list only needs
 * to catch the words that would otherwise be emitted bare.
 */
const RESERVED_KEYWORDS = new Set(
  [
    'ADD',
    'ALL',
    'ALTER',
    'AND',
    'ANY',
    'AS',
    'ASC',
    'AUTHORIZATION',
    'BACKUP',
    'BEGIN',
    'BETWEEN',
    'BREAK',
    'BROWSE',
    'BULK',
    'BY',
    'CASCADE',
    'CASE',
    'CHECK',
    'CHECKPOINT',
    'CLOSE',
    'CLUSTERED',
    'COALESCE',
    'COLLATE',
    'COLUMN',
    'COMMIT',
    'COMPUTE',
    'CONSTRAINT',
    'CONTAINS',
    'CONTAINSTABLE',
    'CONTINUE',
    'CONVERT',
    'CREATE',
    'CROSS',
    'CURRENT',
    'CURRENT_DATE',
    'CURRENT_TIME',
    'CURRENT_TIMESTAMP',
    'CURRENT_USER',
    'CURSOR',
    'DATABASE',
    'DBCC',
    'DEALLOCATE',
    'DECLARE',
    'DEFAULT',
    'DELETE',
    'DENY',
    'DESC',
    'DISK',
    'DISTINCT',
    'DISTRIBUTED',
    'DOUBLE',
    'DROP',
    'DUMP',
    'ELSE',
    'END',
    'ERRLVL',
    'ESCAPE',
    'EXCEPT',
    'EXEC',
    'EXECUTE',
    'EXISTS',
    'EXIT',
    'EXTERNAL',
    'FETCH',
    'FILE',
    'FILLFACTOR',
    'FOR',
    'FOREIGN',
    'FREETEXT',
    'FREETEXTTABLE',
    'FROM',
    'FULL',
    'FUNCTION',
    'GOTO',
    'GRANT',
    'GROUP',
    'HAVING',
    'HOLDLOCK',
    'IDENTITY',
    'IDENTITY_INSERT',
    'IDENTITYCOL',
    'IF',
    'IN',
    'INDEX',
    'INNER',
    'INSERT',
    'INTERSECT',
    'INTO',
    'IS',
    'JOIN',
    'KEY',
    'KILL',
    'LEFT',
    'LIKE',
    'LINENO',
    'LOAD',
    'MERGE',
    'NATIONAL',
    'NOCHECK',
    'NONCLUSTERED',
    'NOT',
    'NULL',
    'NULLIF',
    'OF',
    'OFF',
    'OFFSETS',
    'ON',
    'OPEN',
    'OPENDATASOURCE',
    'OPENQUERY',
    'OPENROWSET',
    'OPENXML',
    'OPTION',
    'OR',
    'ORDER',
    'OUTER',
    'OVER',
    'PERCENT',
    'PIVOT',
    'PLAN',
    'PRECISION',
    'PRIMARY',
    'PRINT',
    'PROC',
    'PROCEDURE',
    'PUBLIC',
    'RAISERROR',
    'READ',
    'READTEXT',
    'RECONFIGURE',
    'REFERENCES',
    'REPLICATION',
    'RESTORE',
    'RESTRICT',
    'RETURN',
    'REVERT',
    'REVOKE',
    'RIGHT',
    'ROLLBACK',
    'ROWCOUNT',
    'ROWGUIDCOL',
    'RULE',
    'SAVE',
    'SCHEMA',
    'SECURITYAUDIT',
    'SELECT',
    'SEMANTICKEYPHRASETABLE',
    'SEMANTICSIMILARITYDETAILSTABLE',
    'SEMANTICSIMILARITYTABLE',
    'SESSION_USER',
    'SET',
    'SETUSER',
    'SHUTDOWN',
    'SOME',
    'STATISTICS',
    'SYSTEM_USER',
    'TABLE',
    'TABLESAMPLE',
    'TEXTSIZE',
    'THEN',
    'TO',
    'TOP',
    'TRAN',
    'TRANSACTION',
    'TRIGGER',
    'TRUNCATE',
    'TRY_CONVERT',
    'TSEQUAL',
    'UNION',
    'UNIQUE',
    'UNPIVOT',
    'UPDATE',
    'UPDATETEXT',
    'USE',
    'USER',
    'VALUES',
    'VARYING',
    'VIEW',
    'WAITFOR',
    'WHEN',
    'WHERE',
    'WHILE',
    'WITH',
    'WITHIN GROUP',
    'WRITETEXT',
  ].map((word) => word.toUpperCase()),
);

/**
 * True when `value` may appear unbracketed in generated SQL: it matches the
 * regular-identifier grammar and is not a reserved keyword.
 */
export function isSafeUnquotedIdentifier(value: string): boolean {
  return SAFE_UNQUOTED_IDENTIFIER.test(value) && !RESERVED_KEYWORDS.has(value.toUpperCase());
}

/**
 * Quotes one identifier part with brackets, doubling embedded `]` characters.
 * `]` is the only character that can terminate a bracket-quoted identifier, so
 * escaping it (as `]]`) is sufficient to keep any value inside its quoting context.
 */
export function quoteIdentifier(value: string, policy: 'quote-when-needed' | 'always-quote' = 'always-quote'): string {
  if (policy === 'quote-when-needed' && isSafeUnquotedIdentifier(value)) {
    return value;
  }
  return `[${value.replace(/]/g, ']]')}]`;
}

/** Quotes and joins a dotted identifier path, e.g. `["dbo", "Orders"]` -> `[dbo].[Orders]`. */
export function quoteQualifiedIdentifier(
  parts: readonly string[],
  policy: 'quote-when-needed' | 'always-quote' = 'always-quote',
): string {
  return parts.map((part) => quoteIdentifier(part, policy)).join('.');
}

/** Escapes and single-quotes a Unicode (`N'...'`) string literal, for `nchar`/`nvarchar` targets. */
export function quoteUnicodeStringLiteral(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

/**
 * A `Date` read by tedious for a `datetime2`/`datetimeoffset` column may carry a
 * non-enumerable `nanosecondsDelta` property: the fractional-second remainder beyond
 * JS Date's millisecond precision. Absent for values from any other source.
 */
export interface DateWithNanosecondsDelta extends Date {
  readonly nanosecondsDelta?: number;
}

function readNanosecondsDelta(value: Date): number | undefined {
  const delta = (value as DateWithNanosecondsDelta).nanosecondsDelta;
  return typeof delta === 'number' && Number.isFinite(delta) ? delta : undefined;
}

/**
 * Formats a `Date` as the `YYYY-MM-DD HH:mm:ss.SSS[SSSS]` text SQL Server expects for
 * `datetime`/`datetime2` parameters. Unlike `Date#toISOString().slice(0, 23)`, this
 * recovers sub-millisecond precision from tedious's `nanosecondsDelta` (up to 7
 * fractional digits) instead of silently truncating to milliseconds. When no delta is
 * present the result matches the plain millisecond form.
 *
 * Note: this keeps the space-separated form (not ISO-8601 `T`) because the value is
 * bound to a typed `datetime`/`datetime2` parameter by tedious, not parsed from a
 * free-text literal, so the unambiguous-format concern does not apply here.
 */
export function formatDateTimeParameter(value: Date): string {
  const iso = value.toISOString(); // '2024-01-02T03:04:05.678Z'
  let text = iso.replace('T', ' ').replace('Z', ''); // '2024-01-02 03:04:05.678'

  const nanosecondsDelta = readNanosecondsDelta(value);
  if (nanosecondsDelta !== undefined && nanosecondsDelta > 0) {
    // nanosecondsDelta is a fraction of a millisecond; convert to up to 4 extra digits
    // (100ns ticks) appended after the millisecond part.
    const extraTicks = Math.min(9999, Math.max(0, Math.round(nanosecondsDelta * 1e4)));
    if (extraTicks > 0) {
      text += String(extraTicks).padStart(4, '0');
    }
  }
  return text;
}
