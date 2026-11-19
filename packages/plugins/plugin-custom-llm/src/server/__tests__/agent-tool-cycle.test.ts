// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/server';
import { createAgent, tool } from 'langchain';
import { Command, interrupt } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { HumanMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CustomLLMProvider } from '../llm-providers/custom-llm';

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  provider_specific_fields?: Record<string, unknown>;
  extra_content?: Record<string, unknown>;
};

type ModelResponse = {
  id: string;
  object: 'chat.completion';
  model: string;
  choices: Array<{
    index: number;
    message: Record<string, unknown>;
    finish_reason: 'tool_calls' | 'stop';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

const GEMINI_ID = 'call-gemini__thought__gemini-signature';
const CLAUDE_BLOCKS = [
  { type: 'thinking', thinking: 'plan', signature: 'claude-signature' },
  { type: 'redacted_thinking', data: 'opaque-redacted-data' },
];

const createApp = () =>
  ({
    environment: { renderJsonTemplate: (value: Record<string, unknown>) => value },
    getVersion: () => '2.2.40',
    pm: { get: () => ({}) },
    logger: { error: vi.fn() },
  }) as unknown as Application;

function completion(message: Record<string, unknown>, finishReason: 'tool_calls' | 'stop'): ModelResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
  };
}

function createProvider(model: string, sessionId: string) {
  const claude = model.startsWith('claude-');
  return new CustomLLMProvider({
    app: createApp(),
    serviceOptions: {
      apiKey: 'test-key',
      baseURL: 'https://litellm.example.test/v1',
      apiMode: 'chat-completions',
      ...(claude ? { claudeModelAliases: [model] } : {}),
    },
    modelOptions: { model, llmService: 'shared-litellm', temperature: 0.7, topP: 1 },
    requestContext: { sessionId },
  });
}

