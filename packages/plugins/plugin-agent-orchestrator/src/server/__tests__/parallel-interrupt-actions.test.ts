// SPDX-License-Identifier: Apache-2.0

import { AIEmployee } from '@nocobase/plugin-ai/server';
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createAgent, humanInTheLoopMiddleware } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  installParallelInterruptActionsPatch,
  toInterruptActionsFixed,
  type InterruptAction,
  type InterruptPayload,
} from '../services/ParallelInterruptActionsPatch';

type PrivateAIEmployeeProto = {
  toInterruptActions: (interrupt?: InterruptPayload) => Map<string, InterruptAction>;
  handleInterruptedToolCalls: (
    interrupt: { id?: string; value?: InterruptPayload } | undefined,
    getMessageId: (sessionId: string) => string | undefined,
    onInterrupted?: (params: {
      messageId: string;
      interruptId: string;
      interruptAction: InterruptAction;
      toolCall: { id: string; name: string };
      currentConversation: { sessionId: string; from: string; username: string };
    }) => Promise<void> | void,
  ) => Promise<void>;
};

function makeDescription(params: {
  toolCallId: string;
  toolCallName: string;
  sessionId?: string;
  from?: string;
  username?: string;
}): string {
  return JSON.stringify({
    toolCallId: params.toolCallId,
    toolCallName: params.toolCallName,
    sessionId: params.sessionId ?? 'session-1',
    from: params.from ?? 'main-agent',
    username: params.username ?? 'dex',
  });
}

class ParallelSameToolMockChatModel extends BaseChatModel {
  private callCount = 0;

  constructor() {
    super({});
  }

  _llmType(): string {
    return 'parallel-same-tool-mock';
  }

  bindTools() {
    return this;
  }

  async _generate(_messages: BaseMessage[], _options: BaseChatModelCallOptions): Promise<ChatResult> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        generations: [
          {
            text: '',
            message: new AIMessage({
              content: '',
              tool_calls: [
                {
                  id: 'tooluse_first_call',
                  name: 'mcp-rpa-portainer-docker_proxy',
                  args: { container: 'web-1' },
                },
                {
                  id: 'tooluse_second_call',
                  name: 'mcp-rpa-portainer-docker_proxy',
                  args: { container: 'api-2' },
                },
              ],
            }),
          },
        ],
      };
    }
    return {
      generations: [
        {
          text: 'Both containers inspected.',
          message: new AIMessage({ content: 'Both containers inspected.' }),
        },
      ],
    };
  }
}

