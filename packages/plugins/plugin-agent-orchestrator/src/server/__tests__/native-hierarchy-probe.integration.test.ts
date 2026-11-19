/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { FakeChatModel } from '@langchain/core/utils/testing';
import type { Model } from '@nocobase/database';
import { createMockServer, type MockServer } from '@nocobase/test';
import { LLMProvider, type LLMProviderOptions } from '@nocobase/plugin-ai/server';
import type { ToolsOptions } from '@nocobase/ai';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const nativeModel = { llmService: 'native-probe-service', model: 'one-native-model' };
const readToolName = 'native_hierarchy_probe_read';
const allowReadToolName = 'native_hierarchy_probe_allow_read';
let nativeProbeModelStates: Map<string, SessionModelState> | undefined;

type ModelRef = typeof nativeModel;
type ModelRequest = { sessionId: string | undefined; llmService: string; model: string };
type ConversationTask =
  | 'ALLOW_READ_ONE_TASK'
  | 'ALLOW_READ_TWO_TASK'
  | 'DIRECT_TASK'
  | 'ROOT_TASK'
  | 'SPECIALIST_TASK'
  | 'WORKER_TASK'
  | 'unknown';

type SessionModelState = {
  sessionId: string;
  calls: number;
  bindings: Set<string>;
  toolResultSnapshots: string[][];
};

type NativeSubAgentConversation = { sessionId?: string; status?: string; toolCallId?: string };
type NativeAIMessageMetadata = { subAgentConversations?: NativeSubAgentConversation[] };

type ProbeAIPlugin = {
  aiManager: {
    getLLMService: (
      options: ModelRef,
      requestContext?: { sessionId?: string },
    ) => Promise<{
      provider: LLMProvider;
      model: string;
      service: { provider: string; get: (name: string) => string | undefined };
    }>;
  };
  aiEmployeesManager: { resolveModel: (employee: Model, model?: ModelRef | null) => Promise<ModelRef> };
};

type ProbeHost = MockServer & {
  aiManager: {
    toolsManager: {
      getTools: (name: string) => Promise<ToolsOptions>;
      registerTools: (options: ToolsOptions | ToolsOptions[]) => void;
    };
  };
};

function messageText(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => {
      if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .join('');
}

function identifyTask(messages: BaseMessage[]): ConversationTask {
  const text = messages.filter(HumanMessage.isInstance).map(messageText).join('\n');
  if (text.includes('ALLOW_READ_TWO_TASK')) return 'ALLOW_READ_TWO_TASK';
  if (text.includes('ALLOW_READ_ONE_TASK')) return 'ALLOW_READ_ONE_TASK';
  if (text.includes('DIRECT_TASK')) return 'DIRECT_TASK';
  if (text.includes('ROOT_TASK')) return 'ROOT_TASK';
  if (text.includes('SPECIALIST_TASK')) return 'SPECIALIST_TASK';
  if (text.includes('WORKER_TASK')) return 'WORKER_TASK';
  return 'unknown';
}

class NativeHierarchyProbeModel extends FakeChatModel {
  constructor(private readonly state: SessionModelState) {
    super({});
  }

  bindTools(tools: unknown[]) {
    for (const tool of tools) {
      if (tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string') {
        this.state.bindings.add(tool.name);
      }
    }
    return this;
  }

  async _generate(messages: BaseMessage[]) {
    const task = identifyTask(messages);
    const toolMessages = messages.filter(ToolMessage.isInstance);
    const hasToolResult = toolMessages.length > 0;
    this.state.calls += 1;
    this.state.toolResultSnapshots.push(
      toolMessages.map((message) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content) ?? '',
      ),
    );

    let message: AIMessage;
    if (task === 'ALLOW_READ_ONE_TASK' || task === 'ALLOW_READ_TWO_TASK') {
      const readCount = task === 'ALLOW_READ_ONE_TASK' ? 1 : 2;
      if (toolMessages.length < readCount) {
        const nextRead = toolMessages.length + 1;
        message = new AIMessage({
          content: '',
          tool_calls: [
            {
              id: `native-allow-read-${this.state.sessionId}-${nextRead}`,
              name: allowReadToolName,
              args: { key: `fixture-${nextRead}` },
              type: 'tool_call',
            },
          ],
        });
      } else {
        message = new AIMessage(`${task} completed`);
      }
    } else if (task === 'ROOT_TASK' && !hasToolResult) {
      message = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'native-root-dispatch',
            name: 'dispatch-sub-agent-task',
            args: { username: NativeHierarchyProbe.specialistUsername, question: 'SPECIALIST_TASK' },
            type: 'tool_call',
          },
        ],
      });
    } else if (task === 'SPECIALIST_TASK' && !hasToolResult) {
      message = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'native-specialist-dispatch',
            name: 'dispatch-sub-agent-task',
            args: { username: NativeHierarchyProbe.workerUsername, question: 'WORKER_TASK' },
            type: 'tool_call',
          },
        ],
      });
    } else if (task === 'WORKER_TASK' && !hasToolResult) {
      message = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'native-worker-ask',
            name: readToolName,
            args: { key: 'fixture-value' },
            type: 'tool_call',
          },
        ],
      });
    } else {
      message = new AIMessage(`${task} completed`);
    }

    return { generations: [{ text: messageText(message), message }] };
  }
}

