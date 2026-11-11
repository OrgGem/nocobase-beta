/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { PluginAgentOrchestratorServer } from '../plugin';
import { NativeAgentMonitorSyncService } from '../services/NativeAgentMonitorSyncService';

const NATIVE_SOURCE = 'native-plugin-ai';

describe('agent monitor HTTP ACL and session scope', () => {
  let app: MockServer;
  let ownerAgent: ReturnType<MockServer['agent']>;
  let otherAgent: ReturnType<MockServer['agent']>;
  let adminAgent: ReturnType<MockServer['agent']>;
  let ownerId: number;
  let otherRootId: string;
  let rootAId: string;
  let rootBId: string;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `agent-monitor-acl-${process.pid}`,
      acl: true,
      skipSupervisor: true,
    });

    const users = app.db.getRepository('users');
    const owner = await users.create({ values: { roles: ['member'] } });
    const other = await users.create({ values: { roles: ['member'] } });
    const admin = await users.findOne({ filter: { 'roles.name': 'root' } });
    if (!admin) throw new Error('Mock server did not create its root user.');
    ownerId = Number(owner.id);
    ownerAgent = await app.agent().login(owner);
    otherAgent = await app.agent().login(other);
    adminAgent = await app.agent().login(admin);

    const spans = app.db.getRepository('agentExecutionSpans');
    const now = new Date();
    const rootA = await spans.create({
      values: {
        rootRunId: 'shared-legacy-run',
        source: NATIVE_SOURCE,
        type: 'main_agent',
        status: 'unknown',
        parentSessionId: '10000000-0000-4000-8000-000000000001',
        subSessionId: '10000000-0000-4000-8000-000000000001',
        userId: ownerId,
        input: { prompt: 'private input for session A' },
        output: 'private output for session A',
        error: 'private error for session A',
        metadata: { nativeSessionId: 'secret-a', nativeStatus: 'idle', private: 'raw native metadata' },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const rootB = await spans.create({
      values: {
        rootRunId: 'shared-legacy-run',
        source: NATIVE_SOURCE,
        type: 'main_agent',
        status: 'unknown',
        parentSessionId: '10000000-0000-4000-8000-000000000002',
        subSessionId: '10000000-0000-4000-8000-000000000002',
        userId: ownerId,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    rootAId = String(rootA.id);
    rootBId = String(rootB.id);

    await spans.create({
      values: {
        rootRunId: 'shared-legacy-run',
        parentSpanId: rootAId,
        source: NATIVE_SOURCE,
        type: 'model_call',
        status: 'success',
        usageIdentity: 'monitor-acl:session-a:model-call',
        usageSource: 'actual',
        inputTokens: 11,
        outputTokens: 5,
        totalTokens: 16,
        cost: 0.12,
        userId: ownerId,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await spans.create({
      values: {
        rootRunId: 'shared-legacy-run',
        parentSpanId: rootAId,
        source: NATIVE_SOURCE,
        type: 'tool',
        status: 'success',
        toolCallId: 'monitor-acl:tool-a',
        toolName: 'session-a-tool',
        userId: ownerId,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await spans.create({
      values: {
        rootRunId: 'shared-legacy-run',
        parentSpanId: rootBId,
        source: NATIVE_SOURCE,
        type: 'model_call',
        status: 'success',
        usageIdentity: 'monitor-acl:session-b:model-call',
        usageSource: 'actual',
        inputTokens: 700,
        outputTokens: 300,
        totalTokens: 1000,
        cost: 9,
        userId: ownerId,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await spans.create({
      values: {
        rootRunId: 'shared-legacy-run',
        parentSpanId: rootBId,
        source: NATIVE_SOURCE,
        type: 'tool',
        status: 'success',
        toolCallId: 'monitor-acl:tool-b',
        toolName: 'session-b-tool',
        userId: ownerId,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });

    const otherRoot = await spans.create({
      values: {
        rootRunId: 'other-users-run',
        source: NATIVE_SOURCE,
        type: 'main_agent',
        status: 'unknown',
        parentSessionId: '20000000-0000-4000-8000-000000000001',
        subSessionId: '20000000-0000-4000-8000-000000000001',
        userId: Number(other.id),
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    otherRootId = String(otherRoot.id);

    vi.spyOn(NativeAgentMonitorSyncService.prototype, 'sync').mockResolvedValue({
      data: {
        coverage: {
          source: 'persisted-native-records',
          realtime: false,
          granularity: 'conversation-session-and-persisted-calls',
          note: 'bounded test reconciliation',
          contentCapture: 'omitted-without-invocation-policy-snapshot',
          maxRelationsPerMessage: 100,
          traceRetentionDays: 30,
        },
        counts: {
          conversations: 1,
          messages: 0,
          linkedSubAgents: 0,
          toolMessages: 0,
          modelCalls: 0,
          skipped: 0,
          correlationIncomplete: 0,
        },
        pages: {
          conversations: { processed: 1, hasMore: true },
          messages: { processed: 0, hasMore: false },
          toolMessages: { processed: 0, hasMore: false },
          usageEvents: { processed: 0, hasMore: false },
        },
        complete: false,
        cursor: {
          version: 2,
          conversations: { after: 'session-a' },
          messages: { done: true },
          toolMessages: { done: true },
          usageEvents: { done: true },
        },
      },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.destroy();
  });

  it('scopes list and detail to the authenticated owner and excludes native content', async () => {
    const ownerList = await ownerAgent.resource('agentMonitor').list();
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.data.data.map((row: { id: number }) => String(row.id))).toEqual(
      expect.arrayContaining([rootAId, rootBId]),
    );
    expect(ownerList.body.data.data.some((row: { id: number }) => String(row.id) === otherRootId)).toBe(false);

    const otherList = await otherAgent.resource('agentMonitor').list();
    expect(otherList.status).toBe(200);
    expect(otherList.body.data.data).toHaveLength(1);
    expect(String(otherList.body.data.data[0].id)).toBe(otherRootId);

    const forbiddenDetail = await otherAgent.resource('agentMonitor').get({ filterByTk: rootAId });
    expect(forbiddenDetail.status).toBe(403);

    const detail = await ownerAgent.resource('agentMonitor').get({ filterByTk: rootAId });
    expect(detail.status).toBe(200);
    expect(detail.body.data.data.usage).toMatchObject({ modelCalls: 1, inputTokens: 11, outputTokens: 5, cost: 0.12 });
    expect(detail.body.data.data.trace.map((row: { spanId: string | number }) => String(row.spanId))).not.toContain(
      rootBId,
    );
    expect(detail.body.data.data.input).toBeUndefined();
    expect(detail.body.data.data.output).toBeUndefined();
    expect(detail.body.data.data.error).toBeUndefined();
    expect(detail.body.data.data.metadata.private).toBeUndefined();
    expect(detail.body.data.data.metadata.nativeSessionId).toBeUndefined();
    expect(detail.body.data.data.nativeMessages).toEqual([]);
    expect(detail.body.data.data.toolMessages).toEqual([]);
  });

  it('uses parent-span ancestry for child filters when roots share a legacy run id', async () => {
    const response = await ownerAgent.resource('agentMonitor').list({ filter: { toolName: 'session-b-tool' } });
    expect(response.status).toBe(200);
    expect(response.body.data.meta.filterDepthLimit).toBe(32);
    expect(response.body.data.data.map((row: { id: number }) => String(row.id))).toEqual([rootBId]);
  });

  it('keeps sync and harness capability actions behind admin ACL and preserves the wrapped cursor', async () => {
    const ownerSync = await ownerAgent.resource('agentMonitor').sync({
      values: { limit: 1, cursor: { version: 2, conversations: {}, messages: {}, toolMessages: {}, usageEvents: {} } },
    });
    expect(ownerSync.status).toBe(403);

    const adminSync = await adminAgent.resource('agentMonitor').sync({
      values: { limit: 1, cursor: { version: 2, conversations: {}, messages: {}, toolMessages: {}, usageEvents: {} } },
    });
    expect(adminSync.status).toBe(200);
    const responseCursor = adminSync.body.data.data.cursor as Record<string, unknown>;
    expect(responseCursor).toMatchObject({
      version: 2,
      conversations: { after: 'session-a' },
      messages: { done: true },
    });
    const apiResponse = { data: adminSync.body };
    const payload = (apiResponse as { data?: { data?: { data?: { cursor?: Record<string, unknown> } } } }).data?.data;
    const uiResult = (payload as { data?: { cursor?: Record<string, unknown> } })?.data || payload;
    expect((uiResult as { cursor?: Record<string, unknown> }).cursor).toEqual(responseCursor);

    const ownerCapabilities = await ownerAgent.resource('agentHarnessProfiles').capabilities();
    expect(ownerCapabilities.status).toBe(403);
    const adminCapabilities = await adminAgent.resource('agentHarnessProfiles').capabilities();
    expect(adminCapabilities.status).toBe(200);
    expect(adminCapabilities.body.data.data).toBeTruthy();
  });
});
