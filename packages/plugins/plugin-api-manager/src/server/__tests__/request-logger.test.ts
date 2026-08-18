import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import { pruneExpiredLogs, writeRequestLog } from '../services/request-logger';
import { createTestApp } from './helpers';

async function insertLog(app: MockServer, requestId: string, createdAt: Date) {
  await writeRequestLog(app.db, {
    requestId,
    status: 'ok',
    httpStatus: 200,
    startedAt: createdAt,
    finishedAt: createdAt,
    durationMs: 1,
  });
  // Sequelize strips createdAt from model.update() values, so backdate via the query interface.
  const model = app.db.getCollection('apiRequestLogs').model;
  const tableName = model.getTableName();
  await app.db.sequelize
    .getQueryInterface()
    .bulkUpdate(
      typeof tableName === 'string' ? tableName : tableName.tableName,
      { createdAt: createdAt.toISOString() },
      { requestId },
    );
}

describe('request-logger', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createTestApp();
  }, 300000);

  afterAll(async () => {
    await app?.destroy();
  });

  it('writeRequestLog persists an entry', async () => {
    await writeRequestLog(app.db, {
      requestId: 'req-write-1',
      routeName: 'r1',
      direction: 'inbound',
      method: 'POST',
      path: '/api/apim/inbound/r1',
      status: 'ok',
      httpStatus: 200,
      upstreamStatus: 200,
      attempt: 1,
      requestBytes: 10,
      responseBytes: 20,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 5,
    });
    const row = await app.db.getRepository('apiRequestLogs').findOne({ filter: { requestId: 'req-write-1' } });
    expect(row).toBeTruthy();
    expect(row?.get('routeName')).toBe('r1');
    expect(row?.get('durationMs')).toBe(5);
  });

  it('pruneExpiredLogs removes only rows older than the retention window', async () => {
    const now = Date.now();
    await insertLog(app, 'req-old', new Date(now - 40 * 24 * 60 * 60 * 1000)); // 40 days old
    await insertLog(app, 'req-new', new Date(now - 1 * 24 * 60 * 60 * 1000)); // 1 day old

    const removed = await pruneExpiredLogs(app.db, 30);
    expect(removed).toBeGreaterThanOrEqual(1);

    const repo = app.db.getRepository('apiRequestLogs');
    expect(await repo.findOne({ filter: { requestId: 'req-old' } })).toBeNull();
    expect(await repo.findOne({ filter: { requestId: 'req-new' } })).toBeTruthy();
  });
});
