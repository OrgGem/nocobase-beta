/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { checkSQL, normalizeSqlCollectionQuery } from '../utils/sql-validator';
import { PostgresValidationError } from '../utils/validation-error';

function expectValidationError(fn: () => void, message?: string) {
  try {
    fn();
    expect.fail('Expected checkSQL to throw PostgresValidationError');
  } catch (error) {
    expect(error).toBeInstanceOf(PostgresValidationError);
    expect((error as PostgresValidationError).status).toBe(400);
    if (message) expect((error as Error).message).toContain(message);
  }
}

describe('checkSQL', () => {
  it('allows valid SELECT and WITH ... SELECT statements', () => {
    expect(() => checkSQL('SELECT id, name FROM orders WHERE active = true;')).not.toThrow();
    expect(() =>
      checkSQL(`
        WITH recent_orders AS (
          SELECT id, total FROM orders
        )
        SELECT id, total FROM recent_orders
      `),
    ).not.toThrow();
  });

  it('allows column or table identifiers containing copy', () => {
    expect(() => checkSQL('SELECT copyright, copy_count FROM articles')).not.toThrow();
    expect(() => checkSQL('WITH cte AS (SELECT copyright FROM books) SELECT * FROM cte')).not.toThrow();
  });

  it('ignores comments, string literals, dollar-quoted strings, and benign quoted aliases', () => {
    expect(() =>
      checkSQL(`
        -- pg_read_file comment; DROP TABLE orders
        /* nested /* pg_sleep(10) */ comment */
        SELECT 'pg_read_file; DROP TABLE orders' AS note,
               E'escaped\\'pg_sleep' AS esc,
               $$hello;world$$ AS msg,
               $tag$it's fine$tag$ AS quoted_tag,
               1 AS "a;b"
        FROM items
      `),
    ).not.toThrow();
  });

  it('rejects empty, comment-only, and non-SELECT statements with HTTP 400 status', () => {
    expectValidationError(() => checkSQL(''), 'SQL query is required');
    expectValidationError(() => checkSQL('   -- only comment\n/* block */  '), 'SQL query cannot be empty');
    expectValidationError(() => checkSQL('DELETE FROM orders'), 'Only SELECT statements or WITH clauses are supported');
    expectValidationError(
      () => checkSQL('UPDATE orders SET name = 1'),
      'Only SELECT statements or WITH clauses are supported',
    );
  });

  it('rejects multiple statements separated by semicolons', () => {
    expectValidationError(() => checkSQL('SELECT 1; DROP TABLE orders'), 'Multiple SQL statements are not allowed');
    expectValidationError(() => checkSQL('SELECT 1;;'), 'Multiple SQL statements are not allowed');
  });

  it('rejects dollar-quote, double-quote, identifier-tag, Unicode-escape, and unclosed token bypasses', () => {
    for (const sql of [
      'SELECT $$\'$$ ) AS "t"; COMMIT; DROP TABLE orders; BEGIN; SELECT * FROM (SELECT $$\'$$',
      "SELECT $$'$$, pg_read_file($$/etc/passwd$$), $$'$$",
      'SELECT 1 AS "\'" ) AS "t"; COMMIT; DROP TABLE orders; BEGIN; SELECT * FROM (SELECT 1 AS "\'"',
      'SELECT "pg_read_file"(\'/etc/passwd\')',
      'SELECT * FROM "information_schema"."tables"',
      'SELECT a$tag$; COMMIT; DROP TABLE orders; --$tag$',
      'SELECT U&"pg\\005fread_file"(\'/etc/passwd\')',
      "SELECT u&'test; DROP TABLE orders'",
      'SELECT /* unclosed comment 1',
      "SELECT 'unclosed string",
      'SELECT "unclosed identifier',
      'SELECT $tag$unclosed dollar quote',
    ]) {
      expectValidationError(() => checkSQL(sql));
    }
  });

  it('rejects data-modifying CTEs', () => {
    expectValidationError(
      () => checkSQL('WITH deleted AS (DELETE FROM orders RETURNING *) SELECT * FROM deleted'),
      'SQL statement contains dangerous keyword: delete',
    );
    expectValidationError(
      () => checkSQL('WITH ins AS (INSERT INTO audit VALUES (1) RETURNING id) SELECT * FROM ins'),
      'SQL statement contains dangerous keyword: insert',
    );
  });

  it('rejects pg_ catalogs/functions, information_schema, dblink, and COPY', () => {
    for (const sql of [
      'SELECT * FROM pg_settings',
      'SELECT * FROM pg_stat_activity',
      'SELECT * FROM pg_roles',
      "SELECT pg_read_file('/etc/passwd')",
      'SELECT pg_sleep(10)',
      'SELECT * FROM information_schema.tables',
      "SELECT * FROM dblink('conn', 'SELECT 1') AS t(a int)",
      "WITH c AS (COPY orders TO PROGRAM 'id') SELECT 1",
      "SELECT current_setting('data_directory')",
      "SELECT lo_import('/etc/passwd')",
    ]) {
      expectValidationError(() => checkSQL(sql), 'SQL statement contains dangerous keyword');
    }
  });

  it('normalizes trailing semicolons across comments without altering semicolons inside literals', () => {
    expect(normalizeSqlCollectionQuery('SELECT 1; /* note */')).toBe('SELECT 1 /* note */');
    expect(normalizeSqlCollectionQuery('SELECT 1; -- note\n')).toBe('SELECT 1 -- note');
    expect(normalizeSqlCollectionQuery("SELECT ';' AS sep; /* note */")).toBe("SELECT ';' AS sep /* note */");
    expect(normalizeSqlCollectionQuery('SELECT $$a;b$$;')).toBe('SELECT $$a;b$$');
  });
});
