// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/server';
import { HumanMessage } from '@langchain/core/messages';
import { AIEmployee, ChatStreamProtocol } from '../../../../@nocobase/plugin-ai/src/server/ai-employees/ai-employee';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomLLMProvider } from '../llm-providers/custom-llm';

const employeeSession = {
  sessionId: 'employee-stream-session',
  from: 'main-agent',
  username: 'employee-test',
};

function createStreamEvent(delta: Record<string, unknown>, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-employee-error',
    object: 'chat.completion.chunk',
    model: 'gpt-4.1-test',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

describe('AI Employee custom provider error stream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the stream failure and its log correlation reference through AIEmployee', async () => {
    const appLogger = { error: vi.fn() };
    const app = {
      environment: { renderJsonTemplate: (value: Record<string, unknown>) => value },
      getVersion: () => '2.2.40',
      pm: { get: () => ({}) },
      logger: appLogger,
    } as unknown as Application;
    const provider = new CustomLLMProvider({
      app,
      serviceOptions: {
        apiKey: 'test-key',
        baseURL: 'https://litellm.example.test/v1',
        apiMode: 'chat-completions',
      },
      modelOptions: { model: 'gpt-4.1-test', llmService: 'shared-litellm' },
      requestContext: { sessionId: employeeSession.sessionId },
    });
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(createStreamEvent({ role: 'assistant', content: 'partial answer' })),
        );
        controller.enqueue(
          new TextEncoder().encode(
            `event: error\ndata: ${JSON.stringify({
              error: { code: 'upstream_unavailable', message: 'provider secret detail' },
            })}\n\n`,
          ),
        );
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(responseBody, {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'x-request-id': 'employee-request-7' },
          }),
      ),
    );

    const responseWrites: string[] = [];
    const ctx = {
      log: { error: vi.fn() },
      logger: { error: vi.fn() },
      status: 0,
      set: vi.fn(),
      res: {
        headersSent: false,
        write: vi.fn((chunk: string) => responseWrites.push(chunk)),
        end: vi.fn(),
      },
    };
    const fakeEmployee = {
      sessionId: employeeSession.sessionId,
      from: employeeSession.from,
      employee: { username: employeeSession.username },
      ctx,
      protocol: new ChatStreamProtocol(ctx.res as never),
      aiConversationsRepo: { update: vi.fn() },
      streamCached: { clear: vi.fn() },
      saveKnowledgeBaseReferences: vi.fn(),
      sendErrorResponse: AIEmployee.prototype.sendErrorResponse,
      sendSpecificError: AIEmployee.prototype.sendSpecificError,
    };
    const currentConversation = { ...employeeSession };
    const modelStream = await provider.createModel().stream([new HumanMessage('answer this')]);
    async function* employeeStream() {
      for await (const chunk of modelStream) {
        yield ['messages', [chunk, { currentConversation }]] as const;
      }
    }

    await AIEmployee.prototype.processChatStream.call(fakeEmployee, employeeStream(), {
      signal: new AbortController().signal,
      providerName: 'custom-llm',
      llmService: 'shared-litellm',
      model: 'gpt-4.1-test',
      provider,
      responseMetadata: new Map(),
    });

    const protocolEvents = responseWrites.flatMap((chunk) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as { type: string; body?: string }),
    );
    const failureEvent = protocolEvents.find((event) => event.type === 'error');
    const backendFailure = appLogger.error.mock.calls.find(
      ([message]) => message === '[CustomLLM] Chat completion failed',
    );
    const failureMetadata = backendFailure?.[1] as { correlationId?: string; requestId?: string; code?: string };
    const failureLogMessage = ctx.log.error.mock.calls[0]?.[0];

    expect(protocolEvents.some((event) => event.type === 'content' && event.body === 'partial answer')).toBe(true);
    expect(failureEvent?.body).toContain(`Reference: ${failureMetadata.correlationId}`);
    expect(failureMetadata).toMatchObject({ code: 'UPSTREAM_STREAM_ERROR', requestId: 'employee-request-7' });
    expect(failureLogMessage).toMatchObject({ name: 'ChatCompletionFailure', code: 'UPSTREAM_STREAM_ERROR' });
    expect(JSON.stringify(backendFailure)).not.toContain('provider secret detail');
    expect(protocolEvents.some((event) => event.type === 'stream_end')).toBe(false);
    expect(ctx.res.end).toHaveBeenCalled();
  });
});
