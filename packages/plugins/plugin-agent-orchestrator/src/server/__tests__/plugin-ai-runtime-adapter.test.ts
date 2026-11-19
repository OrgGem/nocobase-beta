/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIEmployee as NativeAIEmployee } from '../../../../../../packages/plugins/@nocobase/plugin-ai/src/server/ai-employees/ai-employee';
import { AIConversationsManager as NativeAIConversationsManager } from '../../../../../../packages/plugins/@nocobase/plugin-ai/src/server/ai-employees/ai-conversations';
import { compileHarness } from '../services/HarnessCompiler';
import { PluginAiRuntimeAdapter } from '../services/PluginAiRuntimeAdapter';

type RuntimeResult = Record<string, unknown>;

const runtime = vi.hoisted(() => ({
  result: null as RuntimeResult | null,
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('@nocobase/plugin-ai/server', () => ({
  AIEmployee: class {
    async invoke(input: Record<string, unknown>) {
      runtime.calls.push(input);
      return runtime.result;
    }
  },
}));

const nativeInterrupt = {
  messageId: 'message-1',
  messages: [{ content: 'Waiting for a decision' }],
  __interrupt__: [
    {
      id: 'interrupt-1',
      value: {
        actionRequests: [
          {
            name: 'skill_hub_report',
            args: { input: { source: 'monthly.csv' } },
            description: JSON.stringify({
              toolCallId: 'call-1',
              toolCallName: 'skill_hub_report',
              sessionId: 'session-1',
              from: 'main-agent',
              username: 'review-agent',
            }),
          },
        ],
        reviewConfigs: [{ actionName: 'skill_hub_report', allowedDecisions: ['approve', 'edit', 'reject'] }],
      },
    },
  ],
};

function createAdapter(
  options: {
    actualConversationManager?: boolean;
    nativeMessage?: Record<string, unknown>;
    nativeToolMessages?: Array<Record<string, unknown>>;
  } = {},
) {
  const employee = {
    skillSettings: { tools: [{ name: 'skill_hub_report', autoCall: true }] },
    get(name: string) {
      return name === 'skillSettings' ? this.skillSettings : undefined;
    },
    set(name: string, value: unknown) {
      if (name === 'skillSettings') this.skillSettings = value as { tools: Array<{ name: string; autoCall: boolean }> };
    },
  };
  const nativeToolMessages = options.nativeToolMessages ?? [];
  const nativeMessage = options.nativeMessage;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const updateToolMessage = vi
    .fn()
    .mockImplementation(async (values: Record<string, unknown>, query: { where: Record<string, unknown> }) => {
      const rows = nativeToolMessages.filter((row) => matches(row, query.where));
      rows.forEach((row) => Object.assign(row, values));
      return [rows.length];
    });
  const messagesModel = {
    findOne: vi.fn(async (query: { where: Record<string, unknown> }) => {
      if (!nativeMessage || !matches(nativeMessage, query.where)) return null;
      return { ...nativeMessage, get: (name: string) => nativeMessage[name] };
    }),
    update: vi.fn(async (values: Record<string, unknown>, query: { where: Record<string, unknown> }) => {
      if (!nativeMessage || !matches(nativeMessage, query.where)) return [0];
      Object.assign(nativeMessage, values);
      return [1];
    }),
  };
  const toolMessagesModel = {
    findOne: vi.fn(
      async (query: { where: Record<string, unknown> }) =>
        nativeToolMessages.find((row) => matches(row, query.where)) ?? null,
    ),
    update: updateToolMessage,
  };
  const db = {
    sequelize: {
      transaction: async <T>(callback: (transaction: { LOCK: { UPDATE: string } }) => Promise<T>) =>
        callback({ LOCK: { UPDATE: 'UPDATE' } }),
    },
    getModel: (name: string) => (name === 'aiMessages' ? messagesModel : toolMessagesModel),
    getRepository: (name: string) => {
      if (name === 'aiToolMessages') {
        return {
          find: async (query: { filter: { messageId: string } }) =>
            nativeToolMessages
              .filter((row) => row.messageId === query.filter.messageId && Number.isInteger(row.interruptActionOrder))
              .sort((left, right) => Number(left.interruptActionOrder) - Number(right.interruptActionOrder)),
        };
      }
      if (name === 'aiMessages') {
        return {
          findOne: async (query: { filter: { messageId: string } }) => {
            if (nativeMessage?.messageId !== query.filter.messageId) return null;
            return { ...nativeMessage, get: (name: string) => nativeMessage[name] };
          },
        };
      }
      return { find: async () => [] };
    },
  };
  const aiConversationsManager = options.actualConversationManager
    ? new NativeAIConversationsManager({ db } as unknown as ConstructorParameters<
        typeof NativeAIConversationsManager
      >[0])
    : { getUserDecisions: vi.fn().mockResolvedValue({ interruptId: 'interrupt-1', decisions: [] }) };
  const plugin = {
    aiEmployeesManager: {
      getEmployee: vi.fn().mockResolvedValue(employee),
      resolveModel: vi.fn().mockResolvedValue({ llmService: 'mock', model: 'mock' }),
    },
    aiConversationsManager,
  };
  const app = {
    pm: { get: vi.fn().mockReturnValue(plugin) },
    aiManager: {
      toolsManager: {
        getTools: vi.fn(async (name: string) => ({
          scope: 'CUSTOM',
          defaultPermission: 'ALLOW',
          definition: { name },
        })),
      },
    },
    db,
    logger: { info: vi.fn() },
    log: {},
  } as unknown as Application;

  return { adapter: new PluginAiRuntimeAdapter(app), employee, plugin, updateToolMessage };
}

function invokeInput() {
  return {
    username: 'review-agent',
    sessionId: 'session-1',
    userId: 7,
    systemMessage: 'Review the requested report.',
    harness: compileHarness([{ source: 'test', settings: { tools: { allow: ['skill_hub_report'] } } }]),
    prompt: 'Build the report.',
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  runtime.result = structuredClone(nativeInterrupt);
  runtime.calls.length = 0;
});

describe('PluginAiRuntimeAdapter native review interrupts', () => {
  it('formats the adapter prompt through the native AI employee message formatter', async () => {
    const { adapter } = createAdapter();

    await adapter.invoke(invokeInput());

    const userMessages = runtime.calls[0]?.userMessages;
    expect(userMessages).toEqual([{ role: 'user', content: { type: 'text', content: 'Build the report.' } }]);
    if (!Array.isArray(userMessages)) throw new Error('The adapter did not send native user messages.');

    type NativeFormatter = (
      this: {
        plugin: { workContextHandler: Record<string, never> };
        ctx: Record<string, never>;
        normalizeMessageAttachments: (messages: unknown[]) => Promise<unknown[]>;
      },
      input: { messages: unknown[]; provider: Record<string, never> },
    ) => Promise<Array<{ content?: unknown }>>;
    const nativeFormatter = Reflect.get(NativeAIEmployee.prototype, 'formatMessages') as NativeFormatter;
    const formattedMessages = await nativeFormatter.call(
      {
        plugin: { workContextHandler: {} },
        ctx: {},
        normalizeMessageAttachments: async (messages) => messages,
      },
      { messages: userMessages, provider: {} },
    );

    expect(formattedMessages.map((message) => message.content)).toEqual(['<user_query>Build the report.</user_query>']);
  });

  it('decodes the native actionRequests envelope returned by plugin-ai', async () => {
    const { adapter } = createAdapter();

    const outcome = await adapter.invoke(invokeInput());

    expect(outcome.interrupted).toEqual([
      {
        toolCallId: 'call-1',
        toolName: 'skill_hub_report',
        args: { input: { source: 'monthly.csv' } },
        interruptId: 'interrupt-1',
      },
    ]);
  });

  it('preserves native decision order for a batch of same-name tool calls', async () => {
    const toolName = 'skill_hub_report';
    const requests = [
      { toolCallId: 'call-a', args: { input: { section: 'summary' } } },
      { toolCallId: 'call-b', args: { input: { section: 'details' } } },
      { toolCallId: 'call-c', args: { input: { section: 'appendix' } } },
    ];
    const actions = requests.map((request) => ({
      name: toolName,
      args: request.args,
      description: JSON.stringify({
        toolCallId: request.toolCallId,
        toolCallName: toolName,
        sessionId: 'session-1',
        from: 'main-agent',
        username: 'review-agent',
      }),
    }));
    runtime.result = {
      messageId: 'message-1',
      messages: [],
      __interrupt__: [
        {
          id: 'interrupt-batch',
          value: {
            actionRequests: actions,
            reviewConfigs: [{ actionName: toolName, allowedDecisions: ['approve', 'edit', 'reject'] }],
          },
        },
      ],
    };
    const nativeMessage = {
      sessionId: 'session-1',
      messageId: 'message-1',
      role: 'review-agent',
      toolCalls: requests.map(({ toolCallId }) => ({ id: toolCallId, name: toolName })),
      metadata: {},
    };
    const nativeToolMessages = requests.map(({ toolCallId }) => ({
      sessionId: 'session-1',
      messageId: 'message-1',
      toolCallId,
      toolName,
      invokeStatus: 'init',
      userDecision: null,
    }));
    const { adapter, updateToolMessage } = createAdapter({
      actualConversationManager: true,
      nativeMessage,
      nativeToolMessages,
    });

    const firstOutcome = await adapter.invoke(invokeInput());

    expect(firstOutcome.interrupted.map((call) => call.toolCallId)).toEqual(['call-a', 'call-b', 'call-c']);
    expect(nativeToolMessages.map((call) => [call.invokeStatus, call.interruptActionOrder])).toEqual([
      ['interrupted', 0],
      ['interrupted', 1],
      ['interrupted', 2],
    ]);
    expect(nativeMessage.metadata).toEqual({ interruptId: 'interrupt-batch' });

    runtime.result = { messageId: 'message-2', messages: [] };
    const decisions = [
      { toolCallId: 'call-c', decision: { type: 'reject' as const, message: 'Skip the appendix.' } },
      {
        toolCallId: 'call-a',
        decision: { type: 'approve' as const },
      },
      {
        toolCallId: 'call-b',
        decision: {
          type: 'edit' as const,
          editedAction: { name: toolName, args: { input: { section: 'details', format: 'brief' } } },
        },
      },
    ];
    await adapter.resume({
      username: 'review-agent',
      sessionId: 'session-1',
      messageId: 'message-1',
      userId: 7,
      systemMessage: 'Review the requested report.',
      harness: compileHarness([{ source: 'test', settings: { tools: { allow: [toolName] } } }]),
      decisions,
      signal: new AbortController().signal,
    });

    expect(updateToolMessage).toHaveBeenCalledTimes(6);
    expect(runtime.calls[1]).not.toHaveProperty('messageId');
    expect(runtime.calls[1]).toMatchObject({
      userDecisions: {
        interruptId: 'interrupt-batch',
        decisions: [
          { type: 'approve' },
          { type: 'edit', editedAction: { name: toolName, args: { input: { section: 'details', format: 'brief' } } } },
          { type: 'reject', message: 'Skip the appendix.' },
        ],
      },
    });
  });

  it('applies persisted decisions and decodes the next native interrupt when resuming', async () => {
    const { adapter, updateToolMessage, plugin } = createAdapter();

    const outcome = await adapter.resume({
      username: 'review-agent',
      sessionId: 'session-1',
      messageId: 'message-1',
      userId: 7,
      systemMessage: 'Review the requested report.',
      harness: compileHarness([{ source: 'test', settings: { tools: { allow: ['skill_hub_report'] } } }]),
      decisions: [{ toolCallId: 'call-before-resume', decision: { type: 'approve' } }],
      signal: new AbortController().signal,
    });

    expect(updateToolMessage).toHaveBeenCalledWith(
      { userDecision: { type: 'approve' }, invokeStatus: 'waiting' },
      {
        where: {
          sessionId: 'session-1',
          messageId: 'message-1',
          toolCallId: 'call-before-resume',
          invokeStatus: 'interrupted',
        },
      },
    );
    expect(plugin.aiConversationsManager.getUserDecisions).toHaveBeenCalledWith('message-1');
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]).not.toHaveProperty('messageId');
    expect(outcome.interrupted).toEqual([
      {
        toolCallId: 'call-1',
        toolName: 'skill_hub_report',
        args: { input: { source: 'monthly.csv' } },
        interruptId: 'interrupt-1',
      },
    ]);
  });

  it('continues to accept legacy direct interrupt records', async () => {
    runtime.result = {
      messageId: 'message-1',
      messages: [],
      __interrupt__: [
        {
          id: 'legacy-interrupt',
          value: { toolCallId: 'legacy-call', name: 'legacy_tool', args: { value: 1 } },
        },
      ],
    };
    const { adapter } = createAdapter();

    const outcome = await adapter.invoke(invokeInput());

    expect(outcome.interrupted).toEqual([
      { toolCallId: 'legacy-call', toolName: 'legacy_tool', args: { value: 1 }, interruptId: 'legacy-interrupt' },
    ]);
  });

  it('fails closed for a malformed native action request', async () => {
    runtime.result = {
      messageId: 'message-1',
      messages: [],
      __interrupt__: [
        {
          id: 'bad-interrupt',
          value: {
            actionRequests: [{ name: 'skill_hub_report', args: {}, description: '{bad json' }],
            reviewConfigs: [],
          },
        },
      ],
    };
    const { adapter } = createAdapter();

    await expect(adapter.invoke(invokeInput())).rejects.toThrow();
  });
});