class NativeHierarchyProbeProvider extends LLMProvider {
  createModel() {
    const sessionId = this.requestContext.sessionId ?? 'missing-session-id';
    if (!nativeProbeModelStates) throw new Error('Native hierarchy model fixture state is unavailable.');
    const state = nativeProbeModelStates.get(sessionId) ?? {
      sessionId,
      calls: 0,
      bindings: new Set<string>(),
      toolResultSnapshots: [],
    };
    nativeProbeModelStates.set(sessionId, state);
    return new NativeHierarchyProbeModel(state);
  }
}

class NativeHierarchyProbe {
  static specialistUsername = '';
  static workerUsername = '';

  app: MockServer;
  rootAgent: ReturnType<MockServer['agent']>;
  rootUserId = 0;
  rootUsername: string;
  rootSessionId: string;
  modelRequests: ModelRequest[] = [];
  modelStates = new Map<string, SessionModelState>();
  readInvocations: Array<{ key: string }> = [];
  allowReadInvocations: Array<{ key: string }> = [];

  private constructor(
    app: MockServer,
    rootAgent: ReturnType<MockServer['agent']>,
    rootUserId: number,
    rootUsername: string,
    rootSessionId: string,
  ) {
    this.app = app;
    this.rootAgent = rootAgent;
    this.rootUserId = rootUserId;
    this.rootUsername = rootUsername;
    this.rootSessionId = rootSessionId;
  }

