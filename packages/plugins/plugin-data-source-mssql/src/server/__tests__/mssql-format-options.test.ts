// SPDX-License-Identifier: Apache-2.0

import {
  buildSessionInitSql,
  formatDatabaseOptions,
  formatProbeDatabaseOptions,
} from '../data-source/MssqlExternalDataSource';

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

  it('maps trustServerCertificate, readOnlyIntent, requestTimeout, and runtime options', () => {
    const opts = formatDatabaseOptions({
      trustServerCertificate: false,
      readOnlyIntent: true,
      requestTimeout: 30000,
      fastCount: true,
      deferredJoinThreshold: 500,
    });
    expect(opts.dialectOptions.options.trustServerCertificate).toBe(false);
    expect(opts.dialectOptions.options.readOnlyIntent).toBe(true);
    expect(opts.dialectOptions.options.requestTimeout).toBe(30000);
    expect(opts.mssqlRuntimeOptions).toEqual({ fastCount: true, deferredJoinThreshold: 500 });
  });

  it('logs slow queries exceeding threshold via benchmark logging', () => {
    const warn = vi.fn();
    const opts = formatDatabaseOptions({ slowQueryThresholdMs: 500, logger: { warn } });
    expect(opts.benchmark).toBe(true);
    expect(typeof opts.logging).toBe('function');
    (opts.logging as (sql: string, timing?: number) => void)('SELECT 1', 100);
    expect(warn).not.toHaveBeenCalled();
    (opts.logging as (sql: string, timing?: number) => void)('SELECT * FROM BigTable', 1500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[MSSQL] Slow query (1500ms)'));
  });

  it('creates lightweight probe options with min=0, max=1, and fast timeouts', () => {
    const probe = formatProbeDatabaseOptions({ host: 'localhost', database: 'db' });
    expect(probe.pool).toMatchObject({ max: 1, min: 0 });
    expect(probe.dialectOptions.options.connectTimeout).toBe(10000);
    expect(probe.dialectOptions.options.requestTimeout).toBe(15000);
  });

  it('maps readUncommitted only to connectionIsolationLevel so explicit write transactions stay READ COMMITTED', () => {
    const opts = formatDatabaseOptions({ readUncommitted: true });
    expect(opts.dialectOptions.options.isolationLevel).toBeUndefined();
    expect(opts.dialectOptions.options.connectionIsolationLevel).toBe(0x01);

    const defaultOpts = formatDatabaseOptions({});
    expect(defaultOpts.dialectOptions.options.isolationLevel).toBeUndefined();
    expect(defaultOpts.dialectOptions.options.connectionIsolationLevel).toBeUndefined();
  });

  it('builds safe session init SQL for lockTimeout only', () => {
    expect(buildSessionInitSql({})).toBe('');
    expect(buildSessionInitSql({ lockTimeout: 0 })).toBe('');
    expect(buildSessionInitSql({ lockTimeout: 5000 })).toBe('SET LOCK_TIMEOUT 5000;');
  });
});
