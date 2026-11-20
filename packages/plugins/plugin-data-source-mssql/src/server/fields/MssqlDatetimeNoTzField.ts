// SPDX-License-Identifier: Apache-2.0

import { DatetimeNoTzField } from '@nocobase/database';
import { DataTypes } from 'sequelize';
import { formatDateTimeParameter, formatIsoDateTimeNoTz } from '../security/sql-quote';

const LOCAL_DATETIME_NO_TZ_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
const UTC_OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;

function parseUtcOffsetMinutes(timezone: string): number {
  const match = UTC_OFFSET_RE.exec(timezone.trim());
  if (!match) {
    return 0;
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Formats a datetime-without-timezone value into SQL Server's locale-independent ISO-8601 form
 * (`YYYY-MM-DDTHH:mm:ss[.fff...]`) without a timezone offset (`+00:00`). SQL Server `DATETIME`,
 * `SMALLDATETIME`, and `DATETIME2` reject timezone offsets with Msg 241, and space-separated dates
 * are misparsed when a login runs under `SET DATEFORMAT dmy`.
 */
export function stringifyMssqlDatetimeNoTz(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : formatIsoDateTimeNoTz(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const localMatch = LOCAL_DATETIME_NO_TZ_RE.exec(trimmed);
    if (localMatch) {
      return `${localMatch[1]}T${localMatch[2]}`;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return formatIsoDateTimeNoTz(parsed);
    }
    return trimmed;
  }
  return String(value);
}

/**
 * Converts a wall-clock datetime input into a UTC `Date` whose UTC fields equal the exact wall-clock
 * time. Because tedious runs with `useUTC: true`, storing wall-clock components in UTC ensures
 * identical reads and writes regardless of the Node.js host timezone (e.g. UTC+7 vs UTC).
 */
export function parseWallClockToUtcDate(val: unknown, timezone = '+00:00'): Date | unknown {
  if (val == null) {
    return null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    const localMatch = LOCAL_DATETIME_NO_TZ_RE.exec(trimmed);
    if (localMatch) {
      const utcDate = new Date(`${localMatch[1]}T${localMatch[2]}Z`);
      if (!Number.isNaN(utcDate.getTime())) {
        return utcDate;
      }
    }
  }
  const parsed = val instanceof Date ? val : new Date(String(val));
  if (Number.isNaN(parsed.getTime())) {
    return val;
  }
  const offsetMinutes = parseUtcOffsetMinutes(timezone);
  return new Date(parsed.getTime() + offsetMinutes * 60_000);
}

// Sequelize v6 wraps DataTypes.ABSTRACT in a classToInvokable Proxy whose constructor returns a
// bare ABSTRACT instance, discarding subclass prototype methods such as `_stringify`. Inheriting
// from the unwrapped prototype constructor preserves `_stringify` and `toSql` on model attributes.
type AbstractDataTypeCtor = new () => { key: string; toSql(): string };
const UnwrappedAbstract = DataTypes.ABSTRACT.prototype.constructor as AbstractDataTypeCtor;

export class MssqlDatetimeNoTzType extends UnwrappedAbstract {
  static key = 'DATETIME2';
  key = 'DATETIME2';

  toSql(): string {
    return 'DATETIME2';
  }

  _stringify(value: unknown): string {
    return stringifyMssqlDatetimeNoTz(value);
  }
}

/**
 * MSSQL override for NocoBase's `datetimeNoTz` field.
 *
 * Core's `DatetimeNoTzField` falls back to `DataTypes.DATE` on MSSQL (emitting `+00:00`, which
 * crashes SQL Server `DATETIME`/`DATETIME2`) and interprets `Date` objects using the Node host's
 * local timezone (shifting reads/writes by ±hostOffset when `tedious` runs with `useUTC: true`).
 * This subclass aligns both getter/setter and `_stringify` on UTC wall-clock representation so
 * behavior is completely independent of the Node server timezone.
 */
export class MssqlDatetimeNoTzField extends DatetimeNoTzField {
  get dataType() {
    return MssqlDatetimeNoTzType as unknown as typeof DataTypes.DATE;
  }

  additionalSequelizeOptions(): Record<string, unknown> {
    const { name } = this.options;
    const dbOptions = this.database?.options as { rawTimezone?: string } | undefined;
    const timezone = dbOptions?.rawTimezone || '+00:00';

    return {
      get(this: { getDataValue(key: string): unknown }) {
        const val = this.getDataValue(name);
        if (val instanceof Date && !Number.isNaN(val.getTime())) {
          return formatDateTimeParameter(val).slice(0, 19);
        }
        return val;
      },

      set(this: { setDataValue(key: string, value: unknown): void }, val: unknown) {
        if (val == null) {
          this.setDataValue(name, null);
          return;
        }
        this.setDataValue(name, parseWallClockToUtcDate(val, timezone));
      },
    };
  }
}
