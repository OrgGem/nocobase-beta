import type { Context } from '@nocobase/actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type PluginAiApiServer from '../plugin';
import { handleChatCompletions } from '../routes/chat-completions';
import { handleCompletions } from '../routes/completions';
import { resolveModelString } from '../utils/resolve-service';

vi.mock('../utils/resolve-service', () => ({
  resolveModelString: vi.fn(),
}));

interface ModelResult {
  content: string;
  response_metadata?: Record<string, unknown>;
  usage_metadata?: Record<string, unknown>;
}

function createContext(result: ModelResult) {
  const model = {
    invoke: vi.fn().mockResolvedValue(result),
    modelKwargs: {},
  };
  let providerCreateCount = 0;
  class TestProvider {
    createModel() {
      providerCreateCount += 1;
      return model;
    }
  }

  const ctx = {
    app: {
      pm: {
        get: vi.fn().mockReturnValue({
          aiManager: {
            llmProviders: new Map([['test-provider', { provider: TestProvider }]]),
          },
        }),
      },
    },
    db: {
      getRepository: vi.fn((name: string) => {
        if (name === 'aiApiModelMetadata') {
          return {
            findOne: vi.fn().mockResolvedValue({
              get: (key: string) => (key === 'contextWindow' ? 128_000 : key === 'maxCompletionTokens' ? 16_384 : true),
            }),
          };
        }
        return { findOne: vi.fn().mockResolvedValue(null) };
      }),
    },
    log: { error: vi.fn() },
    request: {
      body: {
        model: 'test-service/test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    },
    state: {},
    set: vi.fn(),
  } as unknown as Context;

  return { ctx, model, getProviderCreateCount: () => providerCreateCount };
}

class ListenerTarget {
  private listeners = new Map<string, Set<() => void>>();
  aborted = false;
  writableEnded = false;

  once(event: string, listener: () => void) {
    const wrapped = () => {
      this.off(event, wrapped);
      listener();
    };
    const group = this.listeners.get(event) ?? new Set();
    group.add(wrapped);
    this.listeners.set(event, group);
  }

  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

function createStreamingContext(
  result: ModelResult,
  streamOptions?: Record<string, unknown>,
  requestBody?: Record<string, unknown>,
) {
  const req = new ListenerTarget();
  const res = new ListenerTarget();
  const writes: string[] = [];

  res.write = vi.fn((data: unknown) => {
    writes.push(String(data));
    return true;
  });
  res.end = vi.fn(() => {
    res.writableEnded = true;
  });

  const contentChunks = (typeof result.content === 'string' ? [result.content] : []).filter(Boolean);
  const chunks = [
    ...contentChunks.map((content) => ({ content })),
    { content: '', usage_metadata: result.usage_metadata, response_metadata: result.response_metadata },
  ];

  const model = {
    invoke: vi.fn().mockResolvedValue({
      content: result.content,
      usage_metadata: result.usage_metadata,
    }),
    stream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async return() {
            index = chunks.length;
            return { done: true, value: undefined };
          },
        };
      },
    }),
    modelKwargs: {},
  };

  class TestProvider {
    createModel() {
      return model;
    }
  }

  const ctx = {
    app: {
      pm: {
        get: vi.fn().mockReturnValue({
          aiManager: {
            llmProviders: new Map([['test-provider', { provider: TestProvider }]]),
          },
        }),
      },
    },
    db: {
      getRepository: vi.fn((name: string) => {
        if (name === 'aiApiModelMetadata') {
          return {
            findOne: vi.fn().mockResolvedValue({
              get: (key: string) => (key === 'contextWindow' ? 128_000 : key === 'maxCompletionTokens' ? 16_384 : true),
            }),
          };
        }
        return { findOne: vi.fn().mockResolvedValue(null) };
      }),
    },
    log: { error: vi.fn() },
    req,
    res,
    request: {
      body: {
        model: 'test-service/test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        stream_options: streamOptions,
        ...requestBody,
      },
    },
    state: {} as Record<string, unknown>,
    set: vi.fn(),
  } as unknown as Context;

  return { ctx, model, writes };
}

