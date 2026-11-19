// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/server';
import { HumanMessage } from '@langchain/core/messages';
import { createAgent, tool } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CustomLLMProvider } from '../llm-providers/custom-llm';

const URL = 'https://litellm.example.test/v1/chat/completions';

function createApp(logger = { error: vi.fn() }) {
  return {
    environment: { renderJsonTemplate: (value: Record<string, unknown>) => value },
    getVersion: () => '2.2.40',
    pm: { get: () => ({}) },
    logger,
  } as unknown as Application;
}

function createProvider(logger = { error: vi.fn() }, enableToolRetry = true) {
  return new CustomLLMProvider({
    app: createApp(logger),
    serviceOptions: {
      apiKey: 'test-key',
      baseURL: 'https://litellm.example.test/v1',
      apiMode: 'chat-completions',
      requestConfig: JSON.stringify({ retry: { maxRetries: 2, delayMs: 1 } }),
    },
    modelOptions: {
      model: 'gemini-route',
      llmService: 'shared-litellm',
      enableToolRetry,
      maxToolRetries: 3,
    },
    requestContext: { sessionId: 'failure-session' },
  });
}

function invalidToolCallJson() {
  return {
    id: 'chatcmpl-invalid-json',
    object: 'chat.completion',
    model: 'gemini-route',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-invalid', type: 'function', function: { name: 'lookup', arguments: '{invalid-json' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

function invalidToolCallStream() {
  const first = {
    id: 'chatcmpl-invalid-stream',
    object: 'chat.completion.chunk',
    model: 'gemini-route',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-invalid',
              type: 'function',
              function: { name: 'lookup', arguments: '{invalid-json' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const finished = {
    id: 'chatcmpl-invalid-stream',
    object: 'chat.completion.chunk',
    model: 'gemini-route',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  };
  return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(finished)}\n\ndata: [DONE]\n\n`;
}

describe('CustomLLMProvider typed failure regressions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])(
    'fails malformed tool arguments before executing a tool (streaming=%s) and sends one request',
    async (streaming) => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (requestBody.stream === true) {
          return new Response(invalidToolCallStream(), {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'x-request-id': 'invalid-tool-stream' },
          });
        }
        return new Response(JSON.stringify(invalidToolCallJson()), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'invalid-tool-json' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const executions: string[] = [];
      const lookup = tool(
        async ({ query }) => {
          executions.push(query);
          return `result-${query}`;
        },
        { name: 'lookup', description: 'Look up a test value', schema: z.object({ query: z.string() }) },
      );
      const agent = createAgent({ model: createProvider().createModel(), tools: [lookup] });
      const run = async () => {
        if (streaming) {
          const output = await agent.stream(
            { messages: [new HumanMessage('Look up the value')] },
            {
              streamMode: ['updates', 'messages', 'custom'],
            },
          );
          for await (const _event of output) {
            // Drain the agent stream so invalid tool arguments surface from iteration.
          }
          return;
        }
        await agent.invoke({ messages: [new HumanMessage('Look up the value')] });
      };

      await expect(run()).rejects.toMatchObject({
        name: 'ChatCompletionFailure',
        code: 'INVALID_TOOL_CALL',
        message: expect.stringContaining('Reference:'),
      });
      expect(executions).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(URL);
      expect((JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>).stream).toBe(streaming);
      expect(String(requests[0]?.init?.body)).toContain('lookup');
    },
  );

  it.each([false, true])(
    'does not retry a successful HTTP response with finish_reason length (tool retry=%s)',
    async (enableToolRetry) => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-output-limit',
            object: 'chat.completion',
            model: 'gemini-route',
            choices: [{ index: 0, message: { role: 'assistant', content: 'partial answer' }, finish_reason: 'length' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'output-limit-1' } },
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const model = createProvider({ error: vi.fn() }, enableToolRetry).createModel();

      await expect(model.invoke([new HumanMessage('Answer this')])).rejects.toMatchObject({
        name: 'ChatCompletionFailure',
        code: 'OUTPUT_LIMIT',
        message: expect.stringContaining('Reference:'),
      });
      expect(requests).toHaveLength(1);
    },
  );

  it('rejects an SSE response when the SDK request explicitly disabled streaming', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'unexpected-stream-1' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const logger = { error: vi.fn() };

    await expect(
      createProvider(logger)
        .createModel()
        .invoke([new HumanMessage('Return one answer')]),
    ).rejects.toMatchObject({
      name: 'ChatCompletionFailure',
      code: 'MALFORMED_STREAM',
      message: expect.stringContaining('Reference:'),
    });
    expect(requests).toHaveLength(1);
    expect((JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>).stream).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      '[CustomLLM] Chat completion failed',
      expect.objectContaining({ code: 'MALFORMED_STREAM', requestId: 'unexpected-stream-1' }),
    );
  });

  it('classifies a request timeout with a safe reference and structured log', async () => {
    const logger = { error: vi.fn() };
    const timeout = Object.assign(new Error('upstream timeout secret'), { name: 'TimeoutError' });
    const fetchMock = vi.fn(async () => {
      throw timeout;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createProvider(logger)
        .createModel()
        .invoke([new HumanMessage('Wait for the model')]),
    ).rejects.toMatchObject({
      name: 'ChatCompletionFailure',
      code: 'TIMEOUT',
      message: expect.stringContaining('Reference:'),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      '[CustomLLM] Chat completion failed',
      expect.objectContaining({ code: 'TIMEOUT', stage: 'request', sessionId: 'failure-session' }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('upstream timeout secret');
  });

  it('preserves an explicit user abort without logging it as a provider error', async () => {
    const logger = { error: vi.fn() };
    const controller = new AbortController();
    const abort = new DOMException('user cancelled', 'AbortError');
    const fetchMock = vi.fn(async () => {
      controller.abort(abort);
      throw abort;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createProvider(logger)
        .createModel()
        .invoke([new HumanMessage('Cancel this request')], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
