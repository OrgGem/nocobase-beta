/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import type { Plugin } from '@nocobase/server';
import { vi } from 'vitest';
import { PluginAgentOrchestratorServer } from '../plugin';
import { runWithNativeUsageAttribution } from '../services/NativeUsageAttribution';
import { TokenTracker } from '../services/TokenTracker';

type UsageEvent = Record<string, unknown>;

const SESSION_A = '2a000000-0000-4000-8000-000000000001';
const SESSION_B = '2a000000-0000-4000-8000-000000000002';
const SESSION_C = '2a000000-0000-4000-8000-000000000003';

function event(sessionId: string, messageId: number, userId: number): UsageEvent {
  return {
    sessionId,
    messageId,
    userId,
    eventType: 'llm_message',
    role: 'assistant',
    model: 'sqlite-attribution-model',
    provider: 'sqlite-attribution-provider',
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    occurredAt: new Date('2026-11-10T04:00:00.000Z'),
  };
}

async function waitForUsage(app: MockServer, usageIdentity: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const row = await app.db.getRepository('agentExecutionSpans').findOne({ filter: { usageIdentity } });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return app.db.getRepository('agentExecutionSpans').findOne({ filter: { usageIdentity } });
}

function usageIdentity(sessionId: string, messageId: number) {
  return `ai-usage-event:${sessionId}:${messageId}`;
}

describe('native usage request attribution', () => {
  let app: MockServer;
  let ownerId: number;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `native-usage-attribution-${process.pid}`,
      skipSupervisor: true,
    });
    const owner = await app.db.getRepository('users').create({
      values: { username: `native-usage-owner-${process.pid}` },
    });
    ownerId = Number(owner.id);
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('persists only after commit and skips a rolled-back usage event', async () => {
    const scope = { db: app.db, userId: ownerId, departmentId: 31, sessionId: SESSION_A };
    const committedIdentity = usageIdentity(SESSION_A, 7001);
    const rolledBackIdentity = usageIdentity(SESSION_A, 7002);

    await app.db.sequelize.transaction(async (transaction) => {
      await runWithNativeUsageAttribution(scope, async () => {
        await app.db.getRepository('aiUsageEvents').create({
          values: event(SESSION_A, 7001, ownerId),
          transaction,
        });
      });
      expect(
        await app.db.getRepository('agentExecutionSpans').findOne({ filter: { usageIdentity: committedIdentity } }),
      ).toBeNull();
    });

    const committed = await waitForUsage(app, committedIdentity);
    expect(committed?.get('usageIdentity')).toBe(committedIdentity);
    expect(committed?.get('userId')).toBe(ownerId);
    expect(committed?.get('departmentId')).toBe(31);
    expect(committed?.get('departmentAttribution')).toBe('snapshot');

    await expect(
      app.db.sequelize.transaction(async (transaction) => {
        await runWithNativeUsageAttribution(scope, async () => {
          await app.db.getRepository('aiUsageEvents').create({
            values: event(SESSION_A, 7002, ownerId),
            transaction,
          });
        });
        throw new Error('rollback usage transaction');
      }),
    ).rejects.toThrow('rollback usage transaction');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      await app.db.getRepository('agentExecutionSpans').findOne({ filter: { usageIdentity: rolledBackIdentity } }),
    ).toBeNull();
  });

  it('keeps the first department snapshot when the same usage identity is replayed', async () => {
    const identity = usageIdentity(SESSION_B, 8001);
    await runWithNativeUsageAttribution(
      { db: app.db, userId: ownerId, departmentId: 41, sessionId: SESSION_B },
      async () => app.db.getRepository('aiUsageEvents').create({ values: event(SESSION_B, 8001, ownerId) }),
    );
    const original = await waitForUsage(app, identity);
    expect(original?.get('departmentId')).toBe(41);

    const plugin = { app: { logger: app.logger }, db: app.db } as unknown as Plugin;
    await new TokenTracker(plugin).syncNativeUsageEvents({ sessionId: SESSION_B, userId: ownerId });

    const replayed = await waitForUsage(app, identity);
    expect(replayed?.get('departmentId')).toBe(41);
    expect(await app.db.getRepository('agentExecutionSpans').count({ filter: { usageIdentity: identity } })).toBe(1);
  });

  it('records exact native usage for an unassigned user without inventing a department', async () => {
    const identity = usageIdentity(SESSION_C, 8501);
    await runWithNativeUsageAttribution({ db: app.db, userId: ownerId, sessionId: SESSION_C }, async () =>
      app.db.getRepository('aiUsageEvents').create({ values: event(SESSION_C, 8501, ownerId) }),
    );

    const row = await waitForUsage(app, identity);
    expect(row?.get('usageSource')).toBe('actual');
    expect(row?.get('inputTokens')).toBe(12);
    expect(row?.get('userId')).toBe(ownerId);
    expect(row?.get('departmentId')).toBeNull();
    expect(row?.get('departmentAttribution')).toBeNull();
  });

  it('isolates parallel request scopes and ignores events outside the matching owner and session', async () => {
    const identityA = usageIdentity(SESSION_A, 9001);
    const identityB = usageIdentity(SESSION_B, 9002);
    const identityOutside = usageIdentity(SESSION_A, 9003);
    const observed: Array<{ usageIdentity: string; userId?: string | number; departmentId?: string | number }> = [];
    const persist = vi.spyOn(TokenTracker.prototype, 'recordModelCallUsage').mockImplementation(async (input) => {
      observed.push({ usageIdentity: input.usageIdentity, userId: input.userId, departmentId: input.departmentId });
      return input.usageIdentity;
    });
    try {
      await Promise.all([
        runWithNativeUsageAttribution({ db: app.db, userId: 301, departmentId: 51, sessionId: SESSION_A }, async () => {
          await Promise.resolve();
          app.db.emit('aiUsageEvents.afterCreate', event(SESSION_A, 9001, 301));
          app.db.emit('aiUsageEvents.afterCreate', event(SESSION_A, 9003, 302));
        }),
        runWithNativeUsageAttribution({ db: app.db, userId: 302, departmentId: 52, sessionId: SESSION_B }, async () => {
          await Promise.resolve();
          app.db.emit('aiUsageEvents.afterCreate', event(SESSION_B, 9002, 302));
        }),
      ]);
    } finally {
      persist.mockRestore();
    }

    expect(observed).toEqual([
      { usageIdentity: identityA, userId: 301, departmentId: 51 },
      { usageIdentity: identityB, userId: 302, departmentId: 52 },
    ]);
    expect(observed.map((row) => row.usageIdentity)).not.toContain(identityOutside);
  });
});
