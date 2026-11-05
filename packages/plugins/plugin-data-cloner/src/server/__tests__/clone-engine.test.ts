/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import MssqlQuery from 'sequelize/lib/dialects/mssql/query';
import PostgresQuery from 'sequelize/lib/dialects/postgres/query';
import MysqlQuery from 'sequelize/lib/dialects/mysql/query';
import SqliteQuery from 'sequelize/lib/dialects/sqlite/query';
import { describe, expect, it, vi } from 'vitest';
import { CloneEngineService } from '../services/CloneEngineService';

function fixture(dialect = 'mssql', checkpoint?: number | string) {
  const cache = new Map<string, unknown>();
  const sourceQuery = vi
    .fn()
    .mockResolvedValueOnce([[{ id: 1 }]])
    .mockResolvedValueOnce([[{ id: 2 }]])
    .mockResolvedValue([[]]);
  const bulkInsert = vi.fn();
  const table = { id: 10, table_name: 'orders', sort_column: 'id', last_sync_value: checkpoint, status: 'pending' };
  const task = { id: 1, source_datasource_key: 'source', target_datasource_key: 'target' };
  const tableRepo = { find: vi.fn(async () => [table]), update: vi.fn() };
  const taskRepo = { findById: vi.fn(async () => task), update: vi.fn() };
  const source = {
    sequelize: {
      query: sourceQuery,
      getDialect: () => dialect,
      getQueryInterface: () => ({ quoteIdentifier: (name: string) => `"${name}"` }),
    },
  };
  const target = {
    sequelize: {
      query: vi.fn(async () => undefined),
      getQueryInterface: () => ({ bulkInsert, quoteIdentifier: (name: string) => `"${name}"` }),
    },
  };
  const app = {
    cache: {
      get: async (key: string) => cache.get(key),
      set: async (key: string, value: unknown) => {
        cache.set(key, value);
      },
    },
    db: { getRepository: (name: string) => (name === 'clone_tasks' ? taskRepo : tableRepo) },
    dataSourceManager: { get: (name: string) => ({ collectionManager: { db: name === 'source' ? source : target } }) },
    logger: { error: vi.fn(), warn: vi.fn() },
  };
  const engine = new CloneEngineService(app as unknown as Application);
  return { engine, cache, sourceQuery, bulkInsert, tableRepo, taskRepo, table };
}

describe('clone chunk and task completion', () => {
  it.each([
    ['mssql', MssqlQuery],
    ['postgres', PostgresQuery],
    ['mysql', MysqlQuery],
    ['sqlite', SqliteQuery],
  ])('binds every chunk and resume checkpoint using the %s formatter', async (dialect, Query) => {
    const { engine, sourceQuery, bulkInsert, cache } = fixture(dialect as string, 0);
    await engine.startTask(1, { chunkSize: 1 });
    expect(bulkInsert).toHaveBeenCalledTimes(2);
    expect(sourceQuery.mock.calls.map(([, options]) => options.bind)).toEqual([[0], [1], [2]]);
    for (const [sql, options] of sourceQuery.mock.calls) {
      const [formatted, binds] = Query.formatBindParameters(sql, options.bind, dialect);
      expect(sql).toContain('> $1');
      expect(formatted).toBeTypeOf('string');
      expect(Object.values(binds)).toEqual(options.bind);
    }
    expect(cache.get('CloneTask:1:status')).toBe('completed');
  });

  it('does not report success after a table failed and retries error tables on the next start', async () => {
    const { engine, sourceQuery, cache, tableRepo } = fixture();
    sourceQuery.mockReset().mockRejectedValueOnce(new Error('source unavailable'));
    await engine.startTask(1);
    expect(cache.get('CloneTask:1:status')).toBe('error');
    expect(tableRepo.update).toHaveBeenCalledWith({
      filterByTk: 10,
      values: { status: 'error', error_message: 'source unavailable' },
    });
    sourceQuery.mockResolvedValue([[]]);
    await engine.startTask(1);
    expect(tableRepo.find).toHaveBeenCalledWith({
      filter: { task_id: 1, status: { $in: ['pending', 'running', 'paused', 'error'] } },
    });
    expect(cache.get('CloneTask:1:status')).toBe('completed');
  });

  it('reports worker rejection as task error', async () => {
    const { engine, tableRepo, cache } = fixture();
    tableRepo.update.mockRejectedValue(new Error('cannot update table status'));
    await engine.startTask(1);
    expect(cache.get('CloneTask:1:status')).toBe('error');
  });

  it('retains pause status while marking running tables paused', async () => {
    const { engine, sourceQuery, cache, tableRepo } = fixture();
    sourceQuery.mockReset().mockImplementation(async () => {
      cache.set('CloneTask:1:status', 'paused');
      return [[]];
    });
    await engine.startTask(1);
    expect(cache.get('CloneTask:1:status')).toBe('paused');
    expect(tableRepo.update).toHaveBeenCalledWith({
      filter: { task_id: 1, status: 'running' },
      values: { status: 'paused' },
    });
  });
});
