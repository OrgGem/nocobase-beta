// SPDX-License-Identifier: Apache-2.0
import { createMockServer, type MockServer } from '@nocobase/test';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PluginAgentOrchestratorServer } from '../plugin';
import { getAIToolsManager } from '../utils/ai-manager';

describe('session auto-approval resource', () => {
  let app: MockServer;
  let ownerAgent: ReturnType<MockServer['agent']>;
  let otherAgent: ReturnType<MockServer['agent']>;
  let ownerId: number;
  let otherId: number;
  let ownerSessionId: string;
  let secondOwnerSessionId: string;
  let otherSessionId: string;

  beforeAll(async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `session-auto-approval-${suffix}`,
      acl: true,
      skipSupervisor: true,
    });

    const toolsManager = getAIToolsManager(app);
    for (const name of [
      'session_auto_approval_form_probe',
      'session_auto_approval_select_probe',
      'session_auto_approval_loop_probe',
    ]) {
      toolsManager.registerTools({
        scope: 'CUSTOM',
        execution: 'backend',
        defaultPermission: 'ALLOW',
        definition: {
          name,
          description: 'Persisted tool fixture for auto-approval eligibility.',
          schema: z.object({ value: z.string().optional() }),
        },
        invoke: async (_ctx: unknown, input: { value?: string }) => ({
          status: 'success',
          content: input.value ?? 'ok',
        }),
      });
    }

    const users = app.db.getRepository('users');
    const owner = await users.findOne({ filter: { 'roles.name': 'root' } });
    if (!owner) throw new Error('Mock server did not seed a root user.');
    const other = await users.create({ values: { username: `auto-approval-other-${suffix}`, roles: ['member'] } });
    ownerId = Number(owner.id);
    otherId = Number(other.id);
    ownerAgent = await app.agent().login(owner);
    otherAgent = await app.agent().login(other);

    ownerSessionId = randomUUID();
    secondOwnerSessionId = randomUUID();
    otherSessionId = randomUUID();
    const conversations = app.db.getRepository('aiConversations');
    await conversations.create({
      values: { sessionId: ownerSessionId, userId: ownerId, aiEmployeeUsername: 'dex', title: 'Owner session' },
    });
    await conversations.create({
      values: { sessionId: secondOwnerSessionId, userId: ownerId, aiEmployeeUsername: 'dex', title: 'Second session' },
    });
    await conversations.create({
      values: { sessionId: otherSessionId, userId: otherId, aiEmployeeUsername: 'dex', title: 'Other owner session' },
    });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('persists explicit enable and disable per owned root session and defaults a new session to off', async () => {
    const get = (sessionId: string) => ownerAgent.resource('agentAutoApproval').get({ values: { sessionId } });
    const set = (sessionId: string, enabled: boolean) =>
      ownerAgent.resource('agentAutoApproval').set({ values: { sessionId, enabled } });

    expect((await get(ownerSessionId)).body.data.enabled).toBe(false);
    expect((await set(ownerSessionId, true)).status).toBe(200);
    expect((await get(ownerSessionId)).body.data.enabled).toBe(true);
    expect((await get(secondOwnerSessionId)).body.data.enabled).toBe(false);

    expect((await set(ownerSessionId, false)).status).toBe(200);
    expect((await get(ownerSessionId)).body.data.enabled).toBe(false);

    const settingRows = await app.db.getRepository('agentSessionAutoApprovals').find({
      filter: { ownerId, sessionId: ownerSessionId },
    });
    expect(settingRows).toHaveLength(1);
    expect(settingRows[0].get('enabled')).toBe(false);
  });

  it('scopes settings by owner and refuses missing, malformed, or child conversations', async () => {
    const memberSet = await otherAgent.resource('agentAutoApproval').set({
      values: { sessionId: otherSessionId, enabled: true },
    });
    expect(memberSet.status).toBe(200);
    expect(
      (await otherAgent.resource('agentAutoApproval').get({ values: { sessionId: otherSessionId } })).body.data.enabled,
    ).toBe(true);
    expect((await ownerAgent.resource('agentAutoApproval').get({ values: { sessionId: otherSessionId } })).status).toBe(
      404,
    );
    expect(
      (
        await ownerAgent.resource('agentAutoApproval').set({
          values: { sessionId: ownerSessionId, enabled: 'true' },
        })
      ).status,
    ).toBe(400);
    expect((await ownerAgent.resource('agentAutoApproval').get({ values: { sessionId: randomUUID() } })).status).toBe(
      404,
    );

    const childSessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: {
        sessionId: childSessionId,
        userId: ownerId,
        aiEmployeeUsername: 'dex',
        from: 'sub-agent',
        title: 'Child session',
      },
    });
    expect(
      (await ownerAgent.resource('agentAutoApproval').set({ values: { sessionId: childSessionId, enabled: true } }))
        .status,
    ).toBe(404);
    expect(
      await app.db.getRepository('agentSessionAutoApprovals').count({ filter: { ownerId, sessionId: childSessionId } }),
    ).toBe(0);
  });

  it('checks eligibility against persisted root interrupts, frontend ASK manifests, and interactive Skill Hub schemas', async () => {
    const username = 'dex';
    const sessionId = randomUUID();
    const conversations = app.db.getRepository('aiConversations');
    await conversations.create({
      values: { sessionId, userId: ownerId, aiEmployeeUsername: username, title: 'Eligibility fixtures' },
    });

    const approvals = app.db.getRepository('agentSessionAutoApprovals');
    await approvals.create({ values: { ownerId, sessionId, enabled: true } });

    let nextId = Date.now() * 1000;
    const persistInterrupt = async (
      targetSessionId: string,
      toolName: string,
      args: Record<string, unknown>,
      from: 'main-agent' | 'sub-agent' = 'main-agent',
    ) => {
      const messageId = ++nextId;
      const toolMessageId = ++nextId;
      const toolCallId = `auto-approval-${randomUUID()}`;
      const interruptId = `interrupt-${randomUUID()}`;
      await app.db.getRepository('aiConversations.messages', targetSessionId).create({
        values: {
          messageId,
          role: username,
          content: { type: 'text', content: 'Persisted ASK fixture.' },
          toolCalls: [{ id: toolCallId, name: toolName, args }],
          metadata: { interruptId },
        },
      });
      await app.db.getRepository('aiToolMessages').create({
        values: {
          id: toolMessageId,
          sessionId: targetSessionId,
          messageId,
          toolCallId,
          toolName,
          status: null,
          content: null,
          invokeStatus: 'interrupted',
          auto: false,
          execution: toolName === 'executeFrontendTool' ? 'frontend' : 'backend',
          interruptActionOrder: 0,
          interruptAction: {
            order: 0,
            toolCall: { id: toolCallId, name: toolName },
            allowedDecisions: ['approve', 'reject', 'edit'],
            currentConversation: { sessionId: targetSessionId, username, from },
          },
        },
      });
      return { sessionId: targetSessionId, messageId: String(messageId), toolCallId };
    };
    const eligible = (identity: { sessionId: string; messageId: string; toolCallId: string }) =>
      ownerAgent.resource('agentAutoApproval').eligible({ values: identity });

    const probeCall = await persistInterrupt(sessionId, 'session_auto_approval_form_probe', { value: 'root' });
    expect((await eligible(probeCall)).body.data.eligible).toBe(true);
    expect((await eligible({ ...probeCall, toolCallId: 'different-tool-call' })).body.data.eligible).toBe(false);

    const frontendManifest = {
      id: 'report-block:refresh_report',
      blockUid: 'report-block',
      name: 'refresh_report',
      title: 'Refresh report',
      description: 'Refresh the report block.',
      permission: 'ASK',
      inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } },
    };
    await conversations.update({
      filter: { sessionId },
      values: { options: { frontendTools: [frontendManifest] } },
    });
    const frontendCall = await persistInterrupt(sessionId, 'executeFrontendTool', {
      toolId: frontendManifest.id,
      args: { force: true },
    });
    expect((await eligible(frontendCall)).body.data.eligible).toBe(true);

    await conversations.update({
      filter: { sessionId },
      values: {
        options: {
          frontendTools: [{ ...frontendManifest, permission: 'ALLOW' }],
        },
      },
    });
    expect((await eligible(frontendCall)).body.data.eligible).toBe(false);
    await conversations.update({
      filter: { sessionId },
      values: { options: { frontendTools: [{ ...frontendManifest, id: 'report-block:other_tool' }] } },
    });
    expect((await eligible(frontendCall)).body.data.eligible).toBe(false);

    const skillDefinitions = app.db.getRepository('skillDefinitions');
    const formSkill = await skillDefinitions.create({
      values: {
        name: `auto-approval-form-${Date.now()}`,
        toolName: 'session_auto_approval_form_probe',
        title: 'Form input fixture',
        description: 'Requires user form input.',
        instructions: 'Do not invent the form fields.',
        language: 'node',
        codeTemplate: '',
        inputSchema: '{}',
        interactionSchema: JSON.stringify({
          type: 'form',
          prompt: 'Complete the form.',
          fields: { value: { type: 'text', title: 'Value', required: true } },
        }),
        enabled: true,
        toolScope: 'CUSTOM',
        autoCall: false,
        storageType: 'database',
      },
    });
    const selectSkill = await skillDefinitions.create({
      values: {
        name: `auto-approval-select-${Date.now()}`,
        toolName: 'session_auto_approval_select_probe',
        title: 'Select input fixture',
        description: 'Requires user selection.',
        instructions: 'Wait for the user to choose an option.',
        language: 'node',
        codeTemplate: '',
        inputSchema: '{}',
        interactionSchema: JSON.stringify({
          type: 'select',
          prompt: 'Choose an option.',
          options: [{ label: 'One', value: 'one' }],
        }),
        enabled: true,
        toolScope: 'CUSTOM',
        autoCall: false,
        storageType: 'database',
      },
    });
    const loopSkill = await skillDefinitions.create({
      values: {
        name: `auto-approval-loop-${Date.now()}`,
        toolName: 'session_auto_approval_loop_probe',
        title: 'Skill loop fixture',
        description: 'Requires user confirmation through a loop config.',
        instructions: 'Do not bypass the configured interaction.',
        language: 'node',
        codeTemplate: '',
        inputSchema: '{}',
        interactionSchema: null,
        enabled: true,
        toolScope: 'CUSTOM',
        autoCall: false,
        storageType: 'database',
      },
    });
    await app.db.getRepository('skillLoopConfigs').create({
      values: {
        skillId: loopSkill.id,
        enabled: true,
        title: 'Review before execution',
        templateKey: 'confirm',
        schema: JSON.stringify({ type: 'confirm', prompt: 'Review this operation.' }),
      },
    });

    const formCall = await persistInterrupt(sessionId, 'session_auto_approval_form_probe', { value: 'fabricated' });
    const selectCall = await persistInterrupt(sessionId, 'session_auto_approval_select_probe', { value: 'fabricated' });
    const loopCall = await persistInterrupt(sessionId, 'session_auto_approval_loop_probe', { value: 'fabricated' });
    const suggestionCall = await persistInterrupt(sessionId, 'suggestions', { value: 'fabricated' });
    const workflowOutputCall = await persistInterrupt(sessionId, 'aiEmployeeWorkflowTaskOutput', {
      value: 'fabricated',
    });
    for (const identity of [formCall, selectCall, loopCall, suggestionCall, workflowOutputCall]) {
      expect((await eligible(identity)).body.data.eligible).toBe(false);
    }

    const childSessionId = randomUUID();
    await conversations.create({
      values: {
        sessionId: childSessionId,
        userId: ownerId,
        aiEmployeeUsername: username,
        from: 'sub-agent',
        title: 'Child eligibility fixture',
      },
    });
    await approvals.create({ values: { ownerId, sessionId: childSessionId, enabled: true } });
    const childCall = await persistInterrupt(childSessionId, 'session_auto_approval_form_probe', { value: 'child' });
    expect((await eligible(childCall)).status).toBe(404);
  });
});