describe('ParallelInterruptActionsPatch', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('preserves all parallel calls to the same tool name in exact actionRequests order', () => {
    const toolName = 'mcp-rpa-portainer-docker_proxy';
    const payload: InterruptPayload = {
      actionRequests: [
        {
          name: toolName,
          args: { container: 'c1' },
          description: makeDescription({ toolCallId: 'tooluse_1', toolCallName: toolName }),
        },
        {
          name: toolName,
          args: { container: 'c2' },
          description: makeDescription({ toolCallId: 'tooluse_2', toolCallName: toolName }),
        },
        {
          name: toolName,
          args: { container: 'c3' },
          description: makeDescription({ toolCallId: 'tooluse_3', toolCallName: toolName }),
        },
      ],
      reviewConfigs: [
        { actionName: toolName, allowedDecisions: ['approve', 'reject'] },
        { actionName: toolName, allowedDecisions: ['approve', 'reject'] },
        { actionName: toolName, allowedDecisions: ['approve', 'reject'] },
      ],
    };

    const result = toInterruptActionsFixed(payload);
    expect(result.size).toBe(3);
    expect([...result.keys()]).toEqual(['tooluse_1', 'tooluse_2', 'tooluse_3']);
    expect([...result.values()].map((entry) => ({ order: entry.order, id: entry.toolCall?.id }))).toEqual([
      { order: 0, id: 'tooluse_1' },
      { order: 1, id: 'tooluse_2' },
      { order: 2, id: 'tooluse_3' },
    ]);
    for (const entry of result.values()) {
      expect(entry.allowedDecisions).toEqual(['approve', 'reject']);
      expect(entry.currentConversation).toEqual({
        sessionId: 'session-1',
        from: 'main-agent',
        username: 'dex',
      });
    }
  });

  it('preserves mixed parallel calls and per-action allowedDecisions', () => {
    const payload: InterruptPayload = {
      actionRequests: [
        {
          name: 'tool_a',
          description: makeDescription({ toolCallId: 'call_a1', toolCallName: 'tool_a' }),
        },
        {
          name: 'tool_b',
          description: makeDescription({ toolCallId: 'call_b1', toolCallName: 'tool_b' }),
        },
        {
          name: 'tool_a',
          description: makeDescription({ toolCallId: 'call_a2', toolCallName: 'tool_a' }),
        },
      ],
      reviewConfigs: [
        { actionName: 'tool_a', allowedDecisions: ['approve', 'reject'] },
        { actionName: 'tool_b', allowedDecisions: ['approve', 'edit', 'reject'] },
      ],
    };

    const result = toInterruptActionsFixed(payload);
    expect(result.size).toBe(3);
    expect(result.get('call_a1')?.order).toBe(0);
    expect(result.get('call_a1')?.allowedDecisions).toEqual(['approve', 'reject']);
    expect(result.get('call_b1')?.order).toBe(1);
    expect(result.get('call_b1')?.allowedDecisions).toEqual(['approve', 'edit', 'reject']);
    expect(result.get('call_a2')?.order).toBe(2);
    expect(result.get('call_a2')?.allowedDecisions).toEqual(['approve', 'reject']);
  });

  it('handles malformed or missing descriptions safely without throwing', () => {
    const payload: InterruptPayload = {
      actionRequests: [{ name: 'broken_tool', description: '{not-valid-json' }, { name: 'empty_tool' }],
      reviewConfigs: [{ actionName: 'broken_tool', allowedDecisions: ['approve', 'reject'] }],
    };

    const result = toInterruptActionsFixed(payload);
    expect(result.size).toBe(2);
    const values = [...result.values()];
    expect(values[0].order).toBe(0);
    expect(values[0].toolCall).toBeUndefined();
    expect(values[0].currentConversation).toBeUndefined();
    expect(values[1].order).toBe(1);
    expect(values[1].toolCall).toBeUndefined();
  });

  it('returns an empty map for undefined or empty payloads', () => {
    expect(toInterruptActionsFixed(undefined).size).toBe(0);
    expect(toInterruptActionsFixed({ actionRequests: [], reviewConfigs: [] }).size).toBe(0);
  });

  it('patches AIEmployee.prototype with ref-counted install/uninstall and restores upstream method cleanly', () => {
    const proto = AIEmployee.prototype as unknown as PrivateAIEmployeeProto;
    const originalMethod = proto.toInterruptActions;

    const sameToolPayload: InterruptPayload = {
      actionRequests: [
        {
          name: 'mcp-rpa-portainer-docker_proxy',
          description: makeDescription({ toolCallId: 'tooluse_1', toolCallName: 'mcp-rpa-portainer-docker_proxy' }),
        },
        {
          name: 'mcp-rpa-portainer-docker_proxy',
          description: makeDescription({ toolCallId: 'tooluse_2', toolCallName: 'mcp-rpa-portainer-docker_proxy' }),
        },
      ],
      reviewConfigs: [{ actionName: 'mcp-rpa-portainer-docker_proxy', allowedDecisions: ['approve', 'reject'] }],
    };

    // Baseline check: upstream collapses duplicate tool names into a single entry.
    expect(originalMethod.call({}, sameToolPayload).size).toBe(1);

    const disposeA = installParallelInterruptActionsPatch();
    cleanups.push(disposeA);
    const disposeB = installParallelInterruptActionsPatch();
    cleanups.push(disposeB);

    expect(proto.toInterruptActions).not.toBe(originalMethod);
    expect(proto.toInterruptActions.call({}, sameToolPayload).size).toBe(2);

    // First dispose keeps patch active while a second owner remains; double-disposing owner A is a no-op.
    disposeA();
    disposeA();
    expect(proto.toInterruptActions).not.toBe(originalMethod);
    expect(proto.toInterruptActions.call({}, sameToolPayload).size).toBe(2);

    // Last dispose restores the original upstream method.
    disposeB();
    expect(proto.toInterruptActions).toBe(originalMethod);
  });

  it('marks every parallel same-tool call interrupted in handleInterruptedToolCalls and resumes both calls via LangChain HITL', async () => {
    const dispose = installParallelInterruptActionsPatch();
    cleanups.push(dispose);

    const executedContainers: string[] = [];
    const dockerProxyTool = tool(
      async ({ container }) => {
        executedContainers.push(container);
        return `inspected:${container}`;
      },
      {
        name: 'mcp-rpa-portainer-docker_proxy',
        description: 'Inspect a docker container',
        schema: z.object({ container: z.string() }),
      },
    );

    const sessionId = 'session-parallel-hitl';
    const agent = createAgent({
      model: new ParallelSameToolMockChatModel(),
      tools: [dockerProxyTool],
      checkpointer: new MemorySaver(),
      middleware: [
        humanInTheLoopMiddleware({
          interruptOn: {
            'mcp-rpa-portainer-docker_proxy': {
              allowedDecisions: ['approve', 'reject'],
              description: (toolCall) =>
                makeDescription({
                  toolCallId: toolCall.id ?? '',
                  toolCallName: toolCall.name,
                  sessionId,
                }),
            },
          },
        }),
      ],
    });

    const config = { configurable: { thread_id: sessionId } };
    const firstResult = (await agent.invoke(
      { messages: [{ role: 'user', content: 'Inspect web-1 and api-2 in parallel.' }] },
      config,
    )) as { __interrupt__?: Array<{ id?: string; value?: InterruptPayload }> };

    const interrupts = firstResult.__interrupt__ ?? [];
    expect(interrupts).toHaveLength(1);
    const interrupt = interrupts[0];
    expect(interrupt.id).toBeTruthy();

    const updateToolCallInterrupted = vi.fn().mockResolvedValue(undefined);
    const onInterrupted = vi.fn().mockResolvedValue(undefined);
    const fakeEmployeeInstance = {
      toInterruptActions: (AIEmployee.prototype as unknown as PrivateAIEmployeeProto).toInterruptActions,
      updateToolCallInterrupted,
      logger: { warn: vi.fn() },
    };

    await (AIEmployee.prototype as unknown as PrivateAIEmployeeProto).handleInterruptedToolCalls.call(
      fakeEmployeeInstance,
      interrupt,
      () => 'msg-148557048269798400',
      onInterrupted,
    );

    expect(updateToolCallInterrupted).toHaveBeenCalledTimes(2);
    expect(updateToolCallInterrupted.mock.calls.map((call) => ({ id: call[2], order: call[4].order }))).toEqual([
      { id: 'tooluse_first_call', order: 0 },
      { id: 'tooluse_second_call', order: 1 },
    ]);
    expect(onInterrupted).toHaveBeenCalledTimes(2);
    expect(onInterrupted.mock.calls.map((call) => call[0].toolCall.id)).toEqual([
      'tooluse_first_call',
      'tooluse_second_call',
    ]);

    // Simulate getUserDecisions() ordering by interruptActionOrder ASC and resuming the graph.
    const interruptId = String(interrupt.id);
    const resumed = (await agent.invoke(
      new Command({
        resume: {
          [interruptId]: {
            decisions: [{ type: 'approve' }, { type: 'approve' }],
          },
        },
      }),
      config,
    )) as { messages?: BaseMessage[] };

    expect(executedContainers).toEqual(['web-1', 'api-2']);
    const lastMessage = resumed.messages?.[resumed.messages.length - 1];
    expect(lastMessage?.content).toBe('Both containers inspected.');
  });
});
