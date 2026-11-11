/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { vi } from 'vitest';
import { PluginAgentOrchestratorServer } from '../plugin';

const EMPLOYEE = 'dara';
const SESSION_ID = '3b000000-0000-4000-8000-000000000001';
const LARGE_DEPARTMENT_ID = '9007199254740993';
const ORIGINAL_PROMPT = 'Keep my private profile context.';
const GOVERNED_INSTRUCTION = 'Use the approved employee guidance.';

type GovernanceVersion = {
  id: number | string;
  version: number;
  revision: number;
  settings: unknown;
};

type GovernanceDraft = {
  policyId: number;
  version: GovernanceVersion;
};

type AIPlugin = {
  aiEmployeesManager: {
    resolveModel: (employee: unknown, model?: unknown) => Promise<{ llmService: string; model: string }>;
  };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object response.');
  return value as Record<string, unknown>;
}

function responseData(response: { body: { data: { data: unknown } } }) {
  return object(response.body.data.data);
}

function draftFrom(response: { body: { data: { data: unknown } } }): GovernanceDraft {
  const data = responseData(response);
  return { policyId: Number(data.policyId), version: object(data.version) as unknown as GovernanceVersion };
}

async function publishDraft(agent: ReturnType<MockServer['agent']>, draft: GovernanceDraft) {
  return agent.resource('agentGovernance').publish({
    values: {
      policyId: draft.policyId,
      versionId: draft.version.id,
      revision: draft.version.revision,
    },
  });
}

