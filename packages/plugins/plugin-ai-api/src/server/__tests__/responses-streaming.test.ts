/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import type PluginAiApiServer from '../plugin';
import { handleResponses } from '../routes/responses';
import { resolveModelString } from '../utils/resolve-service';
import { storeResponseRecord } from '../utils/response-store';

vi.mock('../utils/resolve-service', () => ({ resolveModelString: vi.fn(), resolveModelReference: vi.fn() }));
vi.mock('../utils/virtual-models', () => ({ resolveVirtualModel: vi.fn().mockResolvedValue(null) }));
vi.mock('../utils/user-permissions', () => ({ enforceModelAccess: vi.fn().mockResolvedValue(true) }));
vi.mock('../utils/request-cache', () => ({ getAiApiConfig: vi.fn().mockResolvedValue({ enabledLlmServices: [] }) }));
vi.mock('../utils/response-store', () => ({
  loadConversationChain: vi.fn().mockResolvedValue([]),
  storeResponseRecord: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../billing', () => ({
  AiApiQuotaError: class extends Error {
    code = 'quota_exceeded';
  },
  markLlmProviderAttempted: vi.fn(),
  prepareLlmBilling: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/direct-llm-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/direct-llm-context')>();
  return {
    ...original,
    prepareDirectLlmContext: vi.fn().mockImplementation(async (_ctx, options) => ({
      messages: options.messages,
      estimatedInputTokens: 10,
      inputTokenBudget: 1000,
      reservedOutputTokens: 100,
      truncated: false,
    })),
  };
});

class EventTargetMock {
  aborted = false;
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  private listeners = new Map<string, Set<() => void>>();

  once(event: string, listener: () => void) {
    const group = this.listeners.get(event) ?? new Set();
    group.add(listener);
    this.listeners.set(event, group);
  }

  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string) {
    this.listeners.get(event)?.forEach((listener) => listener());
  }
}

function modelRecord() {
  const values: Record<string, unknown> = {
    name: 'test-service',
    enabled: true,
    provider: 'test-provider',
    options: {},
  };
  return { get: (key: string) => values[key] };
}

function createStreamingContext(stream: AsyncIterable<Record<string, unknown>>) {
  const req = new EventTargetMock();
  const res = new EventTargetMock();
  const writes: string[] = [];
  res.write = vi.fn((value: unknown) => {
    writes.push(String(value));
    return true;
  });
  res.end = vi.fn(() => {
    res.writableEnded = true;
  });

  const model = {
    modelKwargs: {},
    stream: vi.fn().mockResolvedValue(stream),
  };
  class TestProvider {
    createModel() {
      return model;
    }
  }
  vi.mocked(resolveModelString).mockResolvedValue({
    service: modelRecord() as never,
    modelId: 'test-model',
  });

  const ctx = {
    app: {
      pm: {
        get: vi.fn().mockReturnValue({
          aiManager: { llmProviders: new Map([['test-provider', { provider: TestProvider }]]) },
        }),
      },
    },
    request: { body: { model: 'test-service/test-model', input: 'Hello', stream: true, store: false } },
    state: { currentUser: { id: 42 } },
    req,
    res,
    log: { error: vi.fn(), warn: vi.fn() },
    set: vi.fn(),
  } as unknown as Context;
  return { ctx, writes };
}

function eventPayloads(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .filter((value) => value.startsWith('data: ') && value !== 'data: [DONE]\n\n')
    .map((value) => JSON.parse(value.slice(6)) as Record<string, unknown>);
}

