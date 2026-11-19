/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { AIMessage, AIMessageChunk, BaseMessage, ToolMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { FakeChatModel } from '@langchain/core/utils/testing';
import type { Context } from '@nocobase/actions';
import { DataTypes, type Model } from '@nocobase/database';
import { LLMProvider, type LLMProviderMeta } from '@nocobase/plugin-ai/server';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PluginAgentOrchestratorServer } from '../plugin';
import { guardHierarchyEnrollment } from '../services/HierarchyEnrollmentGuard';
import { HIERARCHY_DISPATCH_TOOL, HIERARCHY_LIST_TOOL } from '../services/HierarchicalAgentRuntime';
import { HarnessProfileService } from '../services/HarnessProfileService';
import { getAIToolsManager } from '../utils/ai-manager';
import WidenNativeEmployeeIdentifiers from '../migrations/20261119000000-widen-native-employee-identifiers';

type ModelRef = { llmService: string; model: string };
type EnabledModel = { llmService: string; enabledModels: Array<{ value: string }> };
type PluginAiProbe = {
  aiManager: {
    listAllEnabledModels: () => Promise<EnabledModel[]>;
    registerLLMProvider: (name: string, meta: LLMProviderMeta) => void;
  };
  aiEmployeesManager: {
    resolveModel: (employee: Model, model?: ModelRef | null) => Promise<ModelRef>;
    conversationController: { get: (sessionId: string) => AbortController | undefined };
  };
  ai?: { skillsManager?: { getSkills: (names: string[]) => Promise<unknown[]> } };
};

type ProbeStep =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | {
      kind: 'answer';
      text: string;
      requireContext?: string;
      appendMarker?: string;
      allowMissingToolResult?: boolean;
    };
type ProbePromptMessage = { kind: 'tool' | 'other'; content: unknown; name?: unknown; toolCallId?: unknown };
type ProbeGenerationCounts = { generate: number; stream: number };

const probeScripts = new Map<string, ProbeStep[]>();
const probeCursors = new Map<string, number>();
const probeGenerationModes = new Map<string, ProbeGenerationCounts>();
const providerToolNames = new Map<string, string[]>();
const providerInputs = new Map<string, ProbePromptMessage[][]>();
const beforeProbeStep = new Map<string, (index: number) => Promise<void>>();
const workerEvidence = 'SENTINEL-HIERARCHY-EVIDENCE-7F3A';

function readToolName(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const item = value as { name?: unknown; function?: { name?: unknown } };
  if (typeof item.name === 'string') return item.name;
  return typeof item.function?.name === 'string' ? item.function.name : '';
}

function recordGeneration(modelName: string, method: keyof ProbeGenerationCounts) {
  const counts = probeGenerationModes.get(modelName) ?? { generate: 0, stream: 0 };
  counts[method] += 1;
  probeGenerationModes.set(modelName, counts);
}

function generationModeSnapshot(): Map<string, ProbeGenerationCounts> {
  return new Map([...probeGenerationModes].map(([name, counts]) => [name, { ...counts }]));
}

class HierarchyProbeModel extends FakeChatModel {
  constructor(private readonly modelName: string) {
    super({});
  }

  bindTools(...args: Parameters<FakeChatModel['bindTools']>) {
    const rawTools: unknown = args[0];
    providerToolNames.set(
      this.modelName,
      (Array.isArray(rawTools) ? rawTools : []).map(readToolName).filter(Boolean).sort(),
    );
    return this;
  }

  private async generateMessage(messages: BaseMessage[]): Promise<AIMessage> {
    const script = probeScripts.get(this.modelName) ?? [];
    const index = probeCursors.get(this.modelName) ?? 0;
    await beforeProbeStep.get(this.modelName)?.(index);
    const step = script[index];
    if (
      index > 0 &&
      !messages.some(ToolMessage.isInstance) &&
      !(step?.kind === 'answer' && step.allowMissingToolResult)
    ) {
      throw new Error(`Expected a completed tool result before step ${index} for ${this.modelName}.`);
    }
    const snapshot = messages.map((message) => {
      const values = message as unknown as Record<string, unknown>;
      return {
        kind: ToolMessage.isInstance(message) ? ('tool' as const) : ('other' as const),
        content: message.content,
        name: values.name,
        toolCallId: values.tool_call_id,
      };
    });
    const inputs = providerInputs.get(this.modelName) ?? [];
    inputs.push(snapshot);
    providerInputs.set(this.modelName, inputs);
    probeCursors.set(this.modelName, index + 1);
    if (!step) throw new Error(`No scripted response remains for ${this.modelName} at step ${index}.`);
    let answerText = step.kind === 'answer' ? step.text : '';
    if (step.kind === 'answer' && step.requireContext && !JSON.stringify(snapshot).includes(step.requireContext)) {
      throw new Error(`Expected delegated evidence in the model input for ${this.modelName}.`);
    }
    if (step.kind === 'answer' && step.appendMarker) {
      const serialized = JSON.stringify(snapshot);
      const markerIndex = serialized.indexOf(step.appendMarker);
      if (markerIndex < 0) throw new Error(`Expected a synthesis marker in the model input for ${this.modelName}.`);
      answerText += serialized.slice(markerIndex, markerIndex + step.appendMarker.length);
    }
    const message =
      step.kind === 'tool'
        ? new AIMessage({
            content: '',
            tool_calls: [
              {
                id: `${this.modelName}-call-${index + 1}`,
                name: step.name,
                args: step.args,
                type: 'tool_call',
              },
            ],
          })
        : new AIMessage(answerText);
    return message;
  }