describe('agent governance HTTP and prompt admission', () => {
  let app: MockServer;
  let adminAgent: ReturnType<MockServer['agent']>;
  let memberAgent: ReturnType<MockServer['agent']>;
  let memberId: number;
  let employeeChatSettings: Record<string, unknown>;
  let employeePolicyId: number;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `agent-governance-${process.pid}`,
      acl: true,
      skipSupervisor: true,
    });

    const users = app.db.getRepository('users');
    const admin = await users.findOne({ filter: { 'roles.name': 'root' } });
    if (!admin) throw new Error('Mock server did not create its root user.');
    const member = await users.create({
      values: { username: `governance-member-${process.pid}`, roles: ['member'] },
    });
    memberId = Number(member.id);
    adminAgent = await app.agent().login(admin);
    memberAgent = await app.agent().login(member);

    const employee = await app.db.getRepository('aiEmployees').findOne({ filter: { username: EMPLOYEE } });
    if (!employee) throw new Error(`Mock server did not seed AI employee ${EMPLOYEE}.`);
    const settings = employee.get('chatSettings');
    employeeChatSettings =
      settings && typeof settings === 'object' && !Array.isArray(settings)
        ? { ...(settings as Record<string, unknown>) }
        : {};

    const nativePrompt = await app.db.getRepository('usersAiEmployees').create({
      values: { userId: memberId, aiEmployee: EMPLOYEE, prompt: ORIGINAL_PROMPT, sort: 17 },
    });
    expect(nativePrompt).toBeTruthy();

    await app.db.getRepository('aiConversations').create({
      values: {
        sessionId: SESSION_ID,
        userId: memberId,
        aiEmployeeUsername: EMPLOYEE,
        title: 'Governance admission test',
      },
    });

    if (!app.db.hasCollection('departments')) {
      const departments = app.db.collection({
        name: 'departments',
        fields: [{ name: 'title', type: 'string' }],
      });
      await departments.sync();
    }
    await app.db.getRepository('departments').create({
      values: { id: LARGE_DEPARTMENT_ID, title: 'Large department identifier' },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.destroy();
  });

  it('restricts governance to admins, protects backing collections, and rejects stale revisions', async () => {
    expect((await memberAgent.resource('agentGovernance').list()).status).toBe(403);
    expect(
      (
        await memberAgent.resource('agentGovernance').saveDraft({
          values: { scope: 'employee', scopeId: EMPLOYEE, settings: { instruction: 'Unauthorized.' } },
        })
      ).status,
    ).toBe(403);

    const firstSave = await adminAgent.resource('agentGovernance').saveDraft({
      values: { scope: 'employee', scopeId: EMPLOYEE, settings: { instruction: GOVERNED_INSTRUCTION } },
    });
    expect(firstSave.status).toBe(200);
    const staleDraft = draftFrom(firstSave);
    employeePolicyId = staleDraft.policyId;

    const backing = adminAgent.resource('agentGovernancePolicies');
    expect((await backing.list()).status).toBe(403);
    expect((await backing.get({ filterByTk: employeePolicyId })).status).toBe(403);
    expect(
      (
        await backing.create({
          values: { scope: 'employee', scopeId: EMPLOYEE, policyKey: 'bypass-governance' },
        })
      ).status,
    ).toBe(403);
    expect((await backing.update({ filterByTk: employeePolicyId, values: { scopeId: 'changed' } })).status).toBe(403);
    expect((await backing.destroy({ filterByTk: employeePolicyId })).status).toBe(403);

    const updatedSave = await adminAgent.resource('agentGovernance').saveDraft({
      values: { scope: 'employee', scopeId: EMPLOYEE, settings: { instruction: GOVERNED_INSTRUCTION } },
    });
    expect(updatedSave.status).toBe(200);
    const currentDraft = draftFrom(updatedSave);
    expect(currentDraft.version.id).toBe(staleDraft.version.id);
    expect(currentDraft.version.revision).toBe(staleDraft.version.revision + 1);

    const stalePublish = await adminAgent.resource('agentGovernance').publish({
      values: {
        policyId: staleDraft.policyId,
        versionId: staleDraft.version.id,
        revision: staleDraft.version.revision,
      },
    });
    expect(stalePublish.status).toBe(409);

    const published = await publishDraft(adminAgent, currentDraft);
    expect(published.status).toBe(200);

    const nextDraftResponse = await adminAgent.resource('agentGovernance').saveDraft({
      values: { scope: 'employee', scopeId: EMPLOYEE, settings: { instruction: 'Approved guidance v2.' } },
    });
    const nextDraft = draftFrom(nextDraftResponse);
    expect((await publishDraft(adminAgent, nextDraft)).status).toBe(200);

    const rollback = await adminAgent.resource('agentGovernance').rollback({
      values: { policyId: employeePolicyId, version: currentDraft.version.version },
    });
    expect(rollback.status).toBe(200);
    const policy = await app.db.getRepository('agentGovernancePolicies').findOne({ filterByTk: employeePolicyId });
    const currentVersion = await app.db
      .getRepository('agentGovernancePolicyVersions')
      .findOne({ filterByTk: policy?.get('currentVersionId') });
    expect(currentVersion?.get('status')).toBe('published');
    expect(currentVersion?.get('settings')).toMatchObject({ instruction: GOVERNED_INSTRUCTION });

    expect(
      (await memberAgent.resource('agentGovernance').listVersions({ values: { policyId: employeePolicyId } })).status,
    ).toBe(403);
  });

  it('preserves large department IDs as decimal strings in policy storage and HTTP results', async () => {
    const response = await adminAgent.resource('agentGovernance').saveDraft({
      values: {
        scope: 'department',
        scopeId: LARGE_DEPARTMENT_ID,
        settings: { allowedModels: ['governance-service:approved-model'] },
      },
    });
    expect(response.status).toBe(200);
    const draft = draftFrom(response);
    const policy = await app.db.getRepository('agentGovernancePolicies').findOne({ filterByTk: draft.policyId });
    expect(policy?.get('scopeId')).toBe(LARGE_DEPARTMENT_ID);

    const list = await adminAgent
      .resource('agentGovernance')
      .list({ scope: 'department', scopeId: LARGE_DEPARTMENT_ID });
    expect(list.status).toBe(200);
    const rows = list.body.data.data as Array<Record<string, unknown>>;
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ scopeId: LARGE_DEPARTMENT_ID })]));
  });

  it('denies raw/none prompt modes, leaves reconnect available, and restores the old native prompt', async () => {
    const employeeRepo = app.db.getRepository('aiEmployees');
    const nativePrompts = app.db.getRepository('usersAiEmployees');
    const aiPlugin = app.pm.get('ai') as unknown as AIPlugin;
    const resolveModel = vi
      .spyOn(aiPlugin.aiEmployeesManager, 'resolveModel')
      .mockResolvedValue({ llmService: 'governance-service', model: 'test-model' });
    const setPromptMode = async (mode: 'raw' | 'none' | 'default') => {
      const chatSettings = { ...employeeChatSettings };
      if (mode === 'default') delete chatSettings.systemPromptMode;
      else chatSettings.systemPromptMode = mode;
      await employeeRepo.update({ filter: { username: EMPLOYEE }, values: { chatSettings } });
    };

    await setPromptMode('raw');
    expect(
      (
        await adminAgent.resource('agentGovernance').apply({
          values: { userId: memberId, employeeUsername: EMPLOYEE },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await memberAgent.resource('aiConversations').sendMessages({
          values: {
            sessionId: SESSION_ID,
            aiEmployee: EMPLOYEE,
            messages: [{ role: 'user', content: { type: 'text', content: 'This must be blocked.' } }],
            stream: false,
          },
        })
      ).status,
    ).toBe(403);
    expect((await memberAgent.resource('aiConversations').getMessages({ sessionId: SESSION_ID })).status).toBe(200);

    await setPromptMode('none');
    expect(
      (
        await adminAgent.resource('agentGovernance').apply({
          values: { userId: memberId, employeeUsername: EMPLOYEE },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await memberAgent.resource('aiConversations').sendMessages({
          values: {
            sessionId: SESSION_ID,
            aiEmployee: EMPLOYEE,
            messages: [{ role: 'user', content: { type: 'text', content: 'This must remain blocked.' } }],
            stream: false,
          },
        })
      ).status,
    ).toBe(403);

    await setPromptMode('default');
    const applied = await adminAgent.resource('agentGovernance').apply({
      values: { userId: memberId, employeeUsername: EMPLOYEE },
    });
    expect(applied.status).toBe(200);
    expect(responseData(applied).projectedPrompt).toBe(`${GOVERNED_INSTRUCTION}\n\n${ORIGINAL_PROMPT}`);
    const managedPrompt = await nativePrompts.findOne({ filter: { userId: memberId, aiEmployee: EMPLOYEE } });
    expect(managedPrompt?.get('prompt')).toBe(`${GOVERNED_INSTRUCTION}\n\n${ORIGINAL_PROMPT}`);

    const deniedNativeEdit = await memberAgent.resource('aiEmployees').updateUserPrompt({
      values: { aiEmployee: EMPLOYEE, prompt: 'Member attempted to replace managed content.' },
    });
    expect(deniedNativeEdit.status).toBe(403);
    expect((await nativePrompts.findOne({ filter: { userId: memberId, aiEmployee: EMPLOYEE } }))?.get('prompt')).toBe(
      `${GOVERNED_INSTRUCTION}\n\n${ORIGINAL_PROMPT}`,
    );

    const restored = await adminAgent.resource('agentGovernance').restore({
      values: { userId: memberId, employeeUsername: EMPLOYEE },
    });
    expect(restored.status).toBe(200);
    const restoredPrompt = await nativePrompts.findOne({ filter: { userId: memberId, aiEmployee: EMPLOYEE } });
    expect(restoredPrompt?.get('prompt')).toBe(ORIGINAL_PROMPT);
    expect(restoredPrompt?.get('sort')).toBe(17);
    expect(
      await app.db.getRepository('agentGovernancePromptBindings').count({
        filter: { userId: memberId, employeeUsername: EMPLOYEE },
      }),
    ).toBe(0);
    resolveModel.mockRestore();
  });

  it('blocks send, resend, and resume by model and observed quota while leaving reconnect alone', async () => {
    const aiPlugin = app.pm.get('ai') as unknown as AIPlugin;
    const resolveModel = vi
      .spyOn(aiPlugin.aiEmployeesManager, 'resolveModel')
      .mockResolvedValue({ llmService: 'governance-service', model: 'blocked-model' });

    const modelPolicyResponse = await adminAgent.resource('agentGovernance').saveDraft({
      values: {
        scope: 'user',
        scopeId: String(memberId),
        settings: { allowedModels: ['governance-service:approved-model'] },
      },
    });
    const modelPolicy = draftFrom(modelPolicyResponse);
    expect((await publishDraft(adminAgent, modelPolicy)).status).toBe(200);

    const sendByModel = await memberAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId: SESSION_ID,
        aiEmployee: EMPLOYEE,
        messages: [{ role: 'user', content: { type: 'text', content: 'Blocked model request.' } }],
        stream: false,
      },
    });
    const resendByModel = await memberAgent.resource('aiConversations').resendMessages({
      values: { sessionId: SESSION_ID, stream: false },
    });
    const resumeByModel = await memberAgent.resource('aiConversations').resumeToolCall({
      values: { sessionId: SESSION_ID },
    });
    expect(sendByModel.status).toBe(403);
    expect(resendByModel.status).toBe(403);
    expect(resumeByModel.status).toBe(403);

    const quotaPolicyResponse = await adminAgent.resource('agentGovernance').saveDraft({
      values: { scope: 'user', scopeId: String(memberId), settings: { maxMonthlyTokens: 100 } },
    });
    const quotaPolicy = draftFrom(quotaPolicyResponse);
    expect((await publishDraft(adminAgent, quotaPolicy)).status).toBe(200);
    const now = new Date();
    await app.db.getRepository('agentExecutionSpans').create({
      values: {
        rootRunId: `governance-quota-${memberId}`,
        source: 'native-plugin-ai',
        type: 'model_call',
        status: 'success',
        usageIdentity: `governance-quota:${memberId}`,
        usageSource: 'actual',
        usageOccurredAt: now,
        employeeUsername: EMPLOYEE,
        userId: memberId,
        inputTokens: 60,
        outputTokens: 40,
        totalTokens: 100,
        cost: 0.1,
        priceCurrency: 'USD',
        createdAt: now,
        updatedAt: now,
      },
    });

    const sendByQuota = await memberAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId: SESSION_ID,
        aiEmployee: EMPLOYEE,
        messages: [{ role: 'user', content: { type: 'text', content: 'Blocked quota request.' } }],
        stream: false,
      },
    });
    const resendByQuota = await memberAgent.resource('aiConversations').resendMessages({
      values: { sessionId: SESSION_ID, stream: false },
    });
    const resumeByQuota = await memberAgent.resource('aiConversations').resumeToolCall({
      values: { sessionId: SESSION_ID },
    });
    expect(sendByQuota.status).toBe(403);
    expect(resendByQuota.status).toBe(403);
    expect(resumeByQuota.status).toBe(403);
    expect((await memberAgent.resource('aiConversations').getMessages({ sessionId: SESSION_ID })).status).toBe(200);
    expect(await app.db.getRepository('aiConversations.messages', SESSION_ID).count()).toBe(0);
    expect(resolveModel).toHaveBeenCalled();
    resolveModel.mockRestore();
  });
});