  static async create() {
    const suffix = `${process.pid}-${Date.now()}`;
    const app = await createMockServer({
      plugins: ['nocobase'],
      name: `native-hierarchy-probe-${suffix}`,
      acl: true,
      skipSupervisor: true,
    });
    const root = await app.db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    if (!root) throw new Error('Mock server did not seed a root user.');
    const rootUsername = `native-probe-root-${suffix}`;
    const specialistUsername = `native-probe-specialist-${suffix}`;
    const workerUsername = `native-probe-worker-${suffix}`;
    NativeHierarchyProbe.specialistUsername = specialistUsername;
    NativeHierarchyProbe.workerUsername = workerUsername;

    const employees = app.db.getRepository('aiEmployees');
    const employeeSettings = (username: string, dispatch: boolean) => ({
      username,
      nickname: username,
      about: 'Deterministic native hierarchy probe fixture.',
      enabled: true,
      builtIn: false,
      category: 'business',
      deprecated: false,
      modelSettings: nativeModel,
      chatSettings: { enableSkills: false, enableTools: true, systemPromptMode: 'none' },
      skillSettings: {
        tools: dispatch ? [{ name: 'dispatch-sub-agent-task', autoCall: true }] : [],
      },
    });
    await employees.create({ values: employeeSettings(rootUsername, true) });
    await employees.create({ values: employeeSettings(specialistUsername, true) });
    await employees.create({ values: employeeSettings(workerUsername, false) });

    const rootSessionId = randomUUID();
    await app.db.getRepository('aiConversations').create({
      values: {
        sessionId: rootSessionId,
        userId: Number(root.id),
        aiEmployeeUsername: rootUsername,
        thread: 1,
        title: 'Native hierarchy probe',
      },
    });

    const probe = new NativeHierarchyProbe(
      app,
      await app.agent().login(root),
      Number(root.id),
      rootUsername,
      rootSessionId,
    );
    nativeProbeModelStates = probe.modelStates;
    const ai = app.pm.get('ai') as unknown as ProbeAIPlugin;
    const toolsManager = (app as ProbeHost).aiManager.toolsManager;
    toolsManager.registerTools({
      scope: 'GENERAL',
      defaultPermission: 'ASK',
      definition: {
        name: readToolName,
        description: 'Read one deterministic fixture value.',
        schema: z.object({ key: z.string() }),
      },
      invoke: async (_ctx, args: { key: string }) => {
        probe.readInvocations.push(args);
        return { key: args.key, value: 'fixture-value' };
      },
    });
    toolsManager.registerTools({
      scope: 'GENERAL',
      defaultPermission: 'ALLOW',
      definition: {
        name: allowReadToolName,
        description: 'Read one deterministic fixture value without approval.',
        schema: z.object({ key: z.string() }),
      },
      invoke: async (_ctx, args: { key: string }) => {
        probe.allowReadInvocations.push(args);
        return { key: args.key, value: `native-sentinel:${args.key}` };
      },
    });

    vi.spyOn(ai.aiEmployeesManager, 'resolveModel').mockResolvedValue(nativeModel);
    vi.spyOn(ai.aiManager, 'getLLMService').mockImplementation(async (options, requestContext) => {
      probe.modelRequests.push({
        sessionId: requestContext?.sessionId,
        llmService: options.llmService,
        model: options.model,
      });
      return {
        provider: new NativeHierarchyProbeProvider({ app, modelOptions: options, requestContext }),
        model: options.model,
        service: {
          provider: 'native-hierarchy-probe',
          get: (name) => (name === 'name' ? options.llmService : undefined),
        },
      };
    });

    return probe;
  }

  async sendRootMessage() {
    return this.sendMessage(this.rootSessionId, 'ROOT_TASK');
  }

  async createRootSession() {
    const sessionId = randomUUID();
    await this.app.db.getRepository('aiConversations').create({
      values: {
        sessionId,
        userId: this.rootUserId,
        aiEmployeeUsername: this.rootUsername,
        thread: 1,
        title: 'Native direct baseline probe',
      },
    });
    return sessionId;
  }

  async sendMessage(sessionId: string, task: string) {
    return this.rootAgent.resource('aiConversations').sendMessages({
      values: {
        sessionId,
        aiEmployee: this.rootUsername,
        model: nativeModel,
        messages: [{ role: 'user', content: { type: 'text', content: task } }],
        stream: false,
      },
    });
  }
}

