import { describe, expect, it } from 'vitest';
import { MAX_ROWS, assertSafeSelect, limitRows } from '../utils/sql-safety';

describe('sql safety', () => {
  it('allows a plain SELECT', () => {
    expect(assertSafeSelect('SELECT * FROM users')).toBe('SELECT * FROM users');
  });

  it('allows a WITH (CTE) query', () => {
    expect(assertSafeSelect('WITH x AS (SELECT 1) SELECT * FROM x')).toContain('WITH');
  });

  it('strips leading comments', () => {
    expect(assertSafeSelect('-- comment\nSELECT 1')).toBe('SELECT 1');
    expect(assertSafeSelect('/* block */ SELECT 1')).toBe('SELECT 1');
  });

  it('allows keywords inside string literals', () => {
    expect(assertSafeSelect("SELECT 'DELETE' AS label")).toContain('label');
  });

  it('rejects DDL and DML', () => {
    const statements = [
      'DROP TABLE users',
      'INSERT INTO users VALUES (1)',
      'DELETE FROM users',
      'UPDATE users SET a = 1',
      'CREATE TABLE x (id int)',
    ];
    for (const sql of statements) {
      expect(() => assertSafeSelect(sql)).toThrow();
    }
  });

  it('rejects multiple statements', () => {
    expect(() => assertSafeSelect('SELECT 1; SELECT 2')).toThrow('Multiple statements');
  });

  it('rejects PRAGMA', () => {
    expect(() => assertSafeSelect('PRAGMA table_info(users)')).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => assertSafeSelect('SELECT 1\x00')).toThrow();
  });

  it('wraps queries with a row limit', () => {
    expect(limitRows('SELECT * FROM users')).toContain(`LIMIT ${MAX_ROWS}`);
  });
});
