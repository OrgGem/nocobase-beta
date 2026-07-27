import type { Context } from '@nocobase/actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type PluginAiApiServer from '../plugin';
import { handleChatCompletions } from '../routes/chat-completions';
import { resolveModelString } from '../utils/resolve-service';

vi.mock('../utils/resolve-service', () => ({
  resolveModelString: vi.fn(),
}));

interface ModelResult {
  content: string;
  response_metadata?: Record<string, unknown>;
  usage_metadata?: Record<string, unknown>;
}

function createContext(result: ModelResult): Context {
  const model = {
    invoke: vi.fn().mockResolvedValue(result),
    modelKwargs: {},
  };
  class TestProvider {
    createModel() {
      return model;
    }
  }

  return {
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
      getRepository: vi.fn().mockReturnValue({ findOne: vi.fn().mockResolvedValue(null) }),
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
    const ctx = createContext({ content: 'Hello back' });

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
  });

  it('stores provider usage and provider request ID separately from the gateway response ID', async () => {
    const ctx = createContext({
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
});
