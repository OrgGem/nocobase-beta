// SPDX-License-Identifier: Apache-2.0

import { DataTypes, Op, Sequelize } from 'sequelize';
import { describe, expect, it } from 'vitest';
import {
  MssqlDatetimeNoTzField,
  MssqlDatetimeNoTzType,
  parseWallClockToUtcDate,
  stringifyMssqlDatetimeNoTz,
} from '../fields/MssqlDatetimeNoTzField';
import {
  MssqlDateOnlyField,
  MssqlDateOnlyType,
  parseMssqlUtcDateOnly,
  registerMssqlUtcDateOnlyParser,
} from '../fields/MssqlDateOnlyField';

describe('MssqlDatetimeNoTzField & timezone-safe MSSQL datetimes', () => {
  describe('stringifyMssqlDatetimeNoTz', () => {
    it('formats wall-clock strings with ISO T separator and no timezone offset', () => {
      expect(stringifyMssqlDatetimeNoTz('2026-01-12 08:30:00')).toBe('2026-01-12T08:30:00');
      expect(stringifyMssqlDatetimeNoTz('2026-01-12 08:30:00.123')).toBe('2026-01-12T08:30:00.123');
    });

    it('formats Date objects in UTC without +00:00 and preserves tedious nanosecondsDelta', () => {
      const d = new Date(Date.UTC(2026, 0, 12, 8, 30, 0, 123)) as Date & { nanosecondsDelta?: number };
      expect(stringifyMssqlDatetimeNoTz(d)).toBe('2026-01-12T08:30:00.123');
      d.nanosecondsDelta = 4567 / 1e7;
      expect(stringifyMssqlDatetimeNoTz(d)).toBe('2026-01-12T08:30:00.1234567');
      expect(stringifyMssqlDatetimeNoTz('2026-01-12 08:30:00.1234567')).toBe('2026-01-12T08:30:00.1234567');
    });
  });

  describe('host-timezone-independent getter & setter round-trip', () => {
    it('preserves exact wall-clock digits regardless of Node host timezone', () => {
      const field = Object.create(MssqlDatetimeNoTzField.prototype) as MssqlDatetimeNoTzField;
      Object.assign(field, {
        options: { name: 'orderDate' },
        database: { options: { rawTimezone: '+00:00' } },
      });
      const { get, set } = field.additionalSequelizeOptions() as {
        get: (this: { getDataValue(k: string): unknown }) => unknown;
        set: (this: { setDataValue(k: string, v: unknown): void }, v: unknown) => void;
      };

      const store: Record<string, unknown> = {};
      const ctx = {
        getDataValue: (k: string) => store[k],
        setDataValue: (k: string, v: unknown) => {
          store[k] = v;
        },
      };

      // Write wall-clock string -> stored as UTC Date with exact wall-clock digits -> read back identical
      set.call(ctx, '2026-01-12 08:30:00');
      expect(store.orderDate).toBeInstanceOf(Date);
      expect((store.orderDate as Date).toISOString()).toBe('2026-01-12T08:30:00.000Z');
      expect(get.call(ctx)).toBe('2026-01-12 08:30:00');
      expect(stringifyMssqlDatetimeNoTz(store.orderDate)).toBe('2026-01-12T08:30:00.000');

      // Tedious with useUTC:true returns Date.UTC(...) for DB wall-clock values -> read back identical
      store.orderDate = new Date(Date.UTC(2026, 5, 20, 14, 15, 30));
      expect(get.call(ctx)).toBe('2026-06-20 14:15:30');
    });

    it('preserves full datetime2(7) sub-millisecond precision across set, get, and stringify', () => {
      const field = Object.create(MssqlDatetimeNoTzField.prototype) as MssqlDatetimeNoTzField;
      Object.assign(field, {
        options: { name: 'eventAt' },
        database: { options: { rawTimezone: '+07:00' } },
      });
      const { get, set } = field.additionalSequelizeOptions() as {
        get: (this: { getDataValue(k: string): unknown }) => unknown;
        set: (this: { setDataValue(k: string, v: unknown): void }, v: unknown) => void;
      };

      const store: Record<string, unknown> = {};
      const ctx = {
        getDataValue: (k: string) => store[k],
        setDataValue: (k: string, v: unknown) => {
          store[k] = v;
        },
      };

      // 7-digit wall-clock string round-trip
      set.call(ctx, '2026-01-12 08:30:00.1234567');
      expect(store.eventAt).toBeInstanceOf(Date);
      expect((store.eventAt as { nanosecondDelta?: number }).nanosecondDelta).toBeCloseTo(4567 / 1e7, 12);
      expect(get.call(ctx)).toBe('2026-01-12 08:30:00.1234567');
      expect(stringifyMssqlDatetimeNoTz(store.eventAt)).toBe('2026-01-12T08:30:00.1234567');

      // Edge case where milliseconds are 000 but 100ns remainder is non-zero
      set.call(ctx, '2026-01-12 08:30:00.0000001');
      expect(get.call(ctx)).toBe('2026-01-12 08:30:00.0000001');

      // ISO-with-Z + 7 fractional digits shifted to configured rawTimezone
      set.call(ctx, '2026-01-12T01:30:00.1234567Z');
      expect(get.call(ctx)).toBe('2026-01-12 08:30:00.1234567');
    });

    it('applies configured rawTimezone when converting ISO-with-offset inputs', () => {
      const parsed = parseWallClockToUtcDate('2026-01-12T01:30:00.000Z', '+07:00') as Date;
      expect(parsed.toISOString()).toBe('2026-01-12T08:30:00.000Z');
    });
  });

  describe('Sequelize MSSQL SQL generation for datetimeNoTz and datetimeTz', () => {
    it('emits ISO-8601 without +00:00 for datetimeNoTz and preserves exact UTC for datetimeTz', async () => {
      const sequelize = new Sequelize('db', 'u', 'p', { dialect: 'mssql', logging: false });
      const captured: Array<string | { query: string; bind?: unknown[] }> = [];
      (
        sequelize as unknown as { query: (sql: string | { query: string; bind?: unknown[] }) => Promise<unknown[]> }
      ).query = async (sql) => {
        captured.push(sql);
        return [];
      };

      const Order = sequelize.define(
        'orders',
        {
          id: { type: DataTypes.INTEGER, primaryKey: true },
          orderDate: { type: MssqlDatetimeNoTzType as unknown as typeof DataTypes.DATE, field: 'OrderDate' },
          syncedAt: { type: DataTypes.DATE, field: 'SyncedAt' },
        },
        { timestamps: false, tableName: 'Orders' },
      );

      await Order.findAll({
        where: {
          orderDate: { [Op.gte]: '2026-01-01 00:00:00', [Op.lt]: '2026-01-02 00:00:00' },
        },
      });
      await Order.create({
        id: 1,
        orderDate: new Date(Date.UTC(2026, 0, 1, 8, 30, 0, 123)),
        syncedAt: new Date(Date.UTC(2026, 0, 1, 8, 30, 0, 0)),
      }).catch(() => undefined);
      await Order.update({ orderDate: '2026-01-01 08:30:00' }, { where: { id: 1 } }).catch(() => undefined);

      const selectSql = String(captured[0]);
      expect(selectSql).toContain(`[orders].[OrderDate] >= N'2026-01-01T00:00:00'`);
      expect(selectSql).toContain(`[orders].[OrderDate] < N'2026-01-02T00:00:00'`);
      expect(selectSql).not.toContain('+00:00');

      const insertPayload = captured[1] as { query: string; bind: unknown[] };
      expect(insertPayload.bind[1]).toBe('2026-01-01T08:30:00.123');
      // DATETIMEOFFSET keeps exact UTC instant without being shifted by local host timezone
      expect(insertPayload.bind[2]).toBe('2026-01-01 08:30:00.000 +00:00');

      const updatePayload = captured[2] as { query: string; bind: unknown[] };
      expect(updatePayload.bind[0]).toBe('2026-01-01T08:30:00');
    });
  });

  describe('MssqlDateOnlyField & UTC-safe SQL Server DATE parsing', () => {
    it('formats UTC midnight Date objects and date strings without host-timezone day shifts', () => {
      const utcMidnight = new Date(Date.UTC(2026, 0, 15, 0, 0, 0));
      expect(parseMssqlUtcDateOnly(utcMidnight)).toBe('2026-01-15');
      expect(parseMssqlUtcDateOnly('2026-01-15')).toBe('2026-01-15');
      expect(parseMssqlUtcDateOnly('2026-01-15 00:00:00')).toBe('2026-01-15');
      expect(parseMssqlUtcDateOnly('2026-01-15T00:00:00.000Z')).toBe('2026-01-15');

      const type = new MssqlDateOnlyType();
      expect(type.toSql()).toBe('DATE');
      expect(type._stringify(utcMidnight)).toBe('2026-01-15');
      expect(type._sanitize(utcMidnight)).toBe('2026-01-15');
      expect(type._sanitize(utcMidnight, { raw: true })).toBe(utcMidnight);
      expect(type._isChanged('2026-01-15', '2026-01-15')).toBe(false);
      expect(type._isChanged('2026-01-16', '2026-01-15')).toBe(true);

      const field = Object.create(MssqlDateOnlyField.prototype) as MssqlDateOnlyField;
      expect(field.dataType).toBe(MssqlDateOnlyType);
    });

    it('registers the UTC DATE parser on Sequelize MSSQL parserStore for TDS type 40 and emits clean DATE SQL', async () => {
      const sequelize = new Sequelize('db', 'u', 'p', { dialect: 'mssql', logging: false });
      registerMssqlUtcDateOnlyParser(sequelize as unknown as Parameters<typeof registerMssqlUtcDateOnlyParser>[0]);

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const parserStore = require('sequelize/lib/dialects/parserStore')('mssql') as {
        get: (typeId: number) => ((value: unknown) => unknown) | undefined;
      };
      const dateParser = parserStore.get(40);
      expect(dateParser).toBe(parseMssqlUtcDateOnly);
      expect(dateParser?.(new Date(Date.UTC(2026, 2, 1, 0, 0, 0)))).toBe('2026-03-01');

      const captured: Array<string | { query: string; bind?: unknown[] }> = [];
      (
        sequelize as unknown as { query: (sql: string | { query: string; bind?: unknown[] }) => Promise<unknown[]> }
      ).query = async (sql) => {
        captured.push(sql);
        return [];
      };

      const Event = sequelize.define(
        'events',
        {
          id: { type: DataTypes.INTEGER, primaryKey: true },
          eventDate: { type: MssqlDateOnlyType as unknown as typeof DataTypes.DATEONLY, field: 'EventDate' },
        },
        { timestamps: false, tableName: 'Events' },
      );

      await Event.findAll({
        where: { eventDate: { [Op.eq]: new Date(Date.UTC(2026, 0, 15, 0, 0, 0)) } },
      });
      await Event.create({
        id: 1,
        eventDate: new Date(Date.UTC(2026, 0, 15, 0, 0, 0)),
      }).catch(() => undefined);

      expect(String(captured[0])).toContain(`[events].[EventDate] = N'2026-01-15'`);
      const insertPayload = captured[1] as { query: string; bind: unknown[] };
      expect(insertPayload.bind[1]).toBe('2026-01-15');
    });
  });
});
