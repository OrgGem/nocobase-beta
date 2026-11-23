/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { PostgresValidationError } from './validation-error';

const DANGEROUS_PATTERNS = [
  /\bpg_\w*/i,
  /\binformation_schema\b/i,
  /\b(?:current_setting|set_config|generate_series|lo_import|lo_export|dblink\w*|query_to_xml\w*|table_to_xml\w*|cursor_to_xml\w*|xmlparse|copy|uescape)\b/i,
];

const CTE_DISALLOWED_KEYWORDS =
  /\b(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|call|do|execute|prepare|deallocate|lock|vacuum|analyze|cluster|reindex|refresh)\b/i;

function consumeQuotedLiteral(sql: string, start: number, allowBackslashEscape: boolean): number {
  let i = start;
  while (i < sql.length) {
    if (allowBackslashEscape && sql[i] === '\\') {
      if (i + 1 >= sql.length) throw new PostgresValidationError('Invalid or unsupported SQL syntax');
      i += 2;
      continue;
    }
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new PostgresValidationError('Invalid or unsupported SQL syntax');
}

function consumeDoubleQuotedIdentifier(sql: string, start: number): { nextIndex: number; sanitized: string } {
  let raw = '';
  let i = start + 1;
  let closed = false;
  while (i < sql.length) {
    if (sql[i] === '"') {
      if (sql[i + 1] === '"') {
        raw += '"';
        i += 2;
        continue;
      }
      i += 1;
      closed = true;
      break;
    }
    raw += sql[i];
    i += 1;
  }
  if (!closed || raw.length === 0) {
    throw new PostgresValidationError('Invalid or unsupported SQL syntax');
  }
  return { nextIndex: i, sanitized: `"${raw.replace(/[^A-Za-z0-9_]/g, ' ')}"` };
}

function sanitizeSQL(sql: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out.push(' ');
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) throw new PostgresValidationError('Invalid or unsupported SQL syntax');
      out.push(' ');
      continue;
    }

    if ((ch === 'u' || ch === 'U') && next === '&' && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      throw new PostgresValidationError('Invalid or unsupported SQL syntax');
    }

    if ((ch === 'e' || ch === 'E') && next === "'" && (i === 0 || !/[A-Za-z0-9\x80-\uffff_$]/.test(sql[i - 1]))) {
      i = consumeQuotedLiteral(sql, i + 2, true);
      out.push("''");
      continue;
    }

    if (/[A-Za-z\x80-\uffff_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < sql.length && /[A-Za-z0-9\x80-\uffff_$]/.test(sql[i])) i += 1;
      out.push(sql.slice(start, i));
      continue;
    }

    if (ch === "'") {
      i = consumeQuotedLiteral(sql, i + 1, false);
      out.push("''");
      continue;
    }

    if (ch === '"') {
      const parsed = consumeDoubleQuotedIdentifier(sql, i);
      out.push(parsed.sanitized);
      i = parsed.nextIndex;
      continue;
    }

    if (ch === '$') {
      const tail = sql.slice(i);
      const paramMatch = tail.match(/^\$[0-9]+/);
      if (paramMatch) {
        out.push(paramMatch[0]);
        i += paramMatch[0].length;
        continue;
      }
      const tagMatch = tail.match(/^\$(?:[A-Za-z\x80-\uffff_][A-Za-z0-9\x80-\uffff_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new PostgresValidationError('Invalid or unsupported SQL syntax');
        i = end + tag.length;
        out.push("''");
        continue;
      }
    }

    out.push(ch);
    i += 1;
  }

  return out.join('').trim();
}

/**
 * Validate a SQL collection query so only single read-only SELECT/WITH statements run.
 */
export function checkSQL(sql: string): void {
  if (!sql || typeof sql !== 'string') {
    throw new PostgresValidationError('SQL query is required');
  }

  let sanitized = sanitizeSQL(sql);
  if (!sanitized) {
    throw new PostgresValidationError('SQL query cannot be empty');
  }

  if (sanitized.endsWith(';')) {
    sanitized = sanitized.slice(0, -1).trim();
  }
  if (!sanitized) {
    throw new PostgresValidationError('SQL query cannot be empty');
  }
  if (sanitized.includes(';')) {
    throw new PostgresValidationError('Multiple SQL statements are not allowed');
  }

  if (!/^(select|with)\b/i.test(sanitized)) {
    throw new PostgresValidationError('Only SELECT statements or WITH clauses are supported');
  }

  if (/^with\b/i.test(sanitized)) {
    if (!/\bselect\b/i.test(sanitized)) {
      throw new PostgresValidationError('Only SELECT statements or WITH clauses are supported');
    }
    const cteMatch = sanitized.match(CTE_DISALLOWED_KEYWORDS);
    if (cteMatch) {
      throw new PostgresValidationError('SQL statement contains dangerous keyword: {{keyword}}', {
        keyword: cteMatch[0].toLowerCase(),
      });
    }
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    const match = sanitized.match(pattern);
    if (match) {
      throw new PostgresValidationError('SQL statement contains dangerous keyword: {{keyword}}', {
        keyword: match[0].toLowerCase(),
      });
    }
  }
}