describe('Responses API streaming handler', () => {
  it('writes OpenAI Responses SSE lifecycle events and terminates with [DONE]', async () => {
    const { ctx, writes } = createStreamingContext({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Hel' };
        yield {
          content: 'lo',
          usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          response_metadata: { finish_reason: 'stop' },
        };
      },
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    const payloads = eventPayloads(writes);
    expect(payloads.map((payload) => payload.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(payloads.map((payload) => payload.sequence_number)).toEqual(payloads.map((_, index) => index));
    expect(payloads.at(-1)).toMatchObject({
      response: { output_text: 'Hello', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    });
    expect(writes.at(-1)).toBe('data: [DONE]\n\n');
    expect(ctx.state.aiApiStreamResult).toMatchObject({ succeeded: true, id: expect.stringMatching(/^resp_/) });
  });

  it('emits error and response.failed when the provider stream throws', async () => {
    const { ctx, writes } = createStreamingContext({
      async *[Symbol.asyncIterator]() {
        yield { content: 'partial' };
        throw new Error('provider stream failed');
      },
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    const payloads = eventPayloads(writes);
    expect(payloads.slice(-2)).toEqual([
      expect.objectContaining({ type: 'error', code: 'server_error', message: 'provider stream failed' }),
      expect.objectContaining({
        type: 'response.failed',
        response: expect.objectContaining({
          status: 'failed',
          error: { code: 'server_error', message: 'provider stream failed' },
        }),
      }),
    ]);
    expect(payloads.at(-1)).toMatchObject({
      response: {
        completed_at: null,
        output: [expect.objectContaining({ status: 'incomplete' })],
      },
    });
    expect(writes).not.toContain('data: [DONE]\n\n');
    expect(ctx.state.aiApiStreamResult).toMatchObject({ succeeded: false, errorCode: 'stream_error' });
  });

  it('still delivers the completed stream when response persistence fails', async () => {
    vi.mocked(storeResponseRecord).mockRejectedValueOnce(new Error('database unavailable'));
    const { ctx, writes } = createStreamingContext({
      async *[Symbol.asyncIterator]() {
        yield {
          content: 'Hello',
          usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          response_metadata: { finish_reason: 'stop' },
        };
      },
    });
    ctx.request.body = { model: 'test-service/test-model', input: 'Hello', stream: true, store: true };

    await handleResponses(ctx, {} as PluginAiApiServer);

    const payloads = eventPayloads(writes);
    // The provider already produced the full result; the terminal stream must not be corrupted
    // by a local persistence failure.
    expect(payloads.at(-1)).toMatchObject({ type: 'response.completed' });
    expect(writes.at(-1)).toBe('data: [DONE]\n\n');
    expect(ctx.state.aiApiStreamResult).toMatchObject({ succeeded: true });
    expect(ctx.log.error).toHaveBeenCalledWith(
      '[ai-api] Failed to persist streamed response record:',
      expect.any(Error),
    );
  });

  it('syncs the tool call id from a later provider delta onto the stored item', async () => {
    // Providers such as OpenAI's chat-completions adapter often omit the tool call id on the
    // first chunk and only send it on a subsequent delta. The stored item must adopt the real
    // id so tool results submitted against it match.
    const { ctx, writes } = createStreamingContext({
      async *[Symbol.asyncIterator]() {
        yield {
          tool_call_chunks: [{ index: 0, name: 'get_weather', args: '{"city":' }],
        };
        yield {
          tool_call_chunks: [{ index: 0, id: 'call_real_123', args: '"Hanoi"}' }],
          usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          response_metadata: { finish_reason: 'tool_calls' },
        };
      },
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    const payloads = eventPayloads(writes);
    const itemDone = payloads.filter((payload) => payload.type === 'response.output_item.done');
    expect(itemDone).toHaveLength(1);
    expect(itemDone[0]).toMatchObject({
      item: {
        type: 'function_call',
        status: 'completed',
        call_id: 'call_real_123',
        name: 'get_weather',
        arguments: '{"city":"Hanoi"}',
      },
    });
    const completed = payloads.find((payload) => payload.type === 'response.completed');
    expect(completed).toMatchObject({
      response: {
        output: [expect.objectContaining({ type: 'function_call', call_id: 'call_real_123' })],
      },
    });
  });

  it('handles client disconnect mid-stream gracefully', async () => {
    const req = new EventTargetMock();
    const res = new EventTargetMock();
    const writes: string[] = [];
    res.write = vi.fn((value: unknown) => {
      writes.push(String(value));
      return true;
    });
    res.end = vi.fn(() => {
      res.writableEnded = true;
    });

    // The provider stream pauses on a gate after the first chunk. The test emits 'close'
    // while the stream is paused, then releases the gate: the next chunk makes the loop
    // observe the aborted signal and throw, which the handler maps to client_disconnected.
    let reachedGate: () => void;
    const gateReached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const providerStream = {
      async *[Symbol.asyncIterator]() {
        yield { content: 'Hel' };
        reachedGate();
        await gate;
        yield { content: 'lo' };
      },
    };

    const model = { modelKwargs: {}, stream: vi.fn().mockResolvedValue(providerStream) };
    class TestProvider {
      createModel() {
        return model;
      }
    }
    vi.mocked(resolveModelString).mockResolvedValue({
      service: modelRecord() as never,
      modelId: 'test-model',
    });

    const ctx = {
      app: {
        pm: {
          get: vi.fn().mockReturnValue({
            aiManager: { llmProviders: new Map([['test-provider', { provider: TestProvider }]]) },
          }),
        },
      },
      request: { body: { model: 'test-service/test-model', input: 'Hello', stream: true, store: false } },
      state: { currentUser: { id: 42 } },
      req,
      res,
      log: { error: vi.fn(), warn: vi.fn() },
      set: vi.fn(),
    } as unknown as Context;

    const handlerPromise = handleResponses(ctx, {} as PluginAiApiServer);
    // Wait until the stream is paused (abort listener is registered by then).
    await gateReached;
    res.emit('close');
    releaseGate();
    await handlerPromise;

    // The handler must have caught the disconnection and set the error code.
    expect(ctx.state.aiApiStreamResult).toMatchObject({ succeeded: false, errorCode: 'client_disconnected' });
    expect(ctx.log.error).toHaveBeenCalled();
  });

  it('delivers the completed stream and persists when store=true succeeds', async () => {
    // The mock accumulates calls across tests in this file (no shared beforeEach), so clear it
    // before asserting the exact call count.
    vi.mocked(storeResponseRecord).mockClear();
    vi.mocked(storeResponseRecord).mockResolvedValue(undefined);
    const { ctx, writes } = createStreamingContext({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Hello' };
        yield {
          content: '',
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          response_metadata: { finish_reason: 'stop' },
        };
      },
    });
    ctx.request.body = { model: 'test-service/test-model', input: 'Hello', stream: true, store: true };

    await handleResponses(ctx, {} as PluginAiApiServer);

    const payloads = eventPayloads(writes);
    // Stream completes normally.
    expect(payloads.at(-1)).toMatchObject({ type: 'response.completed' });
    expect(writes.at(-1)).toBe('data: [DONE]\n\n');
    expect(ctx.state.aiApiStreamResult).toMatchObject({ succeeded: true });
    // storeResponseRecord was called with the fully accumulated response.
    expect(storeResponseRecord).toHaveBeenCalledTimes(1);
    const storeArgs = vi.mocked(storeResponseRecord).mock.calls[0];
    expect(storeArgs[0]).toBe(ctx); // first arg is ctx
    expect(storeArgs[2]).toMatchObject({ model: 'test-service/test-model', input: 'Hello', stream: true, store: true }); // third arg is body
    expect(storeArgs[3]).toBe(42); // fourth arg is userId
    // The response object (second arg) should be a complete ResponseObject.
    const storedResponse = storeArgs[1] as Record<string, unknown>;
    expect(storedResponse.object).toBe('response');
    expect(storedResponse.status).toBe('completed');
    expect(storedResponse.model).toBe('test-service/test-model');
  });
});