describe('AI API chat usage collection', () => {
  beforeEach(() => {
    vi.mocked(resolveModelString).mockResolvedValue({
      service: {
        enabled: true,
        name: 'test-service',
        options: {},
        provider: 'test-provider',
      },
      modelId: 'test-model',
    });
  });

  it('keeps the public zero fallback but marks missing provider usage as unavailable internally', async () => {
    const { ctx } = createContext({ content: 'Hello back' });

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(200);
    expect((ctx.body as { usage: object }).usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
    expect(ctx.state.aiApiUsageResult).toMatchObject({
      source: 'unavailable',
      gatewayResponseId: expect.stringMatching(/^chatcmpl-/),
    });
    expect(ctx.state.aiApiLlmBilling).toMatchObject({
      resolution: { service: 'test-service', provider: 'test-provider', model: 'test-model' },
      providerAttempted: true,
    });
  });

  it('stores provider usage and provider request ID separately from the gateway response ID', async () => {
    const { ctx } = createContext({
      content: 'Hello back',
      response_metadata: { request_id: 'provider-request-1' },
      usage_metadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    });

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    expect((ctx.body as { usage: object }).usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 3,
      total_tokens: 11,
    });
    expect(ctx.state.aiApiUsageResult).toMatchObject({
      source: 'provider',
      providerRequestId: 'provider-request-1',
      gatewayResponseId: expect.stringMatching(/^chatcmpl-/),
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    });
  });

  it('emits a usage-only chunk immediately before [DONE] for streaming chat completions', async () => {
    const { ctx, writes } = createStreamingContext(
      {
        content: 'Hi',
        response_metadata: { request_id: 'provider-request-stream-1' },
        usage_metadata: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
      },
      { include_usage: true },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    const dataLines = writes.filter((line) => line.startsWith('data: '));
    const doneFrame = dataLines.find((line) => line.includes('[DONE]'));
    expect(doneFrame).toBeDefined();
    const frames = dataLines.filter((line) => !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6)));
    const doneIndex = frames.length;

    const finishChunk = frames[doneIndex - 2];
    const usageChunk = frames[doneIndex - 1];

    expect(finishChunk.choices[0].finish_reason).toBe('stop');
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
    expect(usageChunk).toHaveProperty('usage.prompt_tokens', 5);
    expect(ctx.state.aiApiUsageResult).toMatchObject({
      source: 'provider',
      providerRequestId: 'provider-request-stream-1',
    });
  });

  it('always emits chat usage and forces provider collection when include_usage is false', async () => {
    const { ctx, model, writes } = createStreamingContext(
      {
        content: 'Hi',
        usage_metadata: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
      },
      { include_usage: false, include_obfuscation: false },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    const frames = writes
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)));
    const usageChunk = frames[frames.length - 1];

    expect(frames.slice(0, -1).every((frame) => frame.usage === null)).toBe(true);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
    expect(model.stream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream_options: { include_usage: true, include_obfuscation: false },
      }),
    );
  });

  it('always emits legacy completion usage and forwards all stream options', async () => {
    const { ctx, model, writes } = createStreamingContext(
      {
        content: 'Hi',
        usage_metadata: { input_tokens: 2, output_tokens: 5, total_tokens: 7 },
      },
      { include_usage: false, include_obfuscation: false },
      { prompt: 'Hello' },
    );

    await handleCompletions(ctx, {} as PluginAiApiServer);

    const frames = writes
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)));
    const usageChunk = frames[frames.length - 1];

    expect(frames.slice(0, -1).every((frame) => frame.usage === null)).toBe(true);
    expect(usageChunk.object).toBe('text_completion');
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 });
    expect(model.stream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream_options: { include_usage: true, include_obfuscation: false },
      }),
    );
  });

  it('rejects context overflow before creating a provider or reserving quota', async () => {
    const { ctx, getProviderCreateCount } = createContext({ content: 'unused' });
    (ctx.request.body as Record<string, unknown>).messages = [{ role: 'user', content: 'x'.repeat(600_000) }];

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({ error: { code: 'context_length_exceeded' } });
    expect(ctx.state.aiApiLlmBilling).toBeUndefined();
    expect(getProviderCreateCount()).toBe(0);
  });

  it('rejects oversized legacy prompts before creating a provider or reserving quota', async () => {
    const { ctx, model, getProviderCreateCount } = createContext({ content: 'unused' });
    (ctx.request.body as Record<string, unknown>).prompt = 'x'.repeat(600_000);

    await handleCompletions(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({ error: { code: 'context_length_exceeded' } });
    expect(ctx.state.aiApiLlmBilling).toBeUndefined();
    expect(getProviderCreateCount()).toBe(0);
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('does not emit a usage-only chunk when the provider omits usage metadata', async () => {
    const { ctx, writes } = createStreamingContext({ content: 'Silent' }, { include_usage: true });

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    const dataLines = writes.filter((line) => line.startsWith('data: '));
    const doneFrame = dataLines.find((line) => line.includes('[DONE]'));
    expect(doneFrame).toBeDefined();
    const frames = dataLines.filter((line) => !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6)));
    const doneIndex = frames.length;

    const precedingChunk = frames[doneIndex - 1];
    expect(precedingChunk.choices[0].finish_reason).toBe('stop');
    expect(precedingChunk.usage).toBeNull();
    expect(ctx.state.aiApiUsageResult).toMatchObject({ source: 'unavailable' });
  });
});
