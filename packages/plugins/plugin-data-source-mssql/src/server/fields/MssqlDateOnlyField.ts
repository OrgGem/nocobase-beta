// SPDX-License-Identifier: Apache-2.0

import { DateOnlyField } from '@nocobase/database';
import { DataTypes } from 'sequelize';

const MSSQL_TDS_DATE_TYPE_ID = 40;
const DATE_ONLY_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/;
const HAS_TZ_DESIGNATOR_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Formats a SQL Server `DATE` value into `YYYY-MM-DD` using UTC components rather than the Node
 * host's local timezone. Because `tedious` runs with `useUTC: true`, it decodes SQL Server `DATE`
 * columns as `new Date(Date.UTC(y, m - 1, d))`; Sequelize's built-in MSSQL `DATEONLY` parser and
 * `_stringify`/`_sanitize` use local-timezone `moment(value).format('YYYY-MM-DD')`, which shifts
 * every date back by one day on hosts running west of UTC (`UTC-1` through `UTC-12`).
 */
export function parseMssqlUtcDateOnly(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const dateMatch = DATE_ONLY_PREFIX_RE.exec(trimmed);
    if (dateMatch && !HAS_TZ_DESIGNATOR_RE.test(trimmed)) {
      return dateMatch[1];
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    return trimmed;
  }
  return String(value);
}

/**
 * Registers the UTC-safe `DATEONLY` parser on Sequelize's MSSQL `parserStore` for TDS type 40
 * (`DATE`). Must be called after creating any MSSQL `Sequelize` instance (including probe
 * connections), because Sequelize's `ConnectionManager` constructor resets the shared dialect
 * `parserStore` back to local-timezone `moment` on every `new Sequelize({ dialect: 'mssql' })`.
 */
export function registerMssqlUtcDateOnlyParser(sequelize?: {
  getDialect?: () => string;
  connectionManager?: {
    refreshTypeParser?: (dataTypes: Record<string, unknown>) => void;
  };
}): void {
  if (typeof sequelize?.getDialect === 'function' && sequelize.getDialect() !== 'mssql') {
    return;
  }
  const refresh = sequelize?.connectionManager?.refreshTypeParser;
  if (typeof refresh !== 'function') {
    return;
  }
  refresh.call(sequelize.connectionManager, {
    DATEONLY: {
      key: 'DATEONLY',
      types: { mssql: [MSSQL_TDS_DATE_TYPE_ID] },
      parse: parseMssqlUtcDateOnly,
    },
  });
}

// Inherit from the unwrapped DataTypes.ABSTRACT constructor (same pattern as MssqlDatetimeNoTzType)
// so Sequelize v6's classToInvokable Proxy does not discard `_stringify` and `_sanitize`. Use a
// distinct key (`MSSQL_DATEONLY`) so `sequelize.normalizeDataType()` does not replace this class
// with `DataTypes.mssql.DATEONLY` (whose `_stringify`/`_sanitize` use local-timezone `moment`).
type AbstractDataTypeCtor = new () => { key: string; toSql(): string };
const UnwrappedAbstract = DataTypes.ABSTRACT.prototype.constructor as AbstractDataTypeCtor;

export class MssqlDateOnlyType extends UnwrappedAbstract {
  static key = 'MSSQL_DATEONLY';
  key = 'MSSQL_DATEONLY';

  toSql(): string {
    return 'DATE';
  }

  _stringify(value: unknown): string {
    return parseMssqlUtcDateOnly(value);
  }

  _sanitize(value: unknown, options?: { raw?: boolean }): unknown {
    if ((!options || !options.raw) && value) {
      return parseMssqlUtcDateOnly(value);
    }
    return value;
  }

  _isChanged(value: unknown, originalValue: unknown): boolean {
    if (originalValue && value && originalValue === value) {
      return false;
    }
    if (!originalValue && !value && originalValue === value) {
      return false;
    }
    return true;
  }
}

/**
 * MSSQL override for NocoBase's `dateOnly` field using UTC-safe `YYYY-MM-DD` formatting.
 */
export class MssqlDateOnlyField extends DateOnlyField {
  get dataType() {
    return MssqlDateOnlyType as unknown as typeof DataTypes.DATEONLY;
  }
}
