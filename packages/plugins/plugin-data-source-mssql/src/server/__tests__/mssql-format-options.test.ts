/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { formatDatabaseOptions } from '../data-source/MssqlExternalDataSource';

describe('formatDatabaseOptions', () => {
  it('enables ARITHABORT by default (recommended SQL Server session setting)', () => {
    const opts = formatDatabaseOptions({ host: 'localhost', database: 'db' });
    expect(opts.dialectOptions.options.enableArithAbort).toBe(true);
  });

  it('lets a caller override enableArithAbort', () => {
    const opts = formatDatabaseOptions({
      host: 'localhost',
      database: 'db',
      dialectOptions: { options: { enableArithAbort: false } },
    });
    expect(opts.dialectOptions.options.enableArithAbort).toBe(false);
  });

  it('forces useUTC to avoid datetime offset issues', () => {
    const opts = formatDatabaseOptions({ host: 'localhost', database: 'db' });
    expect(opts.dialectOptions.options.useUTC).toBe(true);
  });

  it('maps the encrypt flag into tedious options', () => {
    expect(formatDatabaseOptions({ encrypt: true }).dialectOptions.options.encrypt).toBe(true);
    expect(formatDatabaseOptions({ encrypt: false }).dialectOptions.options.encrypt).toBe(false);
    expect('encrypt' in formatDatabaseOptions({}).dialectOptions.options).toBe(false);
  });

  it('applies sensible pool defaults while allowing overrides', () => {
    const defaults = formatDatabaseOptions({});
    expect(defaults.pool).toMatchObject({ max: 10, min: 2, acquire: 30000, idle: 10000 });

    const custom = formatDatabaseOptions({ pool: { max: 25 } });
    expect(custom.pool.max).toBe(25);
    expect(custom.pool.min).toBe(2);
  });
});