  async _generate(messages: BaseMessage[], options: Parameters<BaseChatModel['_generate']>[1]) {
    if (options.signal?.aborted) throw new Error('The deterministic provider call was cancelled.');
    recordGeneration(this.modelName, 'generate');
    const message = await this.generateMessage(messages);
    return { generations: [{ text: String(message.content), message }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: Parameters<BaseChatModel['_streamResponseChunks']>[1],
  ) {
    if (options.signal?.aborted) throw new Error('The deterministic provider stream was cancelled.');
    recordGeneration(this.modelName, 'stream');
    const message = await this.generateMessage(messages);
    const toolCallChunks = (message.tool_calls ?? []).map((call, index) => ({
      id: call.id,
      name: call.name,
      args: JSON.stringify(call.args),
      index,
    }));
    const chunk = new AIMessageChunk({ content: message.content, tool_call_chunks: toolCallChunks });
    yield new ChatGenerationChunk({ message: chunk, text: String(message.content) });
  }
}

class HierarchyProbeProvider extends LLMProvider {
  createModel(): BaseChatModel {
    return new HierarchyProbeModel(String(this.modelOptions?.model ?? 'unknown-model'));
  }
}

function modelService(name: string, model: string) {
  return {
    name,
    title: name,
    provider: 'hierarchy-probe',
    enabled: true,
    options: {},
    enabledModels: { mode: 'custom', models: [{ label: model, value: model }] },
    modelOptions: {},
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object response.');
  return value as Record<string, unknown>;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function responseData(response: { body: { data: { data: unknown } } }) {
  return object(response.body.data.data);
}

function toolPayloadForCall(input: ProbePromptMessage[], toolCallId: string): Record<string, unknown> {
  const message = input.find((item) => item.kind === 'tool' && item.toolCallId === toolCallId);
  if (!message) throw new Error(`The model input did not include tool result ${toolCallId}.`);
  const content = message.content;
  return object(typeof content === 'string' ? JSON.parse(content) : content);
}

function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function chatContext(app: MockServer, userId: number, sessionId: string, employee: string): Context {
  return {
    action: {
      resourceName: 'aiConversations',
      actionName: 'sendMessages',
      params: { values: { sessionId, aiEmployee: employee } },
    },
    auth: { user: { id: userId } },
    app,
    db: app.db,
    t: (message: string) => message,
    throw: (_status: number, message: string) => {
      throw new Error(message);
    },
  } as unknown as Context;
}

describe('hierarchical routing preview HTTP and policy resolution', () => {
  let app: MockServer;
  let adminAgent: ReturnType<MockServer['agent']>;
  let memberAgent: ReturnType<MockServer['agent']>;
  let adminId: number;
  let memberId: number;
  let leaderUsername: string;
  let targetUsername: string;
  let rootSessionId: string;
  let memberSessionId: string;
  let profileTag: string;
  let workerProfileTag: string;
  let profileVersion: number;
  let workerUsername: string;
  const workerInvocations: Array<{ path: string }> = [];
  const sessionAskInvocations: Array<{ value: string }> = [];
  const resolvedCandidates: Array<ModelRef | undefined> = [];
  let afterWorkerInvoke: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `hierarchical-routing-${suffix}`,
      acl: true,
      skipSupervisor: true,
    });
    app.resourceManager.use(
      async (ctx, next) => {
        if (
          ctx.action?.resourceName === 'aiConversations' &&
          ['sendMessages', 'resendMessages', 'resumeToolCall'].includes(ctx.action.actionName)
        ) {
          if (!ctx.get('x-timezone')) ctx.req.headers['x-timezone'] = '+00:00';
          if (!ctx.get('x-locale')) ctx.req.headers['x-locale'] = 'en-US';
        }
        await next();
      },
      { tag: 'hierarchy-test-request-context', after: 'auth' },
    );

    const users = app.db.getRepository('users');
    const root = await users.findOne({ filter: { 'roles.name': 'root' } });
    if (!root) throw new Error('Mock server did not seed a root user.');
    const member = await users.create({ values: { username: `hierarchy-member-${suffix}`, roles: ['member'] } });
    adminId = Number(root.id);
    memberId = Number(member.id);
    adminAgent = await app.agent().login(root);
    memberAgent = await app.agent().login(member);

    const employees = app.db.getRepository('aiEmployees');
    const leader = await employees.findOne({ filter: { username: 'dex', enabled: true, category: 'business' } });
    const target = await employees.findOne({ filter: { username: 'ellis', enabled: true, category: 'business' } });
    if (!leader || !target) throw new Error('Mock server did not seed the expected business AI employees.');
    leaderUsername = String(leader.get('username'));
    targetUsername = String(target.get('username'));

    rootSessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: {
        sessionId: rootSessionId,
        userId: adminId,
        aiEmployeeUsername: leaderUsername,
        title: 'Hierarchy preview test',
      },
    });
    memberSessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: {
        sessionId: memberSessionId,
        userId: memberId,
        aiEmployeeUsername: leaderUsername,
        title: 'Unowned hierarchy preview test',
      },
    });

    const profiles = new HarnessProfileService(app.db);
    profileTag = `hierarchy-preview-${suffix}`;
    const profile = await profiles.createProfile({
      tag: profileTag,
      settings: {
        routing: {
          models: {
            primary: { llmService: 'mock-primary', model: 'strong-model' },
            fallback: [{ llmService: 'mock-backup', model: 'lite-model' }],
          },
        },
        tools: {
          allow: [HIERARCHY_LIST_TOOL, HIERARCHY_DISPATCH_TOOL],
          effects: { [HIERARCHY_LIST_TOOL]: 'read', [HIERARCHY_DISPATCH_TOOL]: 'read' },
        },
        limits: { timeoutMs: 40_000, maxInvocations: 4 },
        observability: { enabled: true, sharing: 'full' },
      },
    });
    profileVersion = profile.version.version;

    await app.db.getRepository('orchestratorConfig').create({
      values: {
        leaderUsername,
        subAgentUsername: targetUsername,
        enabled: true,
        harnessTag: profileTag,
        routingEnabled: true,
        routingRole: 'specialist',
        routingPrompt: 'Use for technical evidence gathering.',
        maxDepth: 2,
        timeout: 120000,
      },
    });

    workerUsername = `hierarchy-worker-${suffix}`;
    await employees.create({
      values: {
        username: workerUsername,
        nickname: 'Routing worker fixture',
        enabled: true,
        category: 'business',
        deprecated: false,
        chatSettings: { enableSkills: false },
        skillSettings: { tools: [{ name: 'worker_read_tool', autoCall: true }] },
      },
    });
    workerProfileTag = `hierarchy-worker-${suffix}`;
    await profiles.createProfile({
      tag: workerProfileTag,
      settings: {
        routing: { models: { primary: { llmService: 'mock-worker', model: 'worker-lite' }, fallback: [] } },
        tools: { allow: ['worker_read_tool'], effects: { worker_read_tool: 'read' } },
        limits: { timeoutMs: 40_000, maxInvocations: 4 },
        observability: { enabled: true, sharing: 'full' },
      },
    });
    await app.db.getRepository('orchestratorConfig').create({
      values: {
        leaderUsername: targetUsername,
        subAgentUsername: workerUsername,
        enabled: true,
        harnessTag: workerProfileTag,
        routingEnabled: true,
        routingRole: 'worker',
        routingPrompt: 'Use only for read-only tool work.',
        maxDepth: 1,
        timeout: 120000,
      },
    });

    const ai = app.pm.get('ai') as unknown as PluginAiProbe;
    ai.aiManager.registerLLMProvider('hierarchy-probe', {
      title: 'Deterministic hierarchy test provider',
      provider: HierarchyProbeProvider,
    });
    const services = app.db.getRepository('llmServices');
    await services.create({ values: modelService('mock-root', 'strong-model') });
    await services.create({ values: modelService('mock-backup', 'lite-model') });
    await services.create({ values: modelService('mock-worker', 'worker-lite') });
    getAIToolsManager(app).registerTools({
      scope: 'CUSTOM',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      definition: {
        name: 'worker_read_tool',
        description: 'Read a deterministic fixture file.',
        schema: z.object({ path: z.string() }),
      },
      invoke: async (_ctx, input: { path: string }) => {
        workerInvocations.push({ path: input.path });
        await afterWorkerInvoke?.();
        return { status: 'success', content: input.path === 'fixture.txt' ? workerEvidence : `contents:${input.path}` };
      },
    });
    getAIToolsManager(app).registerTools({
      scope: 'CUSTOM',
      execution: 'backend',
      defaultPermission: 'ALLOW',
      definition: {
        name: 'session_ask_approval_probe',
        description: 'Exercise an employee-specific Ask permission in a root conversation.',
        schema: z.object({ value: z.string() }),
      },
      invoke: async (_ctx, input: { value: string }) => {
        sessionAskInvocations.push(input);
        return { status: 'success', content: `approved:${input.value}` };
      },
    });

    const currentLeaderSettings = recordOrEmpty(leader.get('skillSettings'));
    const currentLeaderChatSettings = recordOrEmpty(leader.get('chatSettings'));
    await leader.update({
      skillSettings: {
        ...currentLeaderSettings,
        tools: [
          { name: HIERARCHY_LIST_TOOL, autoCall: true },
          { name: HIERARCHY_DISPATCH_TOOL, autoCall: true },
          { name: 'session_ask_approval_probe', autoCall: false },
        ],
      },
      chatSettings: { ...currentLeaderChatSettings, enableSkills: false },
    });
    const roleBindings = app.db.getRepository('rolesAiEmployees');
    for (const username of [leaderUsername, targetUsername, workerUsername]) {
      const existing = await roleBindings.findOne({ filter: { roleName: 'member', aiEmployee: username } });
      if (!existing) {
        await roleBindings.create({ values: { roleName: 'member', aiEmployee: username } });
      }
    }
    vi.spyOn(ai.aiEmployeesManager, 'resolveModel').mockImplementation(async (_employee, model) => {
      resolvedCandidates.push(model ?? undefined);
      if (!model) throw new Error('The fixture should always specify a candidate model.');
      return model;
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.destroy();
  });

  it('uses the same active binding/profile resolver and selects the first available fallback model', async () => {
    const response = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: targetUsername },
    });

    expect(response.status).toBe(200);
    expect(responseData(response)).toMatchObject({
      username: targetUsername,
      role: 'specialist',
      model: { llmService: 'mock-backup', model: 'lite-model' },
      fallback: true,
      profile: { tag: profileTag, version: profileVersion },
    });
    expect(resolvedCandidates).toEqual([
      { llmService: 'mock-primary', model: 'strong-model' },
      { llmService: 'mock-backup', model: 'lite-model' },
    ]);
  });

  it('requires administrator access and rejects another user’s conversation', async () => {
    expect(
      (
        await memberAgent.resource('agentHierarchy').preview({
          values: { sessionId: rootSessionId, username: targetUsername },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await adminAgent.resource('agentHierarchy').preview({
          values: { sessionId: memberSessionId, username: targetUsername },
        })
      ).status,
    ).toBe(409);
  });

  it('previews a worker through its specialist, applies routing policy, and creates no execution records', async () => {
    const profiles = new HarnessProfileService(app.db);
    const rootBinding = await app.db
      .getRepository('orchestratorConfig')
      .findOne({ filter: { leaderUsername, subAgentUsername: targetUsername } });
    const workerBinding = await app.db
      .getRepository('orchestratorConfig')
      .findOne({ filter: { leaderUsername: targetUsername, subAgentUsername: workerUsername } });
    if (!rootBinding || !workerBinding) throw new Error('The hierarchy preview bindings were not created.');
    const originalRootTag = String(rootBinding.get('harnessTag'));
    const originalWorkerTag = String(workerBinding.get('harnessTag'));
    const sourceProfile = await profiles.getPublishedByTag(profileTag);
    const sourceWorkerProfile = await profiles.getPublishedByTag(workerProfileTag);
    if (!sourceProfile || !sourceWorkerProfile) throw new Error('The hierarchy preview profiles were not published.');
    const childCount = await app.db
      .getRepository('aiConversations')
      .count({ filter: { userId: adminId, from: 'sub-agent' } });
    const invocationCount = await app.db
      .getRepository('agentHierarchyInvocations')
      .count({ filter: { ownerId: adminId } });
    const cursorSnapshot = new Map(probeCursors);
    const inputSnapshot = new Map([...providerInputs].map(([name, inputs]) => [name, inputs.length]));

    const valid = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(valid.status).toBe(200);
    expect(responseData(valid)).toMatchObject({
      username: workerUsername,
      role: 'worker',
      model: { llmService: 'mock-worker', model: 'worker-lite' },
      fallback: false,
      profile: { tag: workerProfileTag },
      specialist: {
        username: targetUsername,
        model: { llmService: 'mock-backup', model: 'lite-model' },
        fallback: true,
        profile: { tag: profileTag },
      },
    });

    const users = app.db.getRepository('users');
    const adminWithoutWorker = await users.create({
      values: { username: `hierarchy-admin-no-worker-${Date.now()}`, roles: ['admin'] },
    });
    const noWorkerId = Number(adminWithoutWorker.id);
    const noWorkerSessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: {
        sessionId: noWorkerSessionId,
        userId: noWorkerId,
        aiEmployeeUsername: leaderUsername,
        title: 'Worker preview access test',
      },
    });
    const adminWithoutWorkerAgent = await app.agent().login(adminWithoutWorker);
    const roleBindings = app.db.getRepository('rolesAiEmployees');
    for (const username of [leaderUsername, targetUsername]) {
      const existing = await roleBindings.findOne({ filter: { roleName: 'admin', aiEmployee: username } });
      if (!existing) await roleBindings.create({ values: { roleName: 'admin', aiEmployee: username } });
    }
    const adminWorkerBinding = await roleBindings.findOne({
      filter: { roleName: 'admin', aiEmployee: workerUsername },
    });
    await adminWorkerBinding?.destroy();
    try {
      const inaccessibleWorkerPreview = await adminWithoutWorkerAgent.resource('agentHierarchy').preview({
        values: { sessionId: noWorkerSessionId, username: workerUsername, specialistUsername: targetUsername },
      });
      expect(inaccessibleWorkerPreview.status).toBe(409);
    } finally {
      if (adminWorkerBinding) {
        await roleBindings.create({ values: { roleName: 'admin', aiEmployee: workerUsername } });
      }
    }

    await rootBinding.update({ maxDepth: 1 });
    const depthDenied = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(depthDenied.status).toBe(409);
    await rootBinding.update({ maxDepth: 2 });

    await workerBinding.update({ enabled: false });
    const missingBinding = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(missingBinding.status).toBe(409);
    await workerBinding.update({ enabled: true });

    const restrictedTag = `hierarchy-preview-restricted-${Date.now()}`;
    const restrictedProfile = await profiles.createProfile({
      tag: restrictedTag,
      settings: {
        ...sourceProfile.settings,
        delegation: { ...sourceProfile.settings.delegation, allowedEmployees: [targetUsername] },
      },
    });
    await rootBinding.update({ harnessTag: restrictedProfile.profile.tag });
    const employeeDenied = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(employeeDenied.status).toBe(409);

    const toolRestrictedTag = `hierarchy-preview-tools-${Date.now()}`;
    const toolRestrictedProfile = await profiles.createProfile({
      tag: toolRestrictedTag,
      settings: {
        ...sourceProfile.settings,
        tools: {
          ...sourceProfile.settings.tools,
          allow: [HIERARCHY_LIST_TOOL],
          effects: { ...sourceProfile.settings.tools.effects, [HIERARCHY_LIST_TOOL]: 'read' },
        },
      },
    });
    await rootBinding.update({ harnessTag: toolRestrictedProfile.profile.tag });
    const specialistToolDenied = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(specialistToolDenied.status).toBe(409);
    const directSpecialistToolDenied = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: targetUsername },
    });
    expect(directSpecialistToolDenied.status).toBe(409);

    await rootBinding.update({ harnessTag: originalRootTag });
    const zeroInvocationProfile = await profiles.createProfile({
      tag: `hierarchy-preview-zero-invocations-${Date.now()}`,
      settings: {
        ...sourceProfile.settings,
        limits: { ...sourceProfile.settings.limits, maxInvocations: 0 },
      },
    });
    await rootBinding.update({ harnessTag: zeroInvocationProfile.profile.tag });
    const directZeroInvocations = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: targetUsername },
    });
    expect(directZeroInvocations.status).toBe(409);
    const nestedZeroInvocations = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(nestedZeroInvocations.status).toBe(409);

    const oneInvocationProfile = await profiles.createProfile({
      tag: `hierarchy-preview-one-invocation-${Date.now()}`,
      settings: {
        ...sourceProfile.settings,
        limits: { ...sourceProfile.settings.limits, maxInvocations: 1 },
      },
    });
    await rootBinding.update({ harnessTag: oneInvocationProfile.profile.tag });
    const nestedOneInvocation = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(nestedOneInvocation.status).toBe(409);

    const twoInvocationProfile = await profiles.createProfile({
      tag: `hierarchy-preview-two-invocations-${Date.now()}`,
      settings: {
        ...sourceProfile.settings,
        limits: { ...sourceProfile.settings.limits, maxInvocations: 2 },
      },
    });
    await rootBinding.update({ harnessTag: twoInvocationProfile.profile.tag });
    const nestedTwoInvocations = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(nestedTwoInvocations.status).toBe(200);

    await rootBinding.update({ harnessTag: zeroInvocationProfile.profile.tag });
    const missingToolManager = getAIToolsManager(app) as {
      getTools: (name: string, options: { ctx: Context; sessionId: string }) => Promise<unknown>;
    };
    const originalGetTools = missingToolManager.getTools.bind(missingToolManager);
    const getToolsSpy = vi.spyOn(missingToolManager, 'getTools').mockImplementation(async (name, options) => {
      if (name === HIERARCHY_DISPATCH_TOOL) return undefined;
      return originalGetTools(name, options);
    });
    try {
      const unavailableTool = await adminAgent.resource('agentHierarchy').preview({
        values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
      });
      expect(unavailableTool.status).toBe(409);
    } finally {
      getToolsSpy.mockRestore();
    }
    await rootBinding.update({ harnessTag: originalRootTag });

    const fallbackTag = `hierarchy-preview-worker-fallback-${Date.now()}`;
    const fallbackProfile = await profiles.createProfile({
      tag: fallbackTag,
      settings: {
        ...sourceWorkerProfile.settings,
        routing: {
          models: {
            primary: { llmService: 'mock-missing', model: 'missing-model' },
            fallback: [{ llmService: 'mock-backup', model: 'lite-model' }],
          },
        },
      },
    });
    await workerBinding.update({ harnessTag: fallbackProfile.profile.tag });
    const fallback = await adminAgent.resource('agentHierarchy').preview({
      values: { sessionId: rootSessionId, username: workerUsername, specialistUsername: targetUsername },
    });
    expect(fallback.status).toBe(200);
    expect(responseData(fallback)).toMatchObject({
      username: workerUsername,
      role: 'worker',
      model: { llmService: 'mock-backup', model: 'lite-model' },
      fallback: true,
    });

    await workerBinding.update({ harnessTag: originalWorkerTag });
    expect(
      await app.db.getRepository('aiConversations').count({ filter: { userId: adminId, from: 'sub-agent' } }),
    ).toBe(childCount);
    expect(await app.db.getRepository('agentHierarchyInvocations').count({ filter: { ownerId: adminId } })).toBe(
      invocationCount,
    );
    expect(probeCursors).toEqual(cursorSnapshot);
    expect(new Map([...providerInputs].map(([name, inputs]) => [name, inputs.length]))).toEqual(inputSnapshot);
  });

  it('denies managed specialist dispatch when its published profile permits zero invocations', async () => {
    const profiles = new HarnessProfileService(app.db);
    const sourceProfile = await profiles.getPublishedByTag(profileTag);
    const rootBinding = await app.db
      .getRepository('orchestratorConfig')
      .findOne({ filter: { leaderUsername, subAgentUsername: targetUsername } });
    if (!sourceProfile || !rootBinding) throw new Error('The specialist binding or published profile is unavailable.');
    const originalTag = String(rootBinding.get('harnessTag'));
    const denyingProfile = await profiles.createProfile({
      tag: `hierarchy-managed-zero-invocations-${Date.now()}`,
      settings: {
        ...sourceProfile.settings,
        limits: { ...sourceProfile.settings.limits, maxInvocations: 0 },
      },
    });
    const sessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title: 'Denied specialist test' },
    });
    workerInvocations.length = 0;
    probeCursors.clear();
    probeScripts.clear();
    probeScripts.set('strong-model', [
      { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: targetUsername, question: 'This specialist has no invocation budget.' },
      },
      { kind: 'answer', text: 'The configured invocation limit denied the specialist.' },
    ]);
    probeScripts.set('lite-model', [{ kind: 'answer', text: 'This specialist model must not run.' }]);

    try {
      await rootBinding.update({ harnessTag: denyingProfile.profile.tag });
      const preview = await adminAgent.resource('agentHierarchy').preview({
        values: { sessionId: rootSessionId, username: targetUsername },
      });
      expect(preview.status).toBe(409);

      const response = await adminAgent.resource('aiConversations').sendMessages({
        values: {
          sessionId,
          aiEmployee: leaderUsername,
          model: { llmService: 'mock-root', model: 'strong-model' },
          messages: [{ role: 'user', content: { type: 'text', content: 'Use the specialist.' } }],
          stream: false,
        },
      });

      expect(response.status).toBe(200);
      expect(probeCursors).toEqual(new Map([['strong-model', 3]]));
      expect(workerInvocations).toEqual([]);
      const childConversations = await app.db.getRepository('aiConversations').find({
        filter: { userId: adminId, from: 'sub-agent' },
      });
      expect(
        childConversations.filter((item) => recordOrEmpty(item.get('options')).hierarchyRootSessionId === sessionId),
      ).toHaveLength(0);
    } finally {
      await rootBinding.update({ harnessTag: originalTag });
    }
  });

  it('widens legacy usage identifiers without losing rows and accepts the complete employee username', async () => {
    if (app.db.sequelize.getDialect() !== 'postgres') return;
    const migrationSuffix = `${process.pid}-${Date.now()}`;
    const spans = app.db.getRepository('agentExecutionSpans');
    const collection = app.db.getCollection('agentExecutionSpans');
    const table = collection.getTableNameWithSchema();
    const queryInterface = app.db.sequelize.getQueryInterface();
    const legacyValue = `legacy-role-${Date.now()}`;
    const legacy = await spans.create({
      values: {
        rootRunId: `migration-legacy-${migrationSuffix}`,
        type: 'model_call',
        status: 'success',
        role: legacyValue,
        employeeUsername: legacyValue,
        leaderUsername: 'legacy-leader',
      },
    });
    const migration = Object.create(WidenNativeEmployeeIdentifiers.prototype) as WidenNativeEmployeeIdentifiers;
    Object.defineProperty(migration, 'db', { value: app.db });

    try {
      for (const attribute of ['role', 'employeeUsername', 'leaderUsername']) {
        const field = collection.model.rawAttributes[attribute]?.field || attribute;
        const columns = await queryInterface.describeTable(table);
        const column = columns[field];
        if (!column) throw new Error(`The ${attribute} column is unavailable.`);
        await queryInterface.changeColumn(table, field, {
          type: DataTypes.STRING(30),
          allowNull: column.allowNull,
          ...(column.defaultValue == null ? {} : { defaultValue: column.defaultValue }),
        });
      }
      await migration.up();
      const preserved = await spans.findOne({ filterByTk: legacy.get('id') });
      expect(preserved?.get('role')).toBe(legacyValue);
      expect(preserved?.get('employeeUsername')).toBe(legacyValue);
      expect(preserved?.get('leaderUsername')).toBe('legacy-leader');
      await spans.create({
        values: {
          rootRunId: `migration-long-${migrationSuffix}`,
          type: 'model_call',
          status: 'success',
          role: workerUsername,
          employeeUsername: workerUsername,
          leaderUsername,
        },
      });
      const columns = await queryInterface.describeTable(table);
      expect(String(columns.role?.type)).toMatch(/255/);
      expect(String(columns.employeeUsername?.type)).toMatch(/255/);
      expect(String(columns.leaderUsername?.type)).toMatch(/255/);
    } finally {
      await migration.up();
    }
  });

  it('runs registered root, specialist, and worker agents through a deterministic provider and backend tool', async () => {
    probeCursors.clear();
    providerToolNames.clear();
    providerInputs.clear();
    workerInvocations.length = 0;
    probeScripts.clear();
    probeScripts.set('strong-model', [
      { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: targetUsername, question: 'Read the fixture.' },
      },
      {
        kind: 'answer',
        text: 'Root synthesized verified evidence: ',
        requireContext: workerEvidence,
        appendMarker: workerEvidence,
      },
    ]);
    probeScripts.set('lite-model', [
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: workerUsername, question: 'Read fixture.txt.' },
      },
      {
        kind: 'answer',
        text: 'Specialist synthesized worker evidence: ',
        requireContext: workerEvidence,
        appendMarker: workerEvidence,
      },
    ]);
    probeScripts.set('worker-lite', [
      { kind: 'tool', name: 'worker_read_tool', args: { path: 'fixture.txt' } },
      {
        kind: 'answer',
        text: 'Worker verified tool output: ',
        requireContext: workerEvidence,
        appendMarker: workerEvidence,
      },
    ]);

    const response = await adminAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId: rootSessionId,
        aiEmployee: leaderUsername,
        model: { llmService: 'mock-root', model: 'strong-model' },
        messages: [{ role: 'user', content: { type: 'text', content: 'Read fixture.txt and summarize it.' } }],
        stream: false,
      },
    });

    expect(response.status).toBe(200);
    expect(workerInvocations).toEqual([{ path: 'fixture.txt' }]);
    expect(providerToolNames.get('lite-model')).toEqual([HIERARCHY_DISPATCH_TOOL, HIERARCHY_LIST_TOOL]);
    expect(providerToolNames.get('worker-lite')).toEqual(['worker_read_tool']);
    expect(providerToolNames.get('strong-model')).toContain(HIERARCHY_LIST_TOOL);
    expect(providerToolNames.get('strong-model')).toContain(HIERARCHY_DISPATCH_TOOL);
    expect(providerToolNames.get('strong-model')).not.toContain('worker_read_tool');
    const specialistInputs = providerInputs.get('lite-model')?.[1] ?? [];
    const specialistPrompt = JSON.stringify(specialistInputs);
    expect(specialistPrompt).toContain(workerEvidence);
    expect(specialistPrompt).toContain('worker_read_tool');
    const specialistPayload = toolPayloadForCall(specialistInputs, 'lite-model-call-1');
    expect(specialistPayload).toMatchObject({
      username: workerUsername,
      answer: expect.stringContaining(workerEvidence),
      evidence: {
        items: [
          expect.objectContaining({
            messageId: expect.any(String),
            toolCallId: expect.any(String),
            toolName: 'worker_read_tool',
            excerpt: workerEvidence,
          }),
        ],
      },
    });
    expect(specialistPayload).not.toHaveProperty('messages');
    expect(specialistPayload).not.toHaveProperty('transcript');
    const rootInputs = providerInputs.get('strong-model')?.[2] ?? [];
    const rootSynthesisPrompt = JSON.stringify(rootInputs);
    expect(rootSynthesisPrompt).toContain(workerEvidence);
    expect(rootSynthesisPrompt).toContain('worker_read_tool');
    const rootPayload = toolPayloadForCall(rootInputs, 'strong-model-call-2');
    expect(rootPayload).toMatchObject({
      username: targetUsername,
      answer: expect.stringContaining(workerEvidence),
      evidence: {
        items: [expect.objectContaining({ toolName: 'worker_read_tool', excerpt: workerEvidence })],
      },
    });
    expect(rootPayload).not.toHaveProperty('messages');
    expect(rootPayload).not.toHaveProperty('transcript');

    const childConversations = await app.db.getRepository('aiConversations').find({
      filter: { userId: adminId, from: 'sub-agent' },
    });
    expect(childConversations).toHaveLength(2);
    expect(childConversations.map((item) => item.get('aiEmployeeUsername')).sort()).toEqual(
      [targetUsername, workerUsername].sort(),
    );
    const invocations = await app.db.getRepository('agentHierarchyInvocations').find({
      filter: { rootSessionId, ownerId: adminId },
    });
    expect(invocations).toHaveLength(2);
    expect(
      invocations.map((item) => ({
        parentEmployee: item.get('parentEmployee'),
        employeeUsername: item.get('employeeUsername'),
        role: item.get('role'),
        status: item.get('status'),
        snapshot: item.get('snapshot'),
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentEmployee: leaderUsername,
          employeeUsername: targetUsername,
          role: 'specialist',
          status: 'succeeded',
          snapshot: expect.objectContaining({ model: { llmService: 'mock-backup', model: 'lite-model' } }),
        }),
        expect.objectContaining({
          parentEmployee: targetUsername,
          employeeUsername: workerUsername,
          role: 'worker',
          status: 'succeeded',
          snapshot: expect.objectContaining({ model: { llmService: 'mock-worker', model: 'worker-lite' } }),
        }),
      ]),
    );
    const hierarchySpans = await app.db.getRepository('agentExecutionSpans').find({
      filter: { rootRunId: `hierarchy:${rootSessionId}`, type: 'sub_agent' },
    });
    expect(hierarchySpans).toHaveLength(2);
    expect(hierarchySpans.map((item) => item.get('status'))).toEqual(['success', 'success']);
    const workerConversation = childConversations.find((item) => item.get('aiEmployeeUsername') === workerUsername);
    if (!workerConversation) throw new Error('The worker conversation was not persisted.');
    const workerUsage = await app.db.getRepository('agentExecutionSpans').find({
      filter: {
        usageSessionId: workerConversation.get('sessionId'),
        type: 'model_call',
        source: 'native-plugin-ai',
        model: 'worker-lite',
      },
    });
    expect(workerUsage).toHaveLength(2);
    expect(workerUsage.every((item) => item.get('role') === workerUsername)).toBe(true);
    expect(workerUsage.every((item) => item.get('employeeUsername') === workerUsername)).toBe(true);
    expect(probeCursors).toEqual(
      new Map([
        ['strong-model', 3],
        ['lite-model', 2],
        ['worker-lite', 2],
      ]),
    );
    const rootAnswer = await app.db.getRepository('aiMessages').findOne({
      filter: { sessionId: rootSessionId, role: leaderUsername },
      sort: ['-messageId'],
    });
    expect(JSON.stringify(rootAnswer?.get('content'))).toContain(workerEvidence);
  });

  it('blocks native conversation actions from bypassing a managed worker child', async () => {
    const conversations = await app.db.getRepository('aiConversations').find({
      filter: { userId: adminId, from: 'sub-agent', aiEmployeeUsername: workerUsername },
    });
    const workerConversation = conversations.find(
      (item) => recordOrEmpty(item.get('options')).hierarchyRootSessionId === rootSessionId,
    );
    if (!workerConversation) throw new Error('The managed worker conversation was not persisted.');
    const workerSessionId = String(workerConversation.get('sessionId'));
    const toolRows = await app.db.getRepository('aiToolMessages').find({
      filter: { sessionId: workerSessionId, toolName: 'worker_read_tool' },
      sort: ['id'],
    });
    if (toolRows.length !== 1) throw new Error('The managed worker tool call was not persisted.');
    const toolRow = toolRows[0];
    const messageId = Number(toolRow.get('messageId'));
    const toolCallId = String(toolRow.get('toolCallId'));
    if (!Number.isSafeInteger(messageId) || !toolCallId)
      throw new Error('The worker tool message identity is invalid.');
    const toolMessage = await app.db.getRepository('aiMessages').findOne({
      filter: { sessionId: workerSessionId, messageId },
    });
    if (!toolMessage) throw new Error('The worker tool call message was not persisted.');
    const originalToolCalls = toolMessage.get('toolCalls');
    const originalConversationOptions = workerConversation.get('options');
    const originalToolState = {
      status: toolRow.get('status'),
      invokeStatus: toolRow.get('invokeStatus'),
      userDecision: toolRow.get('userDecision'),
    };
    const cursorSnapshot = new Map(probeCursors);
    const invocationCount = workerInvocations.length;

    const malformedSession = await adminAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId: [workerSessionId] as unknown as string,
        aiEmployee: workerUsername,
        model: { llmService: 'mock-worker', model: 'worker-lite' },
        messages: [{ role: 'user', content: { type: 'text', content: 'Malformed child session ID.' } }],
        stream: false,
      },
    });
    expect(malformedSession.status).toBe(400);
    const malformedOptions = await adminAgent.resource('aiConversations').updateOptions({
      filterByTk: [workerSessionId] as unknown as string,
      values: { systemMessage: 'Malformed child session ID.' },
    });
    expect(malformedOptions.status).toBe(400);
    const malformedDecision = await adminAgent.resource('aiConversations').updateUserDecision({
      values: { sessionId: rootSessionId, messageId: { id: messageId }, toolCallId, userDecision: 'allow' },
    });
    expect(malformedDecision.status).toBe(400);
    const malformedArgs = await adminAgent.resource('aiConversations').updateToolArgs({
      values: {
        sessionId: rootSessionId,
        messageId: [messageId],
        tool: { id: toolCallId, args: { path: 'tampered.txt' } },
      },
    });
    expect(malformedArgs.status).toBe(400);
    const unchangedConversation = await app.db.getRepository('aiConversations').findOne({
      filter: { sessionId: workerSessionId, userId: adminId },
    });
    expect(unchangedConversation?.get('options')).toEqual(originalConversationOptions);
    const unchangedTool = await app.db.getRepository('aiToolMessages').findOne({ filterByTk: toolRow.get('id') });
    expect({
      status: unchangedTool?.get('status'),
      invokeStatus: unchangedTool?.get('invokeStatus'),
      userDecision: unchangedTool?.get('userDecision'),
    }).toEqual(originalToolState);
    const unchangedMessage = await app.db.getRepository('aiMessages').findOne({
      filter: { sessionId: workerSessionId, messageId },
    });
    expect(unchangedMessage?.get('toolCalls')).toEqual(originalToolCalls);

    const directSend = await adminAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId: workerSessionId,
        aiEmployee: workerUsername,
        model: { llmService: 'mock-worker', model: 'worker-lite' },
        messages: [{ role: 'user', content: { type: 'text', content: 'Call the worker tool directly.' } }],
        stream: false,
      },
    });
    expect(directSend.status).toBe(403);
    const directResend = await adminAgent.resource('aiConversations').resendMessages({
      values: { sessionId: workerSessionId, stream: false },
    });
    expect(directResend.status).toBe(403);
    const directResume = await adminAgent.resource('aiConversations').resumeToolCall({
      values: { sessionId: workerSessionId, messageId },
    });
    expect(directResume.status).toBe(403);
    const directAbort = await adminAgent.resource('aiConversations').abort({ values: { sessionId: workerSessionId } });
    expect(directAbort.status).toBe(403);
    const directOptions = await adminAgent.resource('aiConversations').updateOptions({
      filterByTk: workerSessionId,
      values: { systemMessage: 'Try to replace the managed prompt.' },
    });
    expect(directOptions.status).toBe(403);
    const childHistory = await adminAgent.resource('aiConversations').getMessages({ sessionId: workerSessionId });
    expect(childHistory.status).toBe(200);
    const crossSessionEdit = await adminAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId: rootSessionId,
        aiEmployee: leaderUsername,
        editingMessageId: messageId,
        messages: [{ role: 'user', content: { type: 'text', content: 'Edit a managed child message.' } }],
        stream: false,
      },
    });
    expect(crossSessionEdit.status).toBe(403);
    const crossSessionResend = await adminAgent.resource('aiConversations').resendMessages({
      values: { sessionId: rootSessionId, messageId, stream: false },
    });
    expect(crossSessionResend.status).toBe(403);
    const crossSessionResume = await adminAgent.resource('aiConversations').resumeToolCall({
      values: { sessionId: rootSessionId, messageId },
    });
    expect(crossSessionResume.status).toBe(403);

    await toolRow.update({ status: 'waiting', invokeStatus: 'interrupted', userDecision: null });
    try {
      const crossSessionDecision = await adminAgent.resource('aiConversations').updateUserDecision({
        values: { sessionId: rootSessionId, messageId, toolCallId, userDecision: 'allow' },
      });
      expect(crossSessionDecision.status).toBe(403);
      const crossSessionArgs = await adminAgent.resource('aiConversations').updateToolArgs({
        values: { sessionId: rootSessionId, messageId, tool: { id: toolCallId, args: { path: 'tampered.txt' } } },
      });
      expect(crossSessionArgs.status).toBe(403);
      const persistedTool = await app.db.getRepository('aiToolMessages').findOne({ filterByTk: toolRow.get('id') });
      expect(persistedTool?.get('invokeStatus')).toBe('interrupted');
      expect(persistedTool?.get('userDecision')).toBeNull();
      const persistedMessage = await app.db.getRepository('aiMessages').findOne({
        filter: { sessionId: workerSessionId, messageId },
      });
      expect(persistedMessage?.get('toolCalls')).toEqual(originalToolCalls);
    } finally {
      await toolRow.update({ status: 'success', invokeStatus: 'done', userDecision: null });
    }

    expect(probeCursors).toEqual(cursorSnapshot);
    expect(workerInvocations).toHaveLength(invocationCount);
  });

  it('lets the root answer directly without creating a delegated conversation', async () => {
    probeCursors.clear();
    providerToolNames.clear();
    workerInvocations.length = 0;
    probeScripts.clear();
    probeScripts.set('strong-model', [{ kind: 'answer', text: 'I can answer this directly.' }]);
    const conversations = app.db.getRepository('aiConversations');
    const previousChildren = await conversations.find({ filter: { userId: adminId, from: 'sub-agent' } });
    const previousChildIds = new Set(previousChildren.map((item) => String(item.get('sessionId'))));
    const sessionId = randomUUID();
    await conversations.create({
      values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title: 'Direct answer test' },
    });

    const response = await adminAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId,
        aiEmployee: leaderUsername,
        model: { llmService: 'mock-root', model: 'strong-model' },
        messages: [{ role: 'user', content: { type: 'text', content: 'What is two plus two?' } }],
        stream: false,
      },
    });

    expect(response.status).toBe(200);
    expect(probeCursors).toEqual(new Map([['strong-model', 1]]));
    expect(workerInvocations).toEqual([]);
    const allChildren = await conversations.find({ filter: { userId: adminId, from: 'sub-agent' } });
    expect(allChildren.filter((item) => !previousChildIds.has(String(item.get('sessionId'))))).toHaveLength(0);
    expect(
      await app.db.getRepository('agentHierarchyInvocations').find({ filter: { rootSessionId: sessionId } }),
    ).toHaveLength(0);
  });

  it('keeps root model-call count unchanged when one worker reads two files in the same session', async () => {
    probeCursors.clear();
    providerInputs.clear();
    workerInvocations.length = 0;
    probeScripts.clear();
    probeScripts.set('strong-model', [
      { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: targetUsername, question: 'Read two files.' },
      },
      {
        kind: 'answer',
        text: 'Root synthesized the worker evidence: ',
        requireContext: workerEvidence,
        appendMarker: workerEvidence,
      },
    ]);
    probeScripts.set('lite-model', [
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: workerUsername, question: 'Read fixture.txt and reference.txt.' },
      },
      {
        kind: 'answer',
        text: 'Specialist synthesized worker evidence: ',
        requireContext: workerEvidence,
        appendMarker: workerEvidence,
      },
    ]);
    probeScripts.set('worker-lite', [
      { kind: 'tool', name: 'worker_read_tool', args: { path: 'fixture.txt' } },
      { kind: 'tool', name: 'worker_read_tool', args: { path: 'reference.txt' } },
      {
        kind: 'answer',
        text: 'Worker synthesized both reads, including: ',
        requireContext: workerEvidence,
        appendMarker: workerEvidence,
      },
    ]);
    const sessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title: 'Two reads test' },
    });

    const response = await adminAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId,
        aiEmployee: leaderUsername,
        model: { llmService: 'mock-root', model: 'strong-model' },
        messages: [{ role: 'user', content: { type: 'text', content: 'Read fixture.txt and reference.txt.' } }],
        stream: false,
      },
    });

    expect(response.status).toBe(200);
    expect(workerInvocations).toEqual([{ path: 'fixture.txt' }, { path: 'reference.txt' }]);
    expect(probeCursors).toEqual(
      new Map([
        ['strong-model', 3],
        ['lite-model', 2],
        ['worker-lite', 3],
      ]),
    );
    const workers = await app.db.getRepository('aiConversations').find({
      filter: { userId: adminId, from: 'sub-agent', aiEmployeeUsername: workerUsername },
    });
    const worker = workers.find((item) => recordOrEmpty(item.get('options')).hierarchyRootSessionId === sessionId);
    if (!worker) throw new Error('The two-read worker conversation was not persisted.');
    expect(
      await app.db.getRepository('aiToolMessages').find({
        filter: { sessionId: worker.get('sessionId'), toolName: 'worker_read_tool', status: 'success' },
      }),
    ).toHaveLength(2);
    expect(JSON.stringify(providerInputs.get('strong-model')?.[2] ?? [])).toContain(workerEvidence);
  });

  it('limits nested dispatch to the effective binding depth', async () => {
    const rootBinding = await app.db
      .getRepository('orchestratorConfig')
      .findOne({ filter: { leaderUsername, subAgentUsername: targetUsername } });
    if (!rootBinding) throw new Error('The specialist routing binding was not created.');
    await rootBinding.update({ maxDepth: 1 });
    workerInvocations.length = 0;
    probeCursors.clear();
    probeScripts.clear();
    probeScripts.set('strong-model', [
      { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: targetUsername, question: 'Delegate within the depth limit.' },
      },
      { kind: 'answer', text: 'Root received the specialist result.' },
    ]);
    probeScripts.set('lite-model', [
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: workerUsername, question: 'This edge exceeds maxDepth=1.' },
      },
      { kind: 'answer', text: 'The nested delegation was denied by the configured depth.' },
    ]);

    const conversations = app.db.getRepository('aiConversations');
    const previousChildren = await conversations.find({ filter: { userId: adminId, from: 'sub-agent' } });
    const previousChildIds = new Set(previousChildren.map((item) => String(item.get('sessionId'))));
    const sessionId = randomUUID();
    await conversations.create({
      values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title: 'Depth limit test' },
    });
    const response = await adminAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId,
        aiEmployee: leaderUsername,
        model: { llmService: 'mock-root', model: 'strong-model' },
        messages: [{ role: 'user', content: { type: 'text', content: 'Use a specialist.' } }],
        stream: false,
      },
    });

    expect(response.status).toBe(200);
    expect(workerInvocations).toEqual([]);
    const allChildren = await conversations.find({ filter: { userId: adminId, from: 'sub-agent' } });
    const children = allChildren.filter((item) => !previousChildIds.has(String(item.get('sessionId'))));
    expect(children.map((item) => item.get('aiEmployeeUsername'))).toEqual([targetUsername]);
    const workerInvocationsJournal = await app.db.getRepository('agentHierarchyInvocations').find({
      filter: { rootSessionId: sessionId, employeeUsername: workerUsername },
    });
    expect(workerInvocationsJournal).toHaveLength(0);
    await rootBinding.update({ maxDepth: 2 });
  });

  it('rejects a worker dispatch when the current user never had worker access', async () => {
    const roleBindings = app.db.getRepository('rolesAiEmployees');
    await roleBindings.destroy({ filter: { roleName: 'member', aiEmployee: workerUsername } });
    try {
      probeCursors.clear();
      probeScripts.clear();
      probeScripts.set('strong-model', [
        { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
        {
          kind: 'tool',
          name: HIERARCHY_DISPATCH_TOOL,
          args: { username: targetUsername, question: 'Try the available specialist.' },
        },
        { kind: 'answer', text: 'The specialist returned its available result.' },
      ]);
      probeScripts.set('lite-model', [
        {
          kind: 'tool',
          name: HIERARCHY_DISPATCH_TOOL,
          args: { username: workerUsername, question: 'Read a file.' },
        },
        { kind: 'answer', text: 'The requested worker is not available to this user.' },
      ]);
      probeScripts.set('worker-lite', [{ kind: 'answer', text: 'This model must not run.' }]);
      workerInvocations.length = 0;

      const conversations = app.db.getRepository('aiConversations');
      const previousChildren = await conversations.find({ filter: { userId: memberId, from: 'sub-agent' } });
      const previousChildIds = new Set(previousChildren.map((item) => String(item.get('sessionId'))));
      const sessionId = randomUUID();
      await conversations.create({
        values: { sessionId, userId: memberId, aiEmployeeUsername: leaderUsername, title: 'Initial access test' },
      });

      const response = await memberAgent.resource('aiConversations').sendMessages({
        values: {
          sessionId,
          aiEmployee: leaderUsername,
          model: { llmService: 'mock-root', model: 'strong-model' },
          messages: [{ role: 'user', content: { type: 'text', content: 'Read a file using a worker.' } }],
          stream: false,
        },
      });

      expect(response.status).toBe(200);
      expect(workerInvocations).toEqual([]);
      expect(probeCursors.get('worker-lite')).toBeUndefined();
      const allChildren = await conversations.find({ filter: { userId: memberId, from: 'sub-agent' } });
      expect(
        allChildren
          .filter((item) => !previousChildIds.has(String(item.get('sessionId'))))
          .map((item) => item.get('aiEmployeeUsername')),
      ).toEqual([targetUsername]);
      expect(
        await app.db.getRepository('agentHierarchyInvocations').find({
          filter: { rootSessionId: sessionId, employeeUsername: workerUsername },
        }),
      ).toHaveLength(0);
    } finally {
      const restored = await roleBindings.findOne({ filter: { roleName: 'member', aiEmployee: workerUsername } });
      if (!restored) await roleBindings.create({ values: { roleName: 'member', aiEmployee: workerUsername } });
    }
  });

  it('rechecks employee authorization before each worker tool and blocks the second call after role mapping removal', async () => {
    workerInvocations.length = 0;
    probeCursors.clear();
    probeScripts.clear();
    probeScripts.set('strong-model', [
      { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: targetUsername, question: 'Read two files.' },
      },
      { kind: 'answer', text: 'Root reviewed the available evidence.' },
    ]);
    probeScripts.set('lite-model', [
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: workerUsername, question: 'Read both files.' },
      },
      { kind: 'answer', text: 'The first file was read; access changed before the second.' },
    ]);
    probeScripts.set('worker-lite', [
      { kind: 'tool', name: 'worker_read_tool', args: { path: 'first.txt' } },
      { kind: 'tool', name: 'worker_read_tool', args: { path: 'second.txt' } },
      { kind: 'answer', text: 'I could read the first file before access changed.' },
    ]);
    afterWorkerInvoke = async () => {
      afterWorkerInvoke = undefined;
      await app.db
        .getRepository('rolesAiEmployees')
        .destroy({ filter: { roleName: 'member', aiEmployee: workerUsername } });
    };

    const response = await memberAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId: memberSessionId,
        aiEmployee: leaderUsername,
        model: { llmService: 'mock-root', model: 'strong-model' },
        messages: [{ role: 'user', content: { type: 'text', content: 'Read first.txt and second.txt.' } }],
        stream: false,
      },
    });

    expect(response.status).toBe(200);
    expect(workerInvocations).toEqual([{ path: 'first.txt' }]);
    const workerConversation = await app.db.getRepository('aiConversations').findOne({
      filter: { userId: memberId, from: 'sub-agent', aiEmployeeUsername: workerUsername },
    });
    if (!workerConversation) throw new Error('The worker conversation was not persisted.');
    const toolRows = await app.db.getRepository('aiToolMessages').find({
      filter: { sessionId: workerConversation.get('sessionId'), toolName: 'worker_read_tool' },
      sort: ['id'],
    });
    expect(toolRows).toHaveLength(2);
    expect(toolRows[0].get('status')).toBe('success');
    expect(toolRows[1].get('status')).not.toBe('success');
    const workerJournal = await app.db.getRepository('agentHierarchyInvocations').findOne({
      filter: { rootSessionId: memberSessionId, employeeUsername: workerUsername },
    });
    expect(workerJournal?.get('status')).toBe('uncertain');
  });

  it.each([true, false])(
    'propagates the native conversation abort into an active worker read (stream=%s)',
    async (stream) => {
      probeCursors.clear();
      probeGenerationModes.clear();
      probeScripts.clear();
      probeScripts.set('strong-model', [
        { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
        {
          kind: 'tool',
          name: HIERARCHY_DISPATCH_TOOL,
          args: { username: targetUsername, question: 'Read a file and stop if cancelled.' },
        },
        { kind: 'answer', text: 'The root finished after receiving the worker result.' },
      ]);
      probeScripts.set('lite-model', [
        {
          kind: 'tool',
          name: HIERARCHY_DISPATCH_TOOL,
          args: { username: workerUsername, question: 'Read cancel.txt.' },
        },
        { kind: 'answer', text: 'The specialist received the worker result.' },
      ]);
      probeScripts.set('worker-lite', [
        { kind: 'tool', name: 'worker_read_tool', args: { path: 'cancel.txt' } },
        { kind: 'answer', text: 'The worker received the read result.' },
      ]);
      workerInvocations.length = 0;

      let signalWorkerStarted = () => undefined;
      let finishWorkerRead = () => undefined;
      const workerStarted = new Promise<void>((resolve) => {
        signalWorkerStarted = resolve;
      });
      const gatedRead = new Promise<void>((resolve) => {
        finishWorkerRead = resolve;
      });
      afterWorkerInvoke = async () => {
        signalWorkerStarted();
        await gatedRead;
      };
      const sessionId = randomUUID();
      await app.db.getRepository('aiConversations').create({
        values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title: 'Cancel propagation test' },
      });
      const requestOutcome = Promise.resolve(
        adminAgent.resource('aiConversations').sendMessages({
          values: {
            sessionId,
            aiEmployee: leaderUsername,
            model: { llmService: 'mock-root', model: 'strong-model' },
            messages: [{ role: 'user', content: { type: 'text', content: 'Read cancel.txt.' } }],
            stream,
          },
        }),
      ).then(
        (response) => ({ kind: 'response' as const, response }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      let countsAtAbort: Map<string, number> | undefined;
      let generationMethodsAtAbort: Map<string, ProbeGenerationCounts> | undefined;
      let countsBeforeRelease: Map<string, number> | undefined;
      let generationMethodsBeforeRelease: Map<string, ProbeGenerationCounts> | undefined;

      try {
        const start = await within(
          Promise.race([
            workerStarted.then(() => ({ kind: 'started' as const })),
            requestOutcome.then((outcome) => ({ kind: 'request' as const, outcome })),
          ]),
          5000,
          'Worker read did not start and the request did not return.',
        );
        if (start.kind === 'request') {
          throw new Error(
            start.outcome.kind === 'response'
              ? `The request returned status ${start.outcome.response.status} before the worker started.`
              : `The request failed before the worker started: ${String(start.outcome.error)}`,
          );
        }
        if (stream) {
          const ai = app.pm.get('ai') as unknown as PluginAiProbe;
          expect(ai.aiEmployeesManager.conversationController.get(sessionId)).toBeDefined();
        }
        countsAtAbort = new Map(probeCursors);
        generationMethodsAtAbort = generationModeSnapshot();
        expect(countsAtAbort).toEqual(
          new Map([
            ['strong-model', 2],
            ['lite-model', 1],
            ['worker-lite', 1],
          ]),
        );
        expect(generationMethodsAtAbort).toEqual(
          new Map<string, ProbeGenerationCounts>([
            ['strong-model', { generate: stream ? 0 : 2, stream: stream ? 2 : 0 }],
            ['lite-model', { generate: stream ? 0 : 1, stream: stream ? 1 : 0 }],
            ['worker-lite', { generate: stream ? 0 : 1, stream: stream ? 1 : 0 }],
          ]),
        );
        const abortResponse = await adminAgent.resource('aiConversations').abort({ values: { sessionId } });
        expect(abortResponse.status).toBe(200);
        const outcome = await within(requestOutcome, 5000, 'Aborted request did not return.');
        if (outcome.kind === 'error') throw outcome.error;
        if (stream) {
          expect(outcome.response.status).toBe(200);
          const streamText = String(outcome.response.text ?? '');
          expect(streamText).toContain('"type":"stream_start"');
          expect(streamText).toContain('"type":"tool_call_chunks"');
          expect(streamText).not.toContain('The root finished after receiving the worker result.');
        } else {
          expect(outcome.response.status).toBe(499);
        }
        countsBeforeRelease = new Map(probeCursors);
        generationMethodsBeforeRelease = generationModeSnapshot();
        expect(countsBeforeRelease).toEqual(
          new Map([
            ['strong-model', stream ? 2 : 3],
            ['lite-model', 1],
            ['worker-lite', 1],
          ]),
        );
        expect(generationMethodsBeforeRelease).toEqual(
          new Map<string, ProbeGenerationCounts>([
            ['strong-model', { generate: stream ? 0 : 3, stream: stream ? 2 : 0 }],
            ['lite-model', { generate: stream ? 0 : 1, stream: stream ? 1 : 0 }],
            ['worker-lite', { generate: stream ? 0 : 1, stream: stream ? 1 : 0 }],
          ]),
        );
      } finally {
        finishWorkerRead();
        afterWorkerInvoke = undefined;
        await within(requestOutcome, 5000, 'Cancelled request was not drained after releasing the worker read.');
      }

      expect(probeCursors).toEqual(countsBeforeRelease);
      expect(countsAtAbort).toEqual(
        new Map([
          ['strong-model', 2],
          ['lite-model', 1],
          ['worker-lite', 1],
        ]),
      );
      expect(countsBeforeRelease).toEqual(probeCursors);
      expect(generationMethodsBeforeRelease).toEqual(generationModeSnapshot());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(probeCursors).toEqual(countsBeforeRelease);
      expect(generationMethodsBeforeRelease).toEqual(generationModeSnapshot());
      expect(workerInvocations).toEqual([{ path: 'cancel.txt' }]);
      const workerJournal = await app.db.getRepository('agentHierarchyInvocations').findOne({
        filter: { rootSessionId: sessionId, employeeUsername: workerUsername },
      });
      expect(workerJournal?.get('status')).toBe('uncertain');
      const workers = await app.db.getRepository('aiConversations').find({
        filter: { userId: adminId, from: 'sub-agent', aiEmployeeUsername: workerUsername },
      });
      const worker = workers.find((item) => recordOrEmpty(item.get('options')).hierarchyRootSessionId === sessionId);
      if (!worker) throw new Error('The cancelled worker conversation was not persisted.');
      const toolRows = await app.db.getRepository('aiToolMessages').find({
        filter: { sessionId: worker.get('sessionId'), toolName: 'worker_read_tool' },
      });
      expect(toolRows).toHaveLength(1);
      expect(toolRows[0].get('status')).not.toBe('success');
    },
  );

  it('bounds a non-cooperative worker read by binding timeout and discards its late result', async () => {
    const workerBinding = await app.db
      .getRepository('orchestratorConfig')
      .findOne({ filter: { leaderUsername: targetUsername, subAgentUsername: workerUsername } });
    if (!workerBinding) throw new Error('The worker routing binding was not created.');
    await workerBinding.update({ timeout: 1000 });
    workerInvocations.length = 0;
    probeCursors.clear();
    probeScripts.clear();
    probeScripts.set('strong-model', [
      { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: targetUsername, question: 'Read a slow file.' },
      },
      { kind: 'answer', text: 'The slow read exceeded its delegated time budget.' },
    ]);
    probeScripts.set('lite-model', [
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: workerUsername, question: 'Read slow.txt.' },
      },
      { kind: 'answer', text: 'The worker operation did not finish in time.', allowMissingToolResult: true },
    ]);
    probeScripts.set('worker-lite', [
      { kind: 'tool', name: 'worker_read_tool', args: { path: 'slow.txt' } },
      { kind: 'answer', text: 'The late result must not be committed.' },
    ]);
    afterWorkerInvoke = async () => new Promise((resolve) => setTimeout(resolve, 1400));

    const sessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title: 'Timeout test' },
    });
    const startedAt = Date.now();
    const response = await adminAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId,
        aiEmployee: leaderUsername,
        model: { llmService: 'mock-root', model: 'strong-model' },
        messages: [{ role: 'user', content: { type: 'text', content: 'Read slow.txt.' } }],
        stream: false,
      },
    });
    const elapsedMs = Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(response.status).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(5000);
    expect(workerInvocations).toEqual([{ path: 'slow.txt' }]);
    const journal = await app.db.getRepository('agentHierarchyInvocations').find({
      filter: { rootSessionId: sessionId },
    });
    const workerJournal = journal.find((item) => item.get('employeeUsername') === workerUsername);
    expect(workerJournal?.get('status')).toBe('uncertain');
    const workerConversations = await app.db.getRepository('aiConversations').find({
      filter: { userId: adminId, from: 'sub-agent', aiEmployeeUsername: workerUsername },
    });
    const workerConversation = workerConversations.find(
      (item) => recordOrEmpty(item.get('options')).hierarchyRootSessionId === sessionId,
    );
    if (!workerConversation) throw new Error('The timed-out worker conversation was not persisted.');
    const lateToolResults = await app.db.getRepository('aiToolMessages').find({
      filter: {
        sessionId: workerConversation.get('sessionId'),
        toolName: 'worker_read_tool',
        status: 'success',
      },
    });
    expect(lateToolResults).toHaveLength(0);
    await workerBinding.update({ timeout: 120000 });
    afterWorkerInvoke = undefined;
  });

  it('blocks native dispatch and tools loaded through a skill on an enrolled root, while legacy roots pass', async () => {
    const config = app.db.getRepository('orchestratorConfig');
    const rootBinding = await config.findOne({ filter: { leaderUsername, subAgentUsername: targetUsername } });
    if (!rootBinding) throw new Error('The specialist routing binding was not created.');
    const employee = await app.db.getRepository('aiEmployees').findOne({ filter: { username: leaderUsername } });
    if (!employee) throw new Error('The orchestrator employee was not found.');

    await rootBinding.update({ routingEnabled: false });
    const legacyNext = vi.fn(async () => undefined);
    await guardHierarchyEnrollment(chatContext(app, adminId, rootSessionId, leaderUsername), legacyNext);
    expect(legacyNext).toHaveBeenCalledOnce();
    await rootBinding.update({ routingEnabled: true });

    await employee.update({
      skillSettings: { tools: [{ name: 'dispatch-sub-agent-task', autoCall: true }] },
      chatSettings: { enableSkills: false },
    });
    await expect(
      guardHierarchyEnrollment(
        chatContext(app, adminId, rootSessionId, leaderUsername),
        vi.fn(async () => undefined),
      ),
    ).rejects.toThrow('Disable native AI employee dispatch');

    await employee.update({ skillSettings: { tools: [] }, chatSettings: { enableSkills: false } });
    const aiToolId = Number(`${Date.now()}`);
    await app.db.getRepository('aiToolMessages').create({
      values: {
        id: aiToolId,
        sessionId: rootSessionId,
        messageId: aiToolId + 1,
        toolCallId: `loaded-skill-${aiToolId}`,
        toolName: 'getSkill',
        status: 'success',
        invokeStatus: 'confirmed',
        content: { skillName: 'loaded-worker-skill' },
      },
    });
    const ai = app.pm.get('ai') as unknown as PluginAiProbe;
    const skillsManager = ai.ai?.skillsManager;
    if (!skillsManager) throw new Error('The mock AI SkillsManager was not loaded.');
    vi.spyOn(skillsManager, 'getSkills').mockResolvedValue([
      { name: 'loaded-worker-skill', tools: ['worker_read_tool'] },
    ]);

    await expect(
      guardHierarchyEnrollment(
        chatContext(app, adminId, rootSessionId, leaderUsername),
        vi.fn(async () => undefined),
      ),
    ).rejects.toThrow('Remove managed worker tools');
  });

  it('auto-approves only an exact persisted root ASK after explicit session opt-in and preserves manual approval when off', async () => {
    const leader = await app.db.getRepository('aiEmployees').findOne({ filter: { username: leaderUsername } });
    if (!leader) throw new Error('The orchestrator employee was not found.');
    await leader.update({
      skillSettings: {
        tools: [
          { name: HIERARCHY_LIST_TOOL, autoCall: true },
          { name: HIERARCHY_DISPATCH_TOOL, autoCall: true },
          { name: 'session_ask_approval_probe', autoCall: false },
        ],
      },
      chatSettings: { enableSkills: false },
    });
    sessionAskInvocations.length = 0;
    const makeSession = async (title: string) => {
      const sessionId = randomUUID();
      await app.db.getRepository('aiConversations').create({
        values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title },
      });
      return sessionId;
    };
    const askInSession = async (sessionId: string, value: string) => {
      probeCursors.clear();
      probeScripts.clear();
      probeScripts.set('strong-model', [
        { kind: 'tool', name: 'session_ask_approval_probe', args: { value } },
        { kind: 'answer', text: `Finished ${value}.` },
      ]);
      const response = await adminAgent.resource('aiConversations').sendMessages({
        values: {
          sessionId,
          aiEmployee: leaderUsername,
          model: { llmService: 'mock-root', model: 'strong-model' },
          messages: [{ role: 'user', content: { type: 'text', content: `Run the approved task ${value}.` } }],
          stream: true,
        },
      });
      expect(response.status).toBe(200);
      const message = await app.db.getRepository('aiMessages').findOne({
        filter: { sessionId, role: leaderUsername },
        sort: ['-messageId'],
      });
      if (!message) throw new Error('The interrupted root message was not persisted.');
      const messageId = String(message.get('messageId'));
      const calls = message.get('toolCalls') as Array<{ id?: unknown; name?: unknown }> | undefined;
      const call = calls?.find((item) => item.name === 'session_ask_approval_probe');
      if (typeof call?.id !== 'string') throw new Error('The expected ASK tool call was not persisted.');
      const toolMessage = await app.db.getRepository('aiToolMessages').findOne({
        filter: {
          sessionId,
          messageId: message.get('messageId'),
          toolCallId: call.id,
          toolName: 'session_ask_approval_probe',
        },
      });
      expect(toolMessage?.get('invokeStatus')).toBe('interrupted');
      expect(toolMessage?.get('auto')).toBe(false);
      expect(sessionAskInvocations).toEqual([]);
      return { sessionId, messageId, toolCallId: call.id };
    };
    const identityValues = (identity: { sessionId: string; messageId: string; toolCallId: string }) => ({
      sessionId: identity.sessionId,
      messageId: identity.messageId,
      toolCallId: identity.toolCallId,
    });
    const isEligible = (identity: { sessionId: string; messageId: string; toolCallId: string }) =>
      adminAgent.resource('agentAutoApproval').eligible({ values: identityValues(identity) });
    const decide = (
      identity: { sessionId: string; messageId: string; toolCallId: string },
      agentAutoApproval: boolean,
      decisionType: 'approve' | 'reject' | 'edit' = 'approve',
    ) =>
      adminAgent.resource('aiConversations').updateUserDecision({
        values: {
          ...identityValues(identity),
          userDecision:
            decisionType === 'reject'
              ? { type: 'reject', message: 'Keep this call paused.' }
              : decisionType === 'edit'
                ? { type: 'edit', editedAction: { name: 'session_ask_approval_probe', args: { value: 'edited' } } }
                : { type: 'approve' },
          ...(agentAutoApproval ? { agentAutoApproval: true } : {}),
        },
      });
    const resume = (identity: { sessionId: string; messageId: string }) =>
      adminAgent.resource('aiConversations').resumeToolCall({
        values: {
          sessionId: identity.sessionId,
          messageId: identity.messageId,
          aiEmployee: leaderUsername,
          model: { llmService: 'mock-root', model: 'strong-model' },
        },
      });
    const findToolMessage = (identity: { sessionId: string; messageId: string; toolCallId: string }) =>
      app.db.getRepository('aiToolMessages').findOne({ filter: identityValues(identity) });

    const manualSession = await makeSession('Manual ASK while automatic approval is off');
    const manualCall = await askInSession(manualSession, 'manual');
    expect((await isEligible(manualCall)).body.data.eligible).toBe(false);
    const blockedAutoDecision = await decide(manualCall, true);
    expect(blockedAutoDecision.status).toBe(200);
    expect(blockedAutoDecision.body.data.updated).toBe(0);
    expect((await findToolMessage(manualCall))?.get('invokeStatus')).toBe('interrupted');
    const manualDecision = await decide(manualCall, false);
    expect(manualDecision.body.data.updated).toBe(1);
    const persistedManualDecision = await app.db.getRepository('aiToolMessages').findOne({
      filter: {
        sessionId: manualCall.sessionId,
        messageId: manualCall.messageId,
        toolCallId: manualCall.toolCallId,
      },
    });
    expect(persistedManualDecision?.get('invokeStatus')).toBe('waiting');
    expect(persistedManualDecision?.get('userDecision')).toEqual({ type: 'approve' });
    const ai = app.pm.get('ai') as unknown as {
      aiConversationsManager: {
        getUserDecisions: (messageId: string) => Promise<{ decisions: unknown[] } | undefined>;
      };
    };
    expect(await ai.aiConversationsManager.getUserDecisions(manualCall.messageId)).toEqual({
      interruptId: expect.any(String),
      decisions: [{ type: 'approve' }],
    });
    expect((await resume(manualCall)).status).toBe(200);
    expect(sessionAskInvocations).toEqual([{ value: 'manual' }]);

    const automaticSession = await makeSession('Session with automatic ASK approval');
    sessionAskInvocations.length = 0;
    expect(
      (
        await adminAgent.resource('agentAutoApproval').set({
          values: { sessionId: automaticSession, enabled: true },
        })
      ).status,
    ).toBe(200);
    const automaticCall = await askInSession(automaticSession, 'automatic');
    expect((await isEligible(automaticCall)).body.data.eligible).toBe(true);
    expect((await isEligible({ ...automaticCall, sessionId: manualSession })).body.data.eligible).toBe(false);
    expect(
      (await memberAgent.resource('agentAutoApproval').eligible({ values: identityValues(automaticCall) })).status,
    ).toBe(404);

    expect((await decide(automaticCall, true, 'reject')).body.data.updated).toBe(0);
    expect((await findToolMessage(automaticCall))?.get('invokeStatus')).toBe('interrupted');
    expect((await decide(automaticCall, true, 'edit')).body.data.updated).toBe(0);
    expect((await findToolMessage(automaticCall))?.get('invokeStatus')).toBe('interrupted');

    await adminAgent.resource('agentAutoApproval').set({
      values: { sessionId: automaticSession, enabled: false },
    });
    const disabledDuringInterrupt = await decide(automaticCall, true);
    expect(disabledDuringInterrupt.body.data.updated).toBe(0);
    expect((await findToolMessage(automaticCall))?.get('invokeStatus')).toBe('interrupted');

    await adminAgent.resource('agentAutoApproval').set({
      values: { sessionId: automaticSession, enabled: true },
    });
    const automaticDecision = await decide(automaticCall, true);
    expect(automaticDecision.body.data.updated).toBe(1);
    expect((await resume(automaticCall)).status).toBe(200);
    expect(sessionAskInvocations).toEqual([{ value: 'automatic' }]);
    const duplicateDecision = await decide(automaticCall, true);
    expect(duplicateDecision.body.data.updated).toBe(0);
    expect(sessionAskInvocations).toEqual([{ value: 'automatic' }]);
  });

  it('gates both specialist hierarchy tools on session opt-in and rechecks consent between calls', async () => {
    const profiles = new HarnessProfileService(app.db);
    const sourceProfile = await profiles.getPublishedByTag(profileTag);
    const rootBinding = await app.db
      .getRepository('orchestratorConfig')
      .findOne({ filter: { leaderUsername, subAgentUsername: targetUsername } });
    const specialist = await app.db.getRepository('aiEmployees').findOne({ filter: { username: targetUsername } });
    if (!sourceProfile || !rootBinding || !specialist)
      throw new Error('The specialist approval fixtures are unavailable.');

    const originalTag = String(rootBinding.get('harnessTag'));
    const originalSkillSettings = recordOrEmpty(specialist.get('skillSettings'));
    const originalChatSettings = recordOrEmpty(specialist.get('chatSettings'));
    const askTag = `hierarchy-specialist-ask-${Date.now()}`;
    const askProfile = await profiles.createProfile({
      tag: askTag,
      settings: {
        ...sourceProfile.settings,
        tools: {
          ...sourceProfile.settings.tools,
          allow: [],
          ask: [HIERARCHY_LIST_TOOL, HIERARCHY_DISPATCH_TOOL],
          effects: {
            ...sourceProfile.settings.tools.effects,
            [HIERARCHY_LIST_TOOL]: 'read',
            [HIERARCHY_DISPATCH_TOOL]: 'read',
          },
        },
      },
    });
    await rootBinding.update({ harnessTag: askProfile.profile.tag });
    await specialist.update({
      skillSettings: {
        ...originalSkillSettings,
        tools: [
          { name: HIERARCHY_LIST_TOOL, autoCall: false },
          { name: HIERARCHY_DISPATCH_TOOL, autoCall: false },
        ],
      },
      chatSettings: { ...originalChatSettings, enableSkills: false },
    });

    const makeSession = async (title: string) => {
      const sessionId = randomUUID();
      await app.db.getRepository('aiConversations').create({
        values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title },
      });
      return sessionId;
    };
    const setApproval = (sessionId: string, enabled: boolean) =>
      adminAgent.resource('agentAutoApproval').set({ values: { sessionId, enabled } });
    const setScripts = () => {
      beforeProbeStep.clear();
      probeCursors.clear();
      probeScripts.clear();
      workerInvocations.length = 0;
      probeScripts.set('strong-model', [
        { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
        {
          kind: 'tool',
          name: HIERARCHY_DISPATCH_TOOL,
          args: { username: targetUsername, question: 'Use the specialist tools and read fixture.txt.' },
        },
        { kind: 'answer', text: 'The orchestrator reviewed the specialist result.' },
      ]);
      probeScripts.set('lite-model', [
        { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
        {
          kind: 'tool',
          name: HIERARCHY_DISPATCH_TOOL,
          args: { username: workerUsername, question: 'Read fixture.txt.' },
        },
        { kind: 'answer', text: 'The specialist reviewed the worker result.' },
      ]);
      probeScripts.set('worker-lite', [
        { kind: 'tool', name: 'worker_read_tool', args: { path: 'fixture.txt' } },
        { kind: 'answer', text: `The worker verified ${workerEvidence}.`, requireContext: workerEvidence },
      ]);
    };
    const send = (sessionId: string) =>
      adminAgent.resource('aiConversations').sendMessages({
        values: {
          sessionId,
          aiEmployee: leaderUsername,
          model: { llmService: 'mock-root', model: 'strong-model' },
          messages: [{ role: 'user', content: { type: 'text', content: 'Delegate the read and summarize it.' } }],
          stream: false,
        },
      });
    const childForRootSession = async (sessionId: string) => {
      const children = await app.db.getRepository('aiConversations').find({
        filter: { userId: adminId, from: 'sub-agent', aiEmployeeUsername: targetUsername },
      });
      return children.find((item) => recordOrEmpty(item.get('options')).hierarchyRootSessionId === sessionId);
    };

    try {
      const previewSession = await makeSession('Specialist ASK preview switch test');
      expect((await setApproval(previewSession, false)).status).toBe(200);
      expect(
        (
          await adminAgent.resource('agentHierarchy').preview({
            values: { sessionId: previewSession, username: targetUsername },
          })
        ).status,
      ).toBe(409);
      expect((await setApproval(previewSession, true)).status).toBe(200);
      expect(
        (
          await adminAgent.resource('agentHierarchy').preview({
            values: { sessionId: previewSession, username: targetUsername },
          })
        ).status,
      ).toBe(200);

      const disabledSession = await makeSession('Specialist ASK disabled dispatch test');
      await setApproval(disabledSession, false);
      setScripts();
      expect((await send(disabledSession)).status).toBe(200);
      expect(workerInvocations).toEqual([]);
      expect(probeCursors.get('lite-model')).toBeUndefined();

      const enabledSession = await makeSession('Specialist ASK enabled dispatch test');
      await setApproval(enabledSession, true);
      setScripts();
      expect((await send(enabledSession)).status).toBe(200);
      expect(workerInvocations).toEqual([{ path: 'fixture.txt' }]);
      const enabledChild = await childForRootSession(enabledSession);
      if (!enabledChild) throw new Error('The enabled specialist conversation was not persisted.');
      const enabledToolRows = await app.db.getRepository('aiToolMessages').find({
        filter: { sessionId: enabledChild.get('sessionId') },
        sort: ['id'],
      });
      for (const name of [HIERARCHY_LIST_TOOL, HIERARCHY_DISPATCH_TOOL]) {
        const row = enabledToolRows.find((item) => item.get('toolName') === name);
        expect(row?.get('auto')).toBe(true);
        expect(row?.get('status')).toBe('success');
      }

      const revokedSession = await makeSession('Specialist ASK revoked during dispatch test');
      await setApproval(revokedSession, true);
      setScripts();
      beforeProbeStep.set('lite-model', async (index) => {
        if (index !== 1) return;
        beforeProbeStep.delete('lite-model');
        expect((await setApproval(revokedSession, false)).status).toBe(200);
      });
      expect((await send(revokedSession)).status).toBe(200);
      expect(workerInvocations).toEqual([]);
      const revokedChild = await childForRootSession(revokedSession);
      if (!revokedChild) throw new Error('The revoked specialist conversation was not persisted.');
      const revokedToolRows = await app.db.getRepository('aiToolMessages').find({
        filter: { sessionId: revokedChild.get('sessionId') },
        sort: ['id'],
      });
      expect(revokedToolRows.find((item) => item.get('toolName') === HIERARCHY_LIST_TOOL)?.get('status')).toBe(
        'success',
      );
      expect(revokedToolRows.find((item) => item.get('toolName') === HIERARCHY_DISPATCH_TOOL)?.get('status')).not.toBe(
        'success',
      );
    } finally {
      beforeProbeStep.delete('lite-model');
      afterWorkerInvoke = undefined;
      await rootBinding.update({ harnessTag: originalTag });
      await specialist.update({ skillSettings: originalSkillSettings, chatSettings: originalChatSettings });
    }
  });

  it('allows an ASK worker read only for an opted-in root session and stops after revocation', async () => {
    const profiles = new HarnessProfileService(app.db);
    const sourceWorkerProfile = await profiles.getPublishedByTag(workerProfileTag);
    const workerBinding = await app.db
      .getRepository('orchestratorConfig')
      .findOne({ filter: { leaderUsername: targetUsername, subAgentUsername: workerUsername } });
    const worker = await app.db.getRepository('aiEmployees').findOne({ filter: { username: workerUsername } });
    if (!sourceWorkerProfile || !workerBinding || !worker)
      throw new Error('The managed worker ASK fixtures are unavailable.');

    const originalTag = String(workerBinding.get('harnessTag'));
    const originalSkillSettings = recordOrEmpty(worker.get('skillSettings'));
    const originalChatSettings = recordOrEmpty(worker.get('chatSettings'));
    const askTag = `hierarchy-worker-ask-${Date.now()}`;
    const askProfile = await profiles.createProfile({
      tag: askTag,
      settings: {
        ...sourceWorkerProfile.settings,
        tools: {
          ...sourceWorkerProfile.settings.tools,
          allow: [],
          ask: ['worker_read_tool'],
          effects: { ...sourceWorkerProfile.settings.tools.effects, worker_read_tool: 'read' },
        },
      },
    });
    await workerBinding.update({ harnessTag: askProfile.profile.tag });
    await worker.update({
      skillSettings: { ...originalSkillSettings, tools: [{ name: 'worker_read_tool', autoCall: false }] },
      chatSettings: { ...originalChatSettings, enableSkills: false },
    });

    const makeSession = async (title: string) => {
      const sessionId = randomUUID();
      await app.db.getRepository('aiConversations').create({
        values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title },
      });
      return sessionId;
    };
    const setApproval = (sessionId: string, enabled: boolean) =>
      adminAgent.resource('agentAutoApproval').set({ values: { sessionId, enabled } });
    const setScripts = (paths: string[], requireEvidence = false) => {
      afterWorkerInvoke = undefined;
      probeCursors.clear();
      probeScripts.clear();
      providerInputs.clear();
      workerInvocations.length = 0;
      const evidenceExpectation = requireEvidence
        ? { requireContext: workerEvidence, appendMarker: workerEvidence }
        : {};
      probeScripts.set('strong-model', [
        { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
        {
          kind: 'tool',
          name: HIERARCHY_DISPATCH_TOOL,
          args: { username: targetUsername, question: `Read ${paths.join(' and ')}.` },
        },
        { kind: 'answer', text: 'The orchestrator received the specialist result.', ...evidenceExpectation },
      ]);
      probeScripts.set('lite-model', [
        {
          kind: 'tool',
          name: HIERARCHY_DISPATCH_TOOL,
          args: { username: workerUsername, question: `Read ${paths.join(' and ')}.` },
        },
        { kind: 'answer', text: 'The specialist received the worker result.', ...evidenceExpectation },
      ]);
      probeScripts.set('worker-lite', [
        ...paths.map((path) => ({ kind: 'tool' as const, name: 'worker_read_tool', args: { path } })),
        { kind: 'answer', text: 'The worker reviewed the available files.', ...evidenceExpectation },
      ]);
    };
    const send = (sessionId: string) =>
      adminAgent.resource('aiConversations').sendMessages({
        values: {
          sessionId,
          aiEmployee: leaderUsername,
          model: { llmService: 'mock-root', model: 'strong-model' },
          messages: [{ role: 'user', content: { type: 'text', content: 'Delegate the read-only file task.' } }],
          stream: false,
        },
      });
    const workerChildForRootSession = async (sessionId: string) => {
      const children = await app.db.getRepository('aiConversations').find({
        filter: { userId: adminId, from: 'sub-agent', aiEmployeeUsername: workerUsername },
      });
      return children.find((item) => recordOrEmpty(item.get('options')).hierarchyRootSessionId === sessionId);
    };

    try {
      const disabledSession = await makeSession('Managed worker ASK default-off test');
      setScripts(['fixture.txt']);
      expect((await send(disabledSession)).status).toBe(200);
      expect(workerInvocations).toEqual([]);
      expect(probeCursors.get('worker-lite')).toBeUndefined();

      const enabledSession = await makeSession('Managed worker ASK opted-in test');
      expect((await setApproval(enabledSession, true)).status).toBe(200);
      setScripts(['fixture.txt']);
      expect((await send(enabledSession)).status).toBe(200);
      expect(workerInvocations).toEqual([{ path: 'fixture.txt' }]);
      const enabledChild = await workerChildForRootSession(enabledSession);
      if (!enabledChild) throw new Error('The enabled managed worker conversation was not persisted.');
      const enabledToolRows = await app.db.getRepository('aiToolMessages').find({
        filter: { sessionId: enabledChild.get('sessionId'), toolName: 'worker_read_tool' },
        sort: ['id'],
      });
      expect(enabledToolRows).toHaveLength(1);
      expect(enabledToolRows[0].get('auto')).toBe(true);
      expect(enabledToolRows[0].get('status')).toBe('success');

      const deliveredSession = await makeSession('Managed worker result delivered after opt-out test');
      expect((await setApproval(deliveredSession, true)).status).toBe(200);
      setScripts(['fixture.txt'], true);
      afterWorkerInvoke = async () => {
        afterWorkerInvoke = undefined;
        expect((await setApproval(deliveredSession, false)).status).toBe(200);
      };
      expect((await send(deliveredSession)).status).toBe(200);
      expect(workerInvocations).toEqual([{ path: 'fixture.txt' }]);
      expect(probeCursors.get('worker-lite')).toBe(2);
      expect(JSON.stringify(providerInputs.get('worker-lite')?.[1] ?? [])).toContain(workerEvidence);
      expect(JSON.stringify(providerInputs.get('lite-model')?.[1] ?? [])).toContain(workerEvidence);
      expect(JSON.stringify(providerInputs.get('strong-model')?.[2] ?? [])).toContain(workerEvidence);

      const revokedSession = await makeSession('Managed worker ASK revoked between calls test');
      expect((await setApproval(revokedSession, true)).status).toBe(200);
      setScripts(['fixture.txt', 'second.txt']);
      afterWorkerInvoke = async () => {
        afterWorkerInvoke = undefined;
        expect((await setApproval(revokedSession, false)).status).toBe(200);
      };
      expect((await send(revokedSession)).status).toBe(200);
      expect(workerInvocations).toEqual([{ path: 'fixture.txt' }]);
      const revokedChild = await workerChildForRootSession(revokedSession);
      if (!revokedChild) throw new Error('The revoked managed worker conversation was not persisted.');
      const revokedToolRows = await app.db.getRepository('aiToolMessages').find({
        filter: { sessionId: revokedChild.get('sessionId'), toolName: 'worker_read_tool' },
        sort: ['id'],
      });
      expect(revokedToolRows).toHaveLength(2);
      expect(revokedToolRows[0].get('status')).toBe('success');
      expect(revokedToolRows[1].get('status')).not.toBe('success');
      expect(JSON.stringify(providerInputs.get('worker-lite')?.[1] ?? [])).toContain(workerEvidence);
    } finally {
      afterWorkerInvoke = undefined;
      await workerBinding.update({ harnessTag: originalTag });
      await worker.update({ skillSettings: originalSkillSettings, chatSettings: originalChatSettings });
    }
  });

  it('stops a later worker read when the published routing profile changes mid-run', async () => {
    const profiles = new HarnessProfileService(app.db);
    const sourceWorkerProfile = await profiles.getPublishedByTag(workerProfileTag);
    const workerBinding = await app.db
      .getRepository('orchestratorConfig')
      .findOne({ filter: { leaderUsername: targetUsername, subAgentUsername: workerUsername } });
    if (!sourceWorkerProfile || !workerBinding) throw new Error('The managed worker profile fixture is unavailable.');

    const originalTag = String(workerBinding.get('harnessTag'));
    const deniedProfile = await profiles.createProfile({
      tag: `hierarchy-worker-denied-mid-run-${Date.now()}`,
      settings: {
        ...sourceWorkerProfile.settings,
        tools: {
          ...sourceWorkerProfile.settings.tools,
          allow: [],
          ask: [],
          deny: ['worker_read_tool'],
        },
      },
    });
    const sessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: { sessionId, userId: adminId, aiEmployeeUsername: leaderUsername, title: 'Worker profile change test' },
    });
    probeCursors.clear();
    probeScripts.clear();
    providerInputs.clear();
    workerInvocations.length = 0;
    probeScripts.set('strong-model', [
      { kind: 'tool', name: HIERARCHY_LIST_TOOL, args: {} },
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: targetUsername, question: 'Read one file, then recheck the worker profile.' },
      },
      { kind: 'answer', text: 'The routing policy changed; I will not use a stale worker result.' },
    ]);
    probeScripts.set('lite-model', [
      {
        kind: 'tool',
        name: HIERARCHY_DISPATCH_TOOL,
        args: { username: workerUsername, question: 'Read first.txt and second.txt.' },
      },
      { kind: 'answer', text: 'The specialist could not verify a worker result.' },
    ]);
    probeScripts.set('worker-lite', [
      { kind: 'tool', name: 'worker_read_tool', args: { path: 'fixture.txt' } },
      { kind: 'tool', name: 'worker_read_tool', args: { path: 'second.txt' } },
      { kind: 'answer', text: 'The worker saw the profile change before the second read.' },
    ]);
    afterWorkerInvoke = async () => {
      afterWorkerInvoke = undefined;
      await workerBinding.update({ harnessTag: deniedProfile.profile.tag });
    };

    try {
      const response = await adminAgent.resource('aiConversations').sendMessages({
        values: {
          sessionId,
          aiEmployee: leaderUsername,
          model: { llmService: 'mock-root', model: 'strong-model' },
          messages: [{ role: 'user', content: { type: 'text', content: 'Read a file using the worker.' } }],
          stream: false,
        },
      });

      expect(response.status).toBe(200);
      expect(workerInvocations).toEqual([{ path: 'fixture.txt' }]);
      const children = await app.db.getRepository('aiConversations').find({
        filter: { userId: adminId, from: 'sub-agent', aiEmployeeUsername: workerUsername },
      });
      const child = children.find((item) => recordOrEmpty(item.get('options')).hierarchyRootSessionId === sessionId);
      if (!child) throw new Error('The worker conversation was not persisted.');
      const toolRows = await app.db.getRepository('aiToolMessages').find({
        filter: { sessionId: child.get('sessionId'), toolName: 'worker_read_tool' },
        sort: ['id'],
      });
      expect(toolRows).toHaveLength(2);
      expect(toolRows[0].get('status')).toBe('success');
      expect(toolRows[1].get('status')).not.toBe('success');
      const journal = await app.db.getRepository('agentHierarchyInvocations').findOne({
        filter: { rootSessionId: sessionId, employeeUsername: workerUsername },
      });
      expect(journal?.get('status')).toBe('uncertain');
      expect(JSON.stringify(providerInputs.get('strong-model')?.[2] ?? [])).not.toContain(workerEvidence);
    } finally {
      afterWorkerInvoke = undefined;
      await workerBinding.update({ harnessTag: originalTag });
    }
  });
});