describe('native AIEmployee hierarchy baseline probe', () => {
  let probe: NativeHierarchyProbe | undefined;

  beforeAll(async () => {
    probe = await NativeHierarchyProbe.create();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await probe?.app.destroy();
  });

  it('dispatches root → specialist → worker on one model and leaves the worker ASK tool unexecuted', async () => {
    if (!probe) throw new Error('Native hierarchy probe fixture was not initialized.');

    const toolsManager = (probe.app as ProbeHost).aiManager.toolsManager;
    const dispatchTool = await toolsManager.getTools('dispatch-sub-agent-task');
    const readTool = await toolsManager.getTools(readToolName);
    expect(readTool).toMatchObject({ scope: 'GENERAL', defaultPermission: 'ASK' });
    const response = await probe.sendRootMessage();

    expect(response.status).toBe(200);
    expect(probe.modelRequests).toHaveLength(3);
    expect(probe.modelRequests.map(({ llmService, model }) => ({ llmService, model }))).toEqual(
      probe.modelRequests.map(() => nativeModel),
    );

    const conversations = await probe.app.db.getRepository('aiConversations').find({
      filter: { userId: probe.rootUserId },
      sort: ['createdAt'],
    });
    const childSessions = conversations
      .filter((conversation) => conversation.get('from') === 'sub-agent')
      .map((conversation) => ({
        sessionId: String(conversation.get('sessionId')),
        username: String(conversation.get('aiEmployeeUsername')),
      }));
    const specialistSession = childSessions.find(
      (session) => session.username === NativeHierarchyProbe.specialistUsername,
    );
    const workerSession = childSessions.find((session) => session.username === NativeHierarchyProbe.workerUsername);

    expect(specialistSession).toBeDefined();
    expect(workerSession).toBeDefined();
    if (!specialistSession || !workerSession) throw new Error('Native dispatch did not create both child sessions.');
    expect(probe.modelRequests.map((request) => request.sessionId)).toEqual(
      expect.arrayContaining([probe.rootSessionId, specialistSession.sessionId, workerSession.sessionId]),
    );
    expect(probe.modelStates.get(probe.rootSessionId)?.calls).toBe(1);
    expect(probe.modelStates.get(specialistSession.sessionId)?.calls).toBe(1);
    expect(probe.modelStates.get(workerSession.sessionId)?.calls).toBe(1);
    expect(probe.modelStates.get(probe.rootSessionId)?.bindings).toContain('dispatch-sub-agent-task');
    expect(probe.modelStates.get(specialistSession.sessionId)?.bindings).toContain('dispatch-sub-agent-task');
    expect(probe.modelStates.get(workerSession.sessionId)?.bindings).toContain(readToolName);
    expect(probe.readInvocations).toEqual([]);

    const workerAsk = await probe.app.db.getRepository('aiToolMessages').findOne({
      filter: { sessionId: workerSession.sessionId, toolName: readToolName },
    });
    const rootDispatch = await probe.app.db.getRepository('aiToolMessages').findOne({
      filter: { sessionId: probe.rootSessionId, toolName: 'dispatch-sub-agent-task' },
    });
    const specialistDispatch = await probe.app.db.getRepository('aiToolMessages').findOne({
      filter: { sessionId: specialistSession.sessionId, toolName: 'dispatch-sub-agent-task' },
    });
    const rootDispatchMessage = rootDispatch
      ? await probe.app.db.getRepository('aiMessages').findOne({
          filter: { sessionId: probe.rootSessionId, messageId: rootDispatch.get('messageId') },
        })
      : null;
    const specialistDispatchMessage = specialistDispatch
      ? await probe.app.db.getRepository('aiMessages').findOne({
          filter: { sessionId: specialistSession.sessionId, messageId: specialistDispatch.get('messageId') },
        })
      : null;
    const rootMetadata = rootDispatchMessage?.get('metadata') as NativeAIMessageMetadata | undefined;
    expect(workerAsk?.get('invokeStatus')).toBe('init');
    expect(workerAsk?.get('auto')).toBe(false);
    expect(workerAsk?.get('interruptAction')).toBeFalsy();
    expect(dispatchTool).toMatchObject({ scope: 'SPECIFIED', defaultPermission: 'ALLOW' });
    expect(rootDispatch?.get('invokeStatus')).toBe('pending');
    expect(rootDispatch?.get('interruptAction')).toBeFalsy();
    expect(rootMetadata?.subAgentConversations).toContainEqual(
      expect.objectContaining({ sessionId: specialistSession.sessionId, status: 'pending' }),
    );
    expect(specialistDispatch?.get('invokeStatus')).toBe('pending');
    expect(specialistDispatch?.get('interruptAction')).toBeFalsy();
    expect(specialistDispatchMessage?.get('metadata')).not.toHaveProperty('subAgentConversations');
  });

  it('answers a direct root request with one model call and no child sessions', async () => {
    if (!probe) throw new Error('Native hierarchy probe fixture was not initialized.');

    const sessionId = await probe.createRootSession();
    const existingChildSessions = await probe.app.db.getRepository('aiConversations').count({
      filter: { userId: probe.rootUserId, from: 'sub-agent' },
    });
    const requestCount = probe.modelRequests.length;
    const response = await probe.sendMessage(sessionId, 'DIRECT_TASK');

    expect(response.status).toBe(200);
    expect(probe.modelRequests).toHaveLength(requestCount + 1);
    expect(probe.modelRequests.at(-1)).toMatchObject({
      sessionId,
      llmService: nativeModel.llmService,
      model: nativeModel.model,
    });
    expect(probe.modelStates.get(sessionId)?.calls).toBe(1);
    expect(probe.modelStates.get(sessionId)?.bindings).toContain('dispatch-sub-agent-task');
    expect(
      await probe.app.db.getRepository('aiConversations').count({
        filter: { userId: probe.rootUserId, from: 'sub-agent' },
      }),
    ).toBe(existingChildSessions);
    expect(await probe.app.db.getRepository('aiToolMessages').count({ filter: { sessionId } })).toBe(0);
  });

  it.each([
    { task: 'ALLOW_READ_ONE_TASK', expectedReads: 1, expectedModelCalls: 2 },
    { task: 'ALLOW_READ_TWO_TASK', expectedReads: 2, expectedModelCalls: 3 },
  ])('runs $expectedReads ALLOW read(s) on the selected root model', async (scenario) => {
    if (!probe) throw new Error('Native hierarchy probe fixture was not initialized.');

    const toolsManager = (probe.app as ProbeHost).aiManager.toolsManager;
    expect(await toolsManager.getTools(allowReadToolName)).toMatchObject({
      scope: 'GENERAL',
      defaultPermission: 'ALLOW',
    });

    const sessionId = await probe.createRootSession();
    const requestCount = probe.modelRequests.length;
    const invocationCount = probe.allowReadInvocations.length;
    const childSessionCount = await probe.app.db.getRepository('aiConversations').count({
      filter: { userId: probe.rootUserId, from: 'sub-agent' },
    });
    const response = await probe.sendMessage(sessionId, scenario.task);

    expect(response.status).toBe(200);
    expect(probe.modelRequests.slice(requestCount)).toEqual([
      { sessionId, llmService: nativeModel.llmService, model: nativeModel.model },
    ]);
    expect(probe.modelStates.get(sessionId)?.calls).toBe(scenario.expectedModelCalls);
    expect(probe.modelStates.get(sessionId)?.bindings).toContain(allowReadToolName);
    expect(probe.allowReadInvocations.slice(invocationCount)).toEqual(
      Array.from({ length: scenario.expectedReads }, (_value, index) => ({ key: `fixture-${index + 1}` })),
    );
    expect(probe.modelStates.get(sessionId)?.toolResultSnapshots.at(-1)).toEqual(
      expect.arrayContaining(
        Array.from({ length: scenario.expectedReads }, (_value, index) =>
          expect.stringContaining(`native-sentinel:fixture-${index + 1}`),
        ),
      ),
    );

    const toolMessages = await probe.app.db.getRepository('aiToolMessages').find({
      filter: { sessionId, toolName: allowReadToolName },
      sort: ['id'],
    });
    expect(toolMessages).toHaveLength(scenario.expectedReads);
    for (const toolMessage of toolMessages) {
      expect(toolMessage.get('status')).toBe('success');
      expect(['confirmed', 'done']).toContain(toolMessage.get('invokeStatus'));
    }
    expect(
      await probe.app.db.getRepository('aiConversations').count({
        filter: { userId: probe.rootUserId, from: 'sub-agent' },
      }),
    ).toBe(childSessionCount);
  });
});