describe('AI Employee LangChain tool cycles through Chat Completions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    {
      family: 'GPT Responses-preferred alias',
      model: 'gpt-5.4-pro',
      calls: [{ id: 'call-gpt', type: 'function', function: { name: 'lookup', arguments: '{"query":"one"}' } }],
      thinkingBlocks: undefined,
      signedIds: ['call-gpt'],
      parallelInvocations: 1,
    },
    {
      family: 'Gemini signed tool calls',
      model: 'gemini-route',
      calls: [
        {
          id: GEMINI_ID,
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"one"}' },
          provider_specific_fields: { google: { thought_signature: 'gemini-signature' } },
        },
        { id: 'call-gemini-2', type: 'function', function: { name: 'lookup', arguments: '{"query":"two"}' } },
      ],
      thinkingBlocks: undefined,
      signedIds: [GEMINI_ID, 'call-gemini-2'],
      parallelInvocations: 2,
    },
    {
      family: 'Claude signed and redacted thinking',
      model: 'claude-sonnet-route',
      calls: [{ id: 'call-claude', type: 'function', function: { name: 'lookup', arguments: '{"query":"one"}' } }],
      thinkingBlocks: CLAUDE_BLOCKS,
      signedIds: ['call-claude'],
      parallelInvocations: 1,
    },
  ])(
    'completes $family tool use, preserves signed context, and restores it from the checkpoint',
    async ({ model, calls, thinkingBlocks, signedIds, parallelInvocations }) => {
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: String(input), body });
        const hasToolResult = (body.messages as Array<Record<string, unknown>>).some(
          (message) => message.role === 'tool',
        );
        const response =
          !hasToolResult && requests.length === 1
            ? completion(
                { content: null, tool_calls: calls, ...(thinkingBlocks ? { thinking_blocks: thinkingBlocks } : {}) },
                'tool_calls',
              )
            : completion({ content: `complete-${requests.length}` }, 'stop');
        response.id = `chatcmpl-${requests.length}`;
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': `mock-request-${requests.length}` },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const provider = createProvider(model, 'employee-session');
      const toolExecutions: string[] = [];
      const lookupTool = tool(
        async ({ query }) => {
          toolExecutions.push(query);
          return `result-${query}`;
        },
        { name: 'lookup', description: 'Look up a test value', schema: z.object({ query: z.string() }) },
      );
      const checkpointer = new MemorySaver();
      const agent = createAgent({ model: provider.createModel(), tools: [lookupTool], checkpointer });
      const config = { configurable: { thread_id: 'employee-session' } };

      const firstResult = await agent.invoke({ messages: [new HumanMessage('Look up the values')] }, config);
      expect(
        firstResult.messages.some((message) => message.getType() === 'ai' && message.content === 'complete-2'),
      ).toBe(true);
      expect(toolExecutions.sort()).toEqual(parallelInvocations === 2 ? ['one', 'two'] : ['one']);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toBe('https://litellm.example.test/v1/chat/completions');

      const followUp = await agent.invoke({ messages: [new HumanMessage('Continue from saved history')] }, config);
      expect(followUp.messages.some((message) => message.getType() === 'ai' && message.content === 'complete-3')).toBe(
        true,
      );
      expect(requests).toHaveLength(3);

      const firstToolRound = requests[1]?.body.messages as Array<Record<string, unknown>>;
      const assistantCall = firstToolRound.find((message) => message.role === 'assistant' && message.tool_calls);
      const restoredIds = (assistantCall?.tool_calls as ToolCall[] | undefined)?.map((call) => call.id);
      expect(restoredIds).toEqual(signedIds);
      expect(
        firstToolRound.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
      ).toEqual(signedIds);
      if (thinkingBlocks) expect(assistantCall?.thinking_blocks).toEqual(thinkingBlocks);

      const checkpointHistory = requests[2]?.body.messages as Array<Record<string, unknown>>;
      const restoredCheckpointCall = checkpointHistory.find(
        (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
      );
      expect((restoredCheckpointCall?.tool_calls as ToolCall[] | undefined)?.map((call) => call.id)).toEqual(signedIds);
      expect(requests.every((request) => request.url.endsWith('/chat/completions'))).toBe(true);

      const firstRequest = requests[0]?.body;
      if (model.startsWith('claude-')) {
        expect(firstRequest).not.toHaveProperty('top_p');
        expect(firstRequest).toHaveProperty('temperature', 0.7);
      } else {
        expect(firstRequest).toHaveProperty('top_p', 1);
      }
    },
  );

  it('resumes a pending Gemini tool node with a fresh provider from its checkpoint', async () => {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body });
      const response =
        requests.length === 1
          ? completion(
              {
                content: null,
                tool_calls: [
                  {
                    id: GEMINI_ID,
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"query":"resume"}' },
                    provider_specific_fields: { google: { thought_signature: 'gemini-signature' } },
                  },
                ],
              },
              'tool_calls',
            )
          : completion({ content: 'resumed answer' }, 'stop');
      response.id = `chatcmpl-pending-${requests.length}`;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': `pending-${requests.length}` },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const checkpointer = new MemorySaver();
    const lookupResults: string[] = [];
    const lookupTool = tool(
      async ({ query }) => {
        const decision = interrupt({ action: 'lookup', query });
        lookupResults.push(String(decision));
        return `result-${query}-${String(decision)}`;
      },
      { name: 'lookup', description: 'Look up a value after approval', schema: z.object({ query: z.string() }) },
    );
    const config = { configurable: { thread_id: 'gemini-pending-session' } };
    const firstProvider = createProvider('gemini-route', 'gemini-pending-session');
    const firstAgent = createAgent({ model: firstProvider.createModel(), tools: [lookupTool], checkpointer });

    const pending = await firstAgent.invoke({ messages: [new HumanMessage('Look up the value')] }, config);

    expect(pending.__interrupt__).toBeDefined();
    expect(lookupResults).toEqual([]);
    expect(requests).toHaveLength(1);

    const resumedProvider = createProvider('gemini-route', 'gemini-pending-session');
    const resumedAgent = createAgent({ model: resumedProvider.createModel(), tools: [lookupTool], checkpointer });
    const resumed = await resumedAgent.invoke(new Command({ resume: 'approved' }), config);

    expect(resumed.messages.some((message) => message.getType() === 'ai' && message.content === 'resumed answer')).toBe(
      true,
    );
    expect(lookupResults).toEqual(['approved']);
    expect(requests).toHaveLength(2);
    const resumedMessages = requests[1]?.body.messages as Array<Record<string, unknown>>;
    const assistantCall = resumedMessages.find((message) => message.role === 'assistant' && message.tool_calls);
    expect((assistantCall?.tool_calls as ToolCall[] | undefined)?.map((call) => call.id)).toEqual([GEMINI_ID]);
    expect(resumedMessages.find((message) => message.role === 'tool')).toMatchObject({
      tool_call_id: GEMINI_ID,
      content: 'result-resume-approved',
    });
  });
});
