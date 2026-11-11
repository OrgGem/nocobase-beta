/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import { createMockServer, type MockServer } from '@nocobase/test';
import { PluginAgentOrchestratorServer } from '../plugin';
import { NativeAgentMonitorSyncService } from '../services/NativeAgentMonitorSyncService';
import { NATIVE_SOURCE } from '../services/NativeSubAgentObserver';

type SourceRow = Record<string, unknown>;
type SpanRow = { get: (name: string) => unknown };
type SourceOptions = Record<string, unknown>;
type SourceRepository = {
  find: (options?: SourceOptions) => Promise<unknown[]>;
  findOne: (options: SourceOptions) => Promise<unknown>;
};
type SourceName = 'aiConversations' | 'aiMessages' | 'aiToolMessages' | 'aiUsageEvents';
type SourceTables = Record<SourceName, SourceRow[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compare(left: unknown, right: unknown) {
  const leftValue = left instanceof Date ? left.getTime() : left;
  const rightValue = right instanceof Date ? right.getTime() : right;
  if (typeof leftValue === 'number' && typeof rightValue === 'number') return leftValue - rightValue;
  return String(leftValue ?? '').localeCompare(String(rightValue ?? ''));
}

function matches(row: SourceRow, filter: unknown): boolean {
  if (!isRecord(filter)) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(expected)) {
      if (!expected.every((part) => matches(row, part))) return false;
      continue;
    }
    const actual = row[key];
    if (isRecord(expected)) {
      if ('$ne' in expected && actual === expected.$ne) return false;
      if ('$gt' in expected && compare(actual, expected.$gt) <= 0) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function makeSourceRepository(rows: SourceRow[]): SourceRepository {
  const find = async (options: SourceOptions = {}) => {
    const filterRows = rows.filter((row) => matches(row, options.filter));
    const sort = Array.isArray(options.sort) ? options.sort : [];
    const [sortField] = sort;
    if (typeof sortField === 'string') {
      const descending = sortField.startsWith('-');
      const field = descending ? sortField.slice(1) : sortField;
      filterRows.sort((left, right) => compare(left[field], right[field]) * (descending ? -1 : 1));
    }
    const limit = Number(options.limit);
    return Number.isFinite(limit) && limit >= 0 ? filterRows.slice(0, limit) : filterRows;
  };
  return {
    find,
    async findOne(options) {
      if (options.filterByTk !== undefined) {
        const row = rows.find((item) => String(item.id) === String(options.filterByTk));
        return row || null;
      }
      const found = await find({ ...options, limit: 1 });
      return found[0] || null;
    },
  };
}

function emptySources(): SourceTables {
  return { aiConversations: [], aiMessages: [], aiToolMessages: [], aiUsageEvents: [] };
}

function makeService(app: MockServer, sources: SourceTables) {
  const sourceRepositories = Object.fromEntries(
    Object.entries(sources).map(([name, rows]) => [name, makeSourceRepository(rows)]),
  ) as Record<SourceName, SourceRepository>;
  const originalGetRepository = app.db.getRepository.bind(app.db);
  const plugin = {
    app: { logger: app.logger },
    db: {
      getRepository(name: string) {
        return name in sourceRepositories ? sourceRepositories[name as SourceName] : originalGetRepository(name);
      },
    },
  } as unknown as ConstructorParameters<typeof NativeAgentMonitorSyncService>[0];
  return new NativeAgentMonitorSyncService(plugin);
}

function conversation(sessionId: string, createdAt = new Date(), options: Record<string, unknown> = {}) {
  return {
    sessionId,
    from: 'main-agent',
    aiEmployeeUsername: 'atlas',
    userId: null,
    llmActiveState: 'idle',
    options,
    createdAt,
    updatedAt: createdAt,
  } satisfies SourceRow;
}

describe('NativeAgentMonitorSyncService', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `native-monitor-sync-${process.pid}`,
      skipSupervisor: true,
    });
  });

  beforeEach(async () => {
    await app.db.getRepository('agentExecutionSpans').destroy({ filter: { source: NATIVE_SOURCE } });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('pages a full pass and replays conversations idempotently', async () => {
    const sources = emptySources();
    const firstSession = '10000000-0000-4000-8000-000000000001';
    const secondSession = '10000000-0000-4000-8000-000000000002';
    sources.aiConversations.push(conversation(firstSession), conversation(secondSession));
    const service = makeService(app, sources);

    const firstPage = await service.sync({ limit: 1 });
    expect(firstPage.data.complete).toBe(false);
    expect(firstPage.data.cursor?.conversations).toEqual({ after: firstSession });
    expect(firstPage.data.pages.conversations).toEqual({ processed: 1, hasMore: true });

    const secondPage = await service.sync({ limit: 1, cursor: firstPage.data.cursor });
    expect(secondPage.data.complete).toBe(false);
    expect(secondPage.data.cursor?.conversations).toEqual({ after: secondSession });
    expect(secondPage.data.pages.conversations).toEqual({ processed: 1, hasMore: true });

    const finalPage = await service.sync({ limit: 1, cursor: secondPage.data.cursor });
    expect(finalPage.data.complete).toBe(true);
    expect(finalPage.data.cursor).toBeNull();
    expect(finalPage.data.pages.conversations).toEqual({ processed: 0, hasMore: false });

    const replay = await service.sync({ limit: 10 });
    expect(replay.data.complete).toBe(true);
    const roots = await app.db.getRepository('agentExecutionSpans').find({
      filter: { source: NATIVE_SOURCE, type: 'main_agent' },
    });
    expect(roots).toHaveLength(2);
    expect((roots as SpanRow[]).map((row) => row.get('nativeIdentity')).sort()).toEqual(
      [`native:conversation:${firstSession}`, `native:conversation:${secondSession}`].sort(),
    );
  });

  it('adopts legacy dispatches, keeps shared-run sessions scoped, reconciles failures, preserves known usage, and drops expired sources', async () => {
    const sources = emptySources();
    const parentA = randomUUID();
    const parentB = randomUUID();
    const childA = randomUUID();
    const oldSession = randomUUID();
    const now = new Date();
    const oldDate = new Date(Date.now() - 20 * 365 * 86400000);
    const run = await app.db.getRepository('agentLoopRuns').create({
      values: { rootRunId: 'shared-native-control-run', goal: 'native test', status: 'running' },
    });
    sources.aiConversations.push(
      conversation(parentA, now, { controlPlaneRunId: run.id }),
      conversation(parentB, now, { controlPlaneRunId: run.id }),
      { ...conversation(childA, now), from: 'sub-agent' },
      conversation(oldSession, oldDate),
    );
    const messageId = 'message-a';
    const toolCallId = 'dispatch-call-a';
    sources.aiMessages.push({
      sessionId: parentA,
      messageId,
      createdAt: now,
      updatedAt: now,
      metadata: {
        subAgentConversations: [{ sessionId: childA, toolCallId, status: 'pending' }],
      },
    });
    const toolMessage = {
      id: 'tool-row-a',
      sessionId: parentA,
      messageId,
      toolCallId,
      toolName: 'dispatch-sub-agent-task',
      invokeStatus: 'pending',
      status: 'pending',
      content: { sessionId: childA },
      createdAt: now,
      updatedAt: now,
    } satisfies SourceRow;
    sources.aiToolMessages.push(toolMessage, {
      id: 'tool-row-old',
      sessionId: oldSession,
      messageId: 'old-message',
      toolCallId: 'old-tool-call',
      toolName: 'run-tool',
      invokeStatus: 'done',
      createdAt: oldDate,
      updatedAt: oldDate,
    });
    const usageEvent: SourceRow = {
      id: 'usage-event-a',
      sessionId: parentA,
      messageId,
      eventType: 'llm_message',
      occurredAt: now.getTime(),
      role: 'assistant',
      model: 'test-model',
      inputTokens: 33,
      outputTokens: 14,
      totalTokens: 47,
      cachedTokens: 0,
      reasoningTokens: 0,
      rawUsageMetadata: { prompt_tokens: 33, completion_tokens: 14, total_tokens: 47 },
    };
    sources.aiUsageEvents.push(usageEvent, {
      id: 'usage-event-old',
      sessionId: oldSession,
      messageId: 'old-message',
      eventType: 'llm_message',
      occurredAt: oldDate.getTime(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      rawUsageMetadata: {},
    });

    const spans = app.db.getRepository('agentExecutionSpans');
    const legacySubAgent = await spans.create({
      values: {
        rootRunId: 'shared-native-control-run',
        source: NATIVE_SOURCE,
        type: 'sub_agent',
        status: 'running',
        nativeIdentity: null,
        parentSessionId: parentA,
        subSessionId: childA,
        toolCallId,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });

    const service = makeService(app, sources);
    await service.sync({ limit: 500 });
    const adopted = await spans.findOne({ filter: { nativeIdentity: `native:tool-call:${toolCallId}` } });
    const rootA = await spans.findOne({ filter: { nativeIdentity: `native:conversation:${parentA}` } });
    const rootB = await spans.findOne({ filter: { nativeIdentity: `native:conversation:${parentB}` } });
    expect(adopted?.id).toBe(legacySubAgent.id);
    expect(String(adopted?.get('parentSpanId'))).toBe(String(rootA?.id));
    expect(rootA?.get('rootRunId')).toBe('shared-native-control-run');
    expect(rootB?.get('rootRunId')).toBe('shared-native-control-run');
    expect(rootA?.id).not.toBe(rootB?.id);

    const usageIdentity = `ai-usage-event:${parentA}:${messageId}`;
    const usageSpan = await spans.findOne({ filter: { usageIdentity } });
    expect(usageSpan?.get('inputTokens')).toBe(33);
    expect(usageSpan?.get('outputTokens')).toBe(14);
    expect(String(usageSpan?.get('parentSpanId'))).toBe(String(rootA?.id));

    toolMessage.invokeStatus = 'failed';
    usageEvent.inputTokens = 0;
    usageEvent.outputTokens = 0;
    usageEvent.totalTokens = 0;
    usageEvent.rawUsageMetadata = {};
    const replay = await service.sync({ limit: 500 });
    const failedDispatch = await spans.findOne({ filter: { nativeIdentity: `native:tool-call:${toolCallId}` } });
    const preservedUsage = await spans.findOne({ filter: { usageIdentity } });
    expect(failedDispatch?.get('status')).toBe('error');
    expect(preservedUsage?.get('inputTokens')).toBe(33);
    expect(preservedUsage?.get('outputTokens')).toBe(14);
    expect(replay.data.counts.skipped).toBeGreaterThan(0);
    expect(await spans.findOne({ filter: { nativeIdentity: `native:conversation:${oldSession}` } })).toBeNull();
    expect(await spans.findOne({ filter: { toolCallId: 'old-tool-call' } })).toBeNull();
    const expiredUsage = await spans.findOne({ filter: { usageIdentity: `ai-usage-event:${oldSession}:old-message` } });
    expect(expiredUsage?.get('type')).toBe('model_call');
    expect(expiredUsage?.get('parentSpanId')).toBeFalsy();
    const nativeRows = await spans.find({ filter: { source: NATIVE_SOURCE } });
    expect((nativeRows as SpanRow[]).some((row) => row.get('parentSessionId') === oldSession)).toBe(false);
  });

  it('does not expose an advanced page cursor when a source page fails and retries from the supplied cursor', async () => {
    const sources = emptySources();
    const sessionId = randomUUID();
    const now = new Date();
    sources.aiConversations.push(conversation(sessionId, now));
    sources.aiMessages.push(
      { sessionId, messageId: 'message-a', createdAt: now, updatedAt: now, metadata: {} },
      { sessionId, messageId: 'message-b', createdAt: now, updatedAt: now, metadata: {} },
    );
    const service = makeService(app, sources);
    const initial = await service.sync({ limit: 1 });
    const cursor = initial.data.cursor;
    expect(cursor?.messages).toEqual({ after: 'message-a' });

    const originalMessageFind = makeSourceRepository(sources.aiMessages).find;
    const failingPlugin = {
      app: { logger: app.logger },
      db: {
        getRepository(name: string) {
          if (name === 'aiMessages') {
            return {
              find: async (options?: SourceOptions) => {
                if (options?.filter) throw new Error('injected source page failure');
                return originalMessageFind(options);
              },
              findOne: makeSourceRepository(sources.aiMessages).findOne,
            };
          }
          return makeServiceRepository(app, sources, name);
        },
      },
    } as unknown as ConstructorParameters<typeof NativeAgentMonitorSyncService>[0];
    const failingService = new NativeAgentMonitorSyncService(failingPlugin);
    const cursorSnapshot = JSON.stringify(cursor);
    await expect(failingService.sync({ limit: 1, cursor })).rejects.toThrow('injected source page failure');
    expect(JSON.stringify(cursor)).toBe(cursorSnapshot);

    const retry = await service.sync({ limit: 1, cursor });
    expect(retry.data.pages.messages).toEqual({ processed: 1, hasMore: true });
    expect(retry.data.complete).toBe(false);
    const retryFinalPage = await service.sync({ limit: 1, cursor: retry.data.cursor });
    expect(retryFinalPage.data.pages.messages).toEqual({ processed: 0, hasMore: false });
    expect(retryFinalPage.data.complete).toBe(true);
  });
});

function makeServiceRepository(app: MockServer, sources: SourceTables, name: string) {
  const sourceNames: SourceName[] = ['aiConversations', 'aiMessages', 'aiToolMessages', 'aiUsageEvents'];
  if ((sourceNames as string[]).includes(name)) {
    return makeSourceRepository(sources[name as SourceName]);
  }
  return app.db.getRepository(name);
}
