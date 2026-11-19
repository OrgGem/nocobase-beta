// SPDX-License-Identifier: Apache-2.0
import { createMockServer, type MockServer } from '@nocobase/test';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PluginAgentOrchestratorServer } from '../plugin';
import { getAIToolsManager } from '../utils/ai-manager';

type InterruptCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  interrupt: boolean;
};

describe('session auto-approval checkpoints', () => {
  let app: MockServer;
  let ownerAgent: ReturnType<MockServer['agent']>;
  let ownerId: number;
  let username: string;
  let toolA: string;
  let toolB: string;
  let backendTool: string;
  let messageSequence: number;

  beforeAll(async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    username = 'dex';
    toolA = `checkpoint_tool_a_${suffix.replace(/-/g, '_')}`;
    toolB = `checkpoint_tool_b_${suffix.replace(/-/g, '_')}`;
    backendTool = `checkpoint_backend_${suffix.replace(/-/g, '_')}`;
    messageSequence = Date.now() * 1000;
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `auto-approval-checkpoint-${suffix}`,
      acl: true,
      skipSupervisor: true,
    });

    const owner = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    if (!owner) throw new Error('Mock server did not seed a root user.');
    ownerId = Number(owner.id);
    ownerAgent = await app.agent().login(owner);

    const tools = getAIToolsManager(app);
    for (const name of [toolA, toolB, backendTool]) {
      tools.registerTools({
        scope: 'CUSTOM',
        execution: 'backend',
        defaultPermission: 'ALLOW',
        definition: {
          name,
          description: 'Tool fixture for automatic approval checkpoint tests.',
          schema: z.object({ value: z.string().optional() }),
        },
        invoke: async (_ctx: unknown, input: { value?: string }) => ({
          status: 'success',
          content: input.value ?? 'ok',
        }),
      });
    }
  });

  afterAll(async () => {
    await app?.destroy();
  });

  const createCheckpointFixture = async (input: { calls?: InterruptCall[]; interruptId?: string } = {}) => {
    const sessionId = randomUUID();
    const messageId = ++messageSequence;
    const interruptId = input.interruptId ?? `interrupt-${randomUUID()}`;
    const calls = input.calls ?? [
      { id: `call-a-${randomUUID()}`, name: toolA, args: { value: 'A' }, interrupt: true },
      { id: `call-b-${randomUUID()}`, name: toolB, args: { value: 'B' }, interrupt: true },
      { id: `call-backend-${randomUUID()}`, name: backendTool, args: { value: 'done' }, interrupt: false },
    ];
    await app.db.getRepository('aiConversations').create({
      values: { sessionId, userId: ownerId, aiEmployeeUsername: username, title: 'Approval checkpoint fixture' },
    });
    const message = await app.db.getRepository(`aiConversations.messages`, sessionId).create({
      values: {
        messageId,
        role: username,
        content: { type: 'text', content: 'Approval checkpoint fixture.' },
        toolCalls: calls.map(({ id, name, args }) => ({ id, name, args })),
        metadata: { interruptId },
      },
    });
    const toolMessages = app.db.getRepository('aiToolMessages');
    for (const [index, call] of calls.entries()) {
      const invokeStatus = call.interrupt ? 'interrupted' : 'done';
      await toolMessages.create({
        values: {
          id: ++messageSequence,
          sessionId,
          messageId,
          toolCallId: call.id,
          toolName: call.name,
          status: call.interrupt ? null : 'success',
          content: call.interrupt ? null : 'previously completed',
          invokeStatus,
          auto: !call.interrupt,
          execution: 'backend',
          interruptActionOrder: index,
          interruptAction: call.interrupt
            ? {
                order: index,
                toolCall: { id: call.id, name: call.name, args: call.args },
                allowedDecisions: ['approve', 'reject', 'edit'],
                currentConversation: { sessionId, username, from: 'main-agent' },
              }
            : null,
        },
      });
    }
    await app.db.getRepository('agentSessionAutoApprovals').create({ values: { ownerId, sessionId, enabled: true } });
    return { sessionId, messageId: String(messageId), interruptId, calls, message };
  };

  const decide = (
    identity: { sessionId: string; messageId: string; toolCallId: string },
    decision: 'approve' | 'reject',
    automatic = false,
  ) =>
    ownerAgent.resource('aiConversations').updateUserDecision({
      values: {
        ...identity,
        userDecision: { type: decision },
        ...(automatic ? { agentAutoApproval: true } : {}),
      },
    });

  it('lets one manual rejection finalize an enrolled checkpoint after automatic approval is disabled', async () => {
    const fixture = await createCheckpointFixture();
    const [callA, callB] = fixture.calls;
    if (!callA || !callB) throw new Error('The multi-tool checkpoint fixture is incomplete.');
    const first = await decide(
      { sessionId: fixture.sessionId, messageId: fixture.messageId, toolCallId: callA.id },
      'approve',
      true,
    );
    const firstData = first.body.data;
    expect(first.status).toBe(200);
    expect(firstData.updated).toBe(0);
    expect(firstData.agentAutoApprovalCheckpoint).toMatchObject({
      interruptId: fixture.interruptId,
      decisionRecorded: true,
      canFinalize: false,
      validSnapshot: true,
    });
    expect(firstData.toolCalls).toHaveLength(3);
    expect(firstData.toolCalls.find((call: { id: string }) => call.id === callA.id)).toMatchObject({
      invokeStatus: 'waiting',
      userDecision: { type: 'approve' },
      willInterrupt: true,
    });
    expect(firstData.toolCalls.find((call: { id: string }) => call.id === callB.id)).toMatchObject({
      invokeStatus: 'interrupted',
      willInterrupt: true,
    });
    expect(firstData.toolCalls.find((call: { name: string }) => call.name === backendTool)).toMatchObject({
      invokeStatus: 'done',
      willInterrupt: false,
    });

    await ownerAgent.resource('agentAutoApproval').set({
      values: { sessionId: fixture.sessionId, enabled: false },
    });
    const final = await decide(
      { sessionId: fixture.sessionId, messageId: fixture.messageId, toolCallId: callB.id },
      'reject',
    );
    expect(final.status).toBe(200);
    expect(final.body.data.updated).toBe(1);
    expect(final.body.data.agentAutoApprovalCheckpoint).toMatchObject({
      interruptId: fixture.interruptId,
      decisionRecorded: true,
      canFinalize: true,
      validSnapshot: true,
    });
    expect(final.body.data.toolCalls).toHaveLength(3);
    expect(final.body.data.toolCalls.map((call: { invokeStatus: string }) => call.invokeStatus)).toEqual([
      'waiting',
      'waiting',
      'done',
    ]);
    expect(final.body.data.toolCalls[1].userDecision).toEqual({ type: 'reject' });
    expect(final.body.data.toolCalls[2].willInterrupt).toBe(false);

    const duplicate = await decide(
      { sessionId: fixture.sessionId, messageId: fixture.messageId, toolCallId: callB.id },
      'reject',
    );
    expect(duplicate.body.data.updated).toBe(0);
    expect(duplicate.body.data.agentAutoApprovalCheckpoint.canFinalize).toBe(false);
    expect(
      await app.db.getRepository('agentAutoApprovalCheckpoints').count({
        filter: { ownerId, sessionId: fixture.sessionId, interruptId: fixture.interruptId, status: 'issued' },
      }),
    ).toBe(1);
  });

  it('issues a checkpoint exactly once for concurrent native decisions', async () => {
    const fixture = await createCheckpointFixture();
    const [callA, callB] = fixture.calls;
    if (!callA || !callB) throw new Error('The multi-tool checkpoint fixture is incomplete.');

    const results = await Promise.all(
      [callA, callB].map((call) =>
        decide({ sessionId: fixture.sessionId, messageId: fixture.messageId, toolCallId: call.id }, 'approve', true),
      ),
    );

    expect(results.filter((result) => result.body.data.updated === 1)).toHaveLength(1);
    expect(results.filter((result) => result.body.data.agentAutoApprovalCheckpoint?.canFinalize === true)).toHaveLength(
      1,
    );
    expect(
      await app.db.getRepository('agentAutoApprovalCheckpoints').count({
        filter: { ownerId, sessionId: fixture.sessionId, interruptId: fixture.interruptId, status: 'issued' },
      }),
    ).toBe(1);
  });

  it('uses a fresh claim for a new interrupt and keeps single-tool approval on the native path', async () => {
    const fixture = await createCheckpointFixture();
    const callA = fixture.calls[0];
    if (!callA) throw new Error('The checkpoint fixture has no first tool.');
    const first = await decide(
      { sessionId: fixture.sessionId, messageId: fixture.messageId, toolCallId: callA.id },
      'approve',
      true,
    );
    expect(first.body.data.agentAutoApprovalCheckpoint.canFinalize).toBe(false);

    const nextInterruptId = `interrupt-${randomUUID()}`;
    await app.db
      .getModel('aiMessages')
      .update(
        { metadata: { interruptId: nextInterruptId } },
        { where: { sessionId: fixture.sessionId, messageId: Number(fixture.messageId) } },
      );
    await app.db
      .getModel('aiToolMessages')
      .update(
        { invokeStatus: 'interrupted', status: null, content: null, userDecision: null, auto: false },
        { where: { sessionId: fixture.sessionId, messageId: Number(fixture.messageId) } },
      );
    await ownerAgent.resource('agentAutoApproval').set({
      values: { sessionId: fixture.sessionId, enabled: true },
    });
    const second = await decide(
      { sessionId: fixture.sessionId, messageId: fixture.messageId, toolCallId: callA.id },
      'approve',
      true,
    );
    expect(second.body.data.agentAutoApprovalCheckpoint.interruptId).toBe(nextInterruptId);
    expect(second.body.data.agentAutoApprovalCheckpoint.canFinalize).toBe(false);
    expect(
      await app.db
        .getRepository('agentAutoApprovalCheckpoints')
        .count({ filter: { ownerId, sessionId: fixture.sessionId } }),
    ).toBe(2);

    const single = await createCheckpointFixture({
      calls: [{ id: `call-single-${randomUUID()}`, name: toolA, args: { value: 'single' }, interrupt: true }],
    });
    const singleCall = single.calls[0];
    if (!singleCall) throw new Error('The single-tool checkpoint fixture is incomplete.');
    const singleResult = await decide(
      { sessionId: single.sessionId, messageId: single.messageId, toolCallId: singleCall.id },
      'approve',
      true,
    );
    expect(singleResult.body.data.updated).toBe(1);
    expect(singleResult.body.data.agentAutoApprovalCheckpoint).toBeUndefined();
    expect(
      await app.db.getRepository('agentAutoApprovalCheckpoints').count({ filter: { sessionId: single.sessionId } }),
    ).toBe(0);
  });

  it('rejects direct access to checkpoint records', async () => {
    const result = await ownerAgent.resource('agentAutoApprovalCheckpoints').create({
      values: {
        checkpointKey: `manual-${randomUUID()}`,
        ownerId,
        sessionId: randomUUID(),
        messageId: 'manual',
        interruptId: 'manual',
        status: 'pending',
      },
    });
    expect(result.status).toBe(403);
  });
});
