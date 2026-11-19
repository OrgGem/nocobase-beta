// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createChatCompletionsFetch,
  createMappingFetch,
  isChatCompletionFailure,
} from '../llm-providers/chat-completions-transport';

const URL = 'https://litellm.example.test/v1/chat/completions';

const sseResponse = (...events: string[]) =>
  new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'litellm-request-42' },
  });

const completionEvent = (finishReason: string | null, delta: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

const createFetch = (options: Parameters<typeof createChatCompletionsFetch>[0] = {}) =>
  createChatCompletionsFetch(options);

function getReader(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Expected a streaming response body');
  return reader;
}

describe('Chat Completions transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([undefined, { content: 'choices.0.delta.content' }])(
    'passes streaming upstream errors to the caller after partial text when mapping is %s',
    async (mapping) => {
      const upstreamError = { message: 'upstream failed', type: 'provider_error', code: 'upstream_unavailable' };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          sseResponse(
            completionEvent(null, { content: 'partial answer' }),
            `event: error\ndata: ${JSON.stringify({ error: upstreamError })}\n\n`,
          ),
        ),
      );
      const logger = { error: vi.fn() };
      const fetch = createFetch({ mapping, logger, sessionId: 'session-safe', model: 'gemini-route' });
      const response = await fetch(URL, { headers: { accept: 'text/event-stream' } });
      const reader = getReader(response);
      const chunks: Uint8Array[] = [];
      let failure: unknown;

      try {
        let next = await reader.read();
        while (!next.done) {
          chunks.push(next.value);
          next = await reader.read();
        }
      } catch (error) {
        failure = error;
      }

      expect(new TextDecoder().decode(Buffer.concat(chunks))).toContain('partial answer');
      expect(isChatCompletionFailure(failure)).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        '[CustomLLM] Chat completion failed',
        expect.objectContaining({
          sessionId: 'session-safe',
          model: 'gemini-route',
          stage: 'stream',
          requestId: 'litellm-request-42',
          upstreamCode: 'upstream_unavailable',
        }),
      );
      const serializedLog = JSON.stringify(logger.error.mock.calls);
      expect(serializedLog).not.toContain('partial answer');
    },
  );

  it('handles an error event before a trailing DONE marker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          'event: error\ndata: {"error":{"message":"provider detail","code":"provider_failed"}}\n\n',
          'data: [DONE]\n\n',
        ),
      ),
    );
    const response = await createFetch()(URL, { headers: { accept: 'text/event-stream' } });
    const reader = getReader(response);

    await expect(reader.read()).rejects.toMatchObject({
      name: 'ChatCompletionFailure',
      code: 'UPSTREAM_STREAM_ERROR',
    });
  });

  it.each([undefined, { content: 'choices.0.delta.content' }])(
    'rejects an unmarked stream end after text when mapping is %s',
    async (mapping) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => sseResponse(completionEvent(null, { content: 'partial' }))),
      );
      const response = await createFetch({ mapping })(URL, { headers: { accept: 'text/event-stream' } });
      const reader = getReader(response);
      const seen: Uint8Array[] = [];
      let failure: unknown;

      try {
        let next = await reader.read();
        while (!next.done) {
          seen.push(next.value);
          next = await reader.read();
        }
      } catch (error) {
        failure = error;
      }

      expect(new TextDecoder().decode(Buffer.concat(seen))).toContain('partial');
      expect(isChatCompletionFailure(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'STREAM_INCOMPLETE' });
    },
  );

  it.each([
    ['length', 'OUTPUT_LIMIT'],
    ['content_filter', 'CONTENT_FILTER'],
  ])('reports finish_reason %s instead of accepting an incomplete answer', async (finishReason, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(completionEvent(finishReason), 'data: [DONE]\n\n')),
    );
    const response = await createFetch()(URL, { headers: { accept: 'text/event-stream' } });
    const reader = getReader(response);
    let failure: unknown;

    try {
      while (!(await reader.read()).done) {
        // Drain the response so stream failures surface.
      }
    } catch (error) {
      failure = error;
    }

    expect(isChatCompletionFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ code });
  });

  it('preserves a valid finish reason and usage emitted after it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          completionEvent('stop', { content: 'complete answer' }),
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ),
      ),
    );
    const response = await createFetch()(URL, { headers: { accept: 'text/event-stream' } });
    const output = await response.text();

    expect(output).toContain('complete answer');
    expect(output).toContain('"finish_reason":"stop"');
    expect(output).toContain('"prompt_tokens":13');
    expect(output).toContain('data: [DONE]');
  });

  it('ends the downstream stream at DONE even when the upstream leaves its socket open', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    );
    const response = await createFetch()(URL, { headers: { accept: 'text/event-stream' } });

    await expect(response.text()).resolves.toContain('data: [DONE]');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('classifies an upstream reader failure as a network error without losing prior text', async () => {
    const logger = { error: vi.fn() };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(completionEvent(null, { content: 'partial response' })));
        setTimeout(() => controller.error(new Error('socket reset secret')), 10);
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    );
    const response = await createFetch({ logger })(URL, { headers: { accept: 'text/event-stream' } });
    const reader = getReader(response);
    const first = await reader.read();
    let failure: unknown;

    try {
      await reader.read();
    } catch (error) {
      failure = error;
    }

    expect(new TextDecoder().decode(first.value)).toContain('partial response');
    expect(failure).toMatchObject({ name: 'ChatCompletionFailure', code: 'NETWORK_ERROR' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('socket reset secret');
  });

  it('does not relabel a user abort as a provider failure', async () => {
    const logger = { error: vi.fn() };
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(completionEvent(null, { content: 'partial response' })));
        controller.signal.addEventListener('abort', () => {
          streamController.error(new DOMException('aborted', 'AbortError'));
        });
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    );
    const response = await createFetch({ logger })(URL, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = getReader(response);
    await reader.read();
    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('cancels a pending upstream read when the client cancels its stream', async () => {
    const upstreamCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(completionEvent(null, { content: 'first chunk' })));
      },
      cancel: upstreamCancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    );
    const response = await createFetch()(URL, { headers: { accept: 'text/event-stream' } });
    const reader = getReader(response);
    await reader.read();
    const pendingRead = reader.read();

    await reader.cancel('client disconnected');
    await expect(pendingRead).resolves.toMatchObject({ done: true });
    expect(upstreamCancel).toHaveBeenCalledOnce();
  });

  it('rejects a malformed SSE event instead of treating it as a completed turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse('data: not-json\n\n', 'data: [DONE]\n\n')),
    );
    const response = await createFetch()(URL, { headers: { accept: 'text/event-stream' } });
    const reader = getReader(response);

    await expect(reader.read()).rejects.toMatchObject({
      name: 'ChatCompletionFailure',
      code: 'MALFORMED_STREAM',
    });
  });

  it('rejects malformed mapping-mode SSE data instead of silently dropping an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse('data: not-json\n\n', 'data: [DONE]\n\n')),
    );
    const response = await createFetch({ mapping: { content: 'choices.0.delta.content' } })(URL, {
      headers: { accept: 'text/event-stream' },
    });
    const reader = getReader(response);

    await expect(reader.read()).rejects.toMatchObject({ name: 'ChatCompletionFailure', code: 'MALFORMED_STREAM' });
  });

  it('classifies Gemini invalid thought signatures without logging upstream response bodies', async () => {
    const logger = { error: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'invalid_argument', message: 'thought signature is invalid secret' } }),
            {
              status: 400,
              headers: { 'content-type': 'application/json', 'x-request-id': 'gemini-invalid-4' },
            },
          ),
      ),
    );
    const response = await createFetch({ logger })(URL, { headers: { accept: 'application/json' } });
    const responseBody = await response.text();

    expect(response.status).toBe(400);
    expect(responseBody).toContain('Reference:');
    expect(responseBody).not.toContain('thought signature is invalid secret');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('thought signature is invalid secret');
    expect(logger.error).toHaveBeenCalledWith(
      '[CustomLLM] Chat completion failed',
      expect.objectContaining({ code: 'GEMINI_SIGNATURE_INVALID', requestId: 'gemini-invalid-4' }),
    );
  });

  it('turns a JSON output-limit response into a safe error with its request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'litellm-json-9' } },
          ),
      ),
    );
    const logger = { error: vi.fn() };
    await expect(createFetch({ logger })(URL, { headers: { accept: 'application/json' } })).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
      message: expect.stringContaining('Reference:'),
    });
    expect(logger.error).toHaveBeenCalledWith(
      '[CustomLLM] Chat completion failed',
      expect.objectContaining({ stage: 'response', requestId: 'litellm-json-9', finishReason: 'length' }),
    );
    expect(isChatCompletionFailure(new Error('network disconnected'))).toBe(false);
  });

  it('preserves ordinary OpenAI compatible responses when mapping content and tool calls', async () => {
    const stream = `data: ${JSON.stringify({
      id: 'chatcmpl-7',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n${completionEvent('tool_calls')}data: [DONE]\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(stream)),
    );
    const fetch = createFetch({ mapping: { content: 'choices.0.delta.content' } });
    const response = await fetch(URL, { headers: { accept: 'text/event-stream' } });
    const output = await response.text();

    expect(output).toContain('"id":"call-1"');
    expect(output).toContain('"name":"lookup"');
    expect(output).toContain('"finish_reason":"tool_calls"');
  });

  it('leaves Responses API traffic untouched by the new Chat Completions transport', async () => {
    const upstream = new Response(JSON.stringify({ output: [{ type: 'message', content: 'response api' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => upstream),
    );
    const fetch = createFetch({ mapping: { content: 'choices.0.delta.content' } });

    await expect(fetch('https://litellm.example.test/v1/responses', { method: 'POST' })).resolves.toBe(upstream);
    expect(await upstream.text()).toContain('response api');
  });

  it('preserves the legacy response-mapping helper on non-Chat-Completions paths', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ message: { response: 'legacy mapped' } })}\n\n`),
        );
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    );
    const fetch = createMappingFetch({ content: 'message.response' });
    if (!fetch) throw new Error('mapping must include a content path');

    const response = await fetch('https://custom.example.test/v1/legacy', { headers: { accept: 'text/event-stream' } });

    await expect(response.text()).resolves.toContain('legacy mapped');
  });

  it('preserves the upstream status, headers, and a sanitized correlation reference for HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'provider secret detail', code: 'provider_unavailable' } }), {
            status: 503,
            headers: { 'content-type': 'application/json', 'x-request-id': 'upstream-error-3' },
          }),
      ),
    );
    const logger = { error: vi.fn() };
    const response = await createFetch({ logger })(URL, { headers: { accept: 'application/json' } });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('upstream-error-3');
    expect(body).toContain('Reference:');
    expect(body).not.toContain('provider secret detail');
    expect(logger.error).toHaveBeenCalledWith(
      '[CustomLLM] Chat completion failed',
      expect.objectContaining({ status: 503, requestId: 'upstream-error-3', upstreamCode: 'provider_unavailable' }),
    );
  });

  it('does not forward credentials or cookies from an upstream HTTP error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'safe-request-11',
              'x-api-key': 'upstream-secret-key',
              authorization: 'Bearer upstream-secret',
              'set-cookie': 'session=upstream-secret',
            },
          }),
      ),
    );

    const response = await createFetch()(URL, { headers: { accept: 'application/json' } });
    const headers = Array.from(response.headers.entries());

    expect(response.status).toBe(401);
    expect(response.headers.get('x-request-id')).toBe('safe-request-11');
    expect(JSON.stringify(headers)).not.toContain('upstream-secret');
  });

  it('bounds HTTP error-body classification and cancels a stalled response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 503, headers: { 'content-type': 'application/json' } })),
    );

    const started = Date.now();
    const response = await createFetch()(URL, { headers: { accept: 'application/json' } });
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(elapsed).toBeLessThan(3000);
    expect(cancel).toHaveBeenCalledOnce();
  }, 4000);
});
