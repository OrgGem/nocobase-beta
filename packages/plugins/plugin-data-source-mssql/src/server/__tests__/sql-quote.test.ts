// SPDX-License-Identifier: Apache-2.0

import {
  isSafeUnquotedIdentifier,
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteUnicodeStringLiteral,
  quoteAnsiStringLiteral,
  isPureAscii,
  formatDateTimeParameter,
  formatIsoDateTimeNoTz,
} from '../security/sql-quote';

describe('sql-quote security helpers', () => {
  describe('isSafeUnquotedIdentifier', () => {
    it('accepts plain identifiers', () => {
      expect(isSafeUnquotedIdentifier('username')).toBe(true);
      expect(isSafeUnquotedIdentifier('Order_Items2')).toBe(true);
      expect(isSafeUnquotedIdentifier('_id')).toBe(true);
    });

    it('rejects identifiers with special chars', () => {
      expect(isSafeUnquotedIdentifier('user name')).toBe(false);
      expect(isSafeUnquotedIdentifier('a-b')).toBe(false);
      expect(isSafeUnquotedIdentifier('a.b')).toBe(false);
      expect(isSafeUnquotedIdentifier('9lives')).toBe(false);
      expect(isSafeUnquotedIdentifier('a]b')).toBe(false);
    });

    it('rejects reserved keywords regardless of case', () => {
      expect(isSafeUnquotedIdentifier('select')).toBe(false);
      expect(isSafeUnquotedIdentifier('Order')).toBe(false);
      expect(isSafeUnquotedIdentifier('CONTAINS')).toBe(false);
    });
  });

  describe('quoteIdentifier', () => {
    it('bracket-quotes a simple identifier when policy is always-quote', () => {
      expect(quoteIdentifier('username')).toBe('[username]');
    });

    it('doubles an embedded closing bracket so it cannot terminate the identifier', () => {
      expect(quoteIdentifier('a]b')).toBe('[a]]b]');
      expect(quoteIdentifier('x], [injected')).toBe('[x]], [injected]');
    });

    it('quote-when-needed leaves safe identifiers bare but quotes unsafe ones', () => {
      expect(quoteIdentifier('username', 'quote-when-needed')).toBe('username');
      expect(quoteIdentifier('user name', 'quote-when-needed')).toBe('[user name]');
      expect(quoteIdentifier('Order', 'quote-when-needed')).toBe('[Order]');
    });
  });

  describe('quoteQualifiedIdentifier', () => {
    it('quotes and joins a dotted path', () => {
      expect(quoteQualifiedIdentifier(['dbo', 'Orders'])).toBe('[dbo].[Orders]');
    });

    it('escapes brackets in each part', () => {
      expect(quoteQualifiedIdentifier(['we]ird', 'ta]ble'])).toBe('[we]]ird].[ta]]ble]');
    });
  });

  describe('quoteUnicodeStringLiteral', () => {
    it('prefixes with N and single-quotes', () => {
      expect(quoteUnicodeStringLiteral('foo')).toBe("N'foo'");
    });

    it('doubles single quotes to prevent break-out', () => {
      expect(quoteUnicodeStringLiteral("o'brien")).toBe("N'o''brien'");
      expect(quoteUnicodeStringLiteral("'; DROP TABLE users; --")).toBe("N'''; DROP TABLE users; --'");
    });

    it('preserves non-ASCII characters verbatim', () => {
      expect(quoteUnicodeStringLiteral('tiếng việt')).toBe("N'tiếng việt'");
    });
  });

  describe('formatDateTimeParameter', () => {
    it('formats a plain Date as YYYY-MM-DD HH:mm:ss.SSS (space separator, no Z)', () => {
      const d = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
      expect(formatDateTimeParameter(d)).toBe('2024-01-02 03:04:05.678');
    });

    it('recovers sub-millisecond precision from tedious nanosecondsDelta (fraction of a second)', () => {
      const d = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678)) as Date & { nanosecondsDelta?: number };
      // Tedious encodes extra 100ns ticks beyond milliseconds as ticks100ns / 1e7 seconds (max 0.0009999).
      d.nanosecondsDelta = 4567 / 1e7;
      expect(formatDateTimeParameter(d)).toBe('2024-01-02 03:04:05.6784567');

      const dHalfMs = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678)) as Date & { nanosecondsDelta?: number };
      dHalfMs.nanosecondsDelta = 5000 / 1e7;
      expect(formatDateTimeParameter(dHalfMs)).toBe('2024-01-02 03:04:05.6785000');
    });

    it('ignores a zero/negative nanosecondsDelta', () => {
      const d = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678)) as Date & { nanosecondsDelta?: number };
      d.nanosecondsDelta = 0;
      expect(formatDateTimeParameter(d)).toBe('2024-01-02 03:04:05.678');
    });
  });

  describe('ANSI string helpers & ISO datetime', () => {
    it('detects pure ASCII vs Unicode strings', () => {
      expect(isPureAscii('ORD-001_ABC')).toBe(true);
      expect(isPureAscii('Nguyễn Văn A')).toBe(false);
    });

    it('quotes ANSI string literals without N prefix and doubles single quotes', () => {
      expect(quoteAnsiStringLiteral("O'Brien")).toBe("'O''Brien'");
    });

    it('formats ISO datetime without timezone using T separator', () => {
      const d = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
      expect(formatIsoDateTimeNoTz(d)).toBe('2024-01-02T03:04:05.678');
    });
  });
});
