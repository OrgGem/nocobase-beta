/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type PluginAiApiServer from '../plugin';
import {
  handleDeleteResponse,
  handleGetResponse,
  handleResponses,
  RESPONSES_CAPABLE_PROVIDERS,
} from '../routes/responses';
import { resolveModelString } from '../utils/resolve-service';
import {
  deleteResponseRecord,
  getResponseRecord,
  loadConversationChain,
  storeResponseRecord,
} from '../utils/response-store';
import { prepareDirectLlmContext } from '../utils/direct-llm-context';

vi.mock('../utils/resolve-service', () => ({ resolveModelString: vi.fn(), resolveModelReference: vi.fn() }));
vi.mock('../utils/virtual-models', () => ({ resolveVirtualModel: vi.fn().mockResolvedValue(null) }));
vi.mock('../utils/user-permissions', () => ({ enforceModelAccess: vi.fn().mockResolvedValue(true) }));
vi.mock('../utils/request-cache', () => ({ getAiApiConfig: vi.fn().mockResolvedValue({ enabledLlmServices: [] }) }));
vi.mock('../utils/response-store', () => ({
  deleteResponseRecord: vi.fn().mockResolvedValue(true),
  getResponseRecord: vi.fn(),
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
vi.mock('../usage', async (importOriginal) => {
  const original = await importOriginal<typeof import('../usage')>();
  return {
    ...original,
    extractProviderRequestId: vi.fn().mockReturnValue(undefined),
    setAiApiUsageResult: vi.fn().mockReturnValue({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_cache_tokens: 2,
    }),
  };
});

function serviceModel(provider = 'test-provider') {
  const values: Record<string, unknown> = {
    name: 'test-service',
    title: 'Test Service',
    enabled: true,
    provider,
    options: {},
  };
  return { get: (key: string) => values[key] };
}

function createContext(requestBody: Record<string, unknown>, providerKey = 'test-provider') {
  const model = {
    invoke: vi.fn().mockResolvedValue({
      content: 'Hello from Responses',
      usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
    modelKwargs: {},
    bindTools: vi.fn(function (this: unknown) {
      return this;
    }),
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
          aiManager: { llmProviders: new Map([[providerKey, { provider: TestProvider }]]) },
        }),
      },
    },
    request: { body: requestBody },
    state: { currentUser: { id: 42 } } as Record<string, unknown>,
    log: { error: vi.fn(), warn: vi.fn() },
    set: vi.fn(),
    status: 0,
    body: undefined,
    res: { headersSent: false },
  } as unknown as Context;
  return { ctx, model };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveModelString).mockResolvedValue({
    service: serviceModel() as never,
    modelId: 'test-model',
  });
  vi.mocked(loadConversationChain).mockResolvedValue([]);
});

describe('handleResponses', () => {
  it('returns an OpenAI Responses object and stores it by default', async () => {
    const { ctx } = createContext({ model: 'test-service/test-model', input: 'Hello' });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(200);
    expect(ctx.body).toMatchObject({
      object: 'response',
      status: 'completed',
      output_text: 'Hello from Responses',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello from Responses', annotations: [] }],
        },
      ],
    });
    expect(storeResponseRecord).toHaveBeenCalledWith(ctx, ctx.body, expect.any(Object), 42);
  });

  it('does not store when store=false', async () => {
    const { ctx } = createContext({ model: 'test-service/test-model', input: 'Hello', store: false });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(200);
    expect(storeResponseRecord).not.toHaveBeenCalled();
  });

  it('forwards store=false to the upstream provider so native Responses backends do not persist', async () => {
    vi.mocked(resolveModelString).mockResolvedValueOnce({
      service: serviceModel('openai') as never,
      modelId: 'test-model',
    });
    const { ctx, model } = createContext({ model: 'test-service/test-model', input: 'Hello', store: false }, 'openai');

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(model.modelKwargs).toMatchObject({ store: false });
    expect(storeResponseRecord).not.toHaveBeenCalled();
  });

  it('does not forward store when omitted or true so non-Responses backends keep their defaults', async () => {
    const { ctx: omitCtx, model: omitModel } = createContext({ model: 'test-service/test-model', input: 'Hello' });
    const { ctx: trueCtx, model: trueModel } = createContext({
      model: 'test-service/test-model',
      input: 'Hello',
      store: true,
    });

    await handleResponses(omitCtx, {} as PluginAiApiServer);
    await handleResponses(trueCtx, {} as PluginAiApiServer);

    expect(omitModel.modelKwargs).not.toHaveProperty('store');
    expect(trueModel.modelKwargs).not.toHaveProperty('store');
  });

  it('forwards store=false only to Responses-capable providers, never to Chat Completions providers', async () => {
    // Responses-capable provider (registered as 'openai') must receive store=false upstream.
    vi.mocked(resolveModelString).mockResolvedValueOnce({
      service: serviceModel('openai') as never,
      modelId: 'gpt-4o',
    });
    const { ctx: respCtx, model: respModel } = createContext(
      { model: 'test-service/gpt-4o', input: 'Hello', store: false },
      'openai',
    );
    await handleResponses(respCtx, {} as PluginAiApiServer);
    expect(respModel.modelKwargs).toMatchObject({ store: false });

    // Chat Completions providers receive modelKwargs verbatim in the /chat/completions payload,
    // where the unknown `store` field would be rejected — so it must not be forwarded.
    // Expectations are derived from the exported provider classification so this test stays
    // correct when the implementation adds or reclassifies a Responses-capable provider.
    const ALL_PROVIDERS = [
      'openai',
      'openai-completions',
      'dashscope',
      'kimi',
      'deepseek',
      'google-genai',
      'ollama',
      'anthropic',
    ];
    for (const providerKey of ALL_PROVIDERS) {
      const shouldForward = RESPONSES_CAPABLE_PROVIDERS.has(providerKey);
      vi.mocked(resolveModelString).mockResolvedValueOnce({
        service: serviceModel(providerKey) as never,
        modelId: 'some-model',
      });
      const { ctx, model } = createContext(
        { model: 'test-service/some-model', input: 'Hello', store: false },
        providerKey,
      );
      await handleResponses(ctx, {} as PluginAiApiServer);
      if (shouldForward) {
        expect(model.modelKwargs).toMatchObject({ store: false });
      } else {
        expect(model.modelKwargs).not.toHaveProperty('store');
      }
    }
  });

  it('returns 500 for non-streaming requests when response persistence fails', async () => {
    vi.mocked(storeResponseRecord).mockRejectedValueOnce(new Error('database unavailable'));
    const { ctx } = createContext({ model: 'test-service/test-model', input: 'Hello', store: true });

    await handleResponses(ctx, {} as PluginAiApiServer);

    // Non-streaming clients asked for a stored response; a partial success (unstored 200) would
    // silently break previous_response_id chaining, so the request must fail instead.
    expect(ctx.status).toBe(500);
    expect(ctx.body).toMatchObject({ error: { type: 'server_error' } });
  });

  it('prepends an owner-scoped previous response chain', async () => {
    vi.mocked(loadConversationChain).mockResolvedValue([
      { role: 'user', content: 'My name is Nam' },
      { role: 'assistant', content: 'Nice to meet you, Nam' },
    ]);
    const { ctx, model } = createContext({
      model: 'test-service/test-model',
      input: 'What is my name?',
      previous_response_id: 'resp_previous',
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(loadConversationChain).toHaveBeenCalledWith(ctx, 'resp_previous', 42);
    expect(model.invoke.mock.calls[0][0]).toHaveLength(3);
  });

  it('returns 404 when previous_response_id is missing, expired, or belongs to another user', async () => {
    vi.mocked(loadConversationChain).mockResolvedValue(null);
    const { ctx, model } = createContext({
      model: 'test-service/test-model',
      input: 'Hello',
      previous_response_id: 'resp_private',
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(404);
    expect(ctx.body).toMatchObject({ error: { code: 'previous_response_not_found' } });
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('rejects OpenAI file IDs because this gateway has no OpenAI file store', async () => {
    const { ctx, model } = createContext({
      model: 'test-service/test-model',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_file', file_id: 'file_private' }],
        },
      ],
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({ error: { code: 'unsupported_input' } });
    expect(model.invoke).not.toHaveBeenCalled();
  });
  it('rejects unsupported built-in tools instead of silently forwarding them', async () => {
    const { ctx, model } = createContext({
      model: 'test-service/test-model',
      input: 'Search the web',
      tools: [{ type: 'web_search' }],
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({ error: { code: 'unsupported_tool' } });
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('validates service_tier values', async () => {
    const { ctx } = createContext({
      model: 'test-service/test-model',
      input: 'Hello',
      service_tier: 'flexible',
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({ error: { code: 'invalid_service_tier' } });
  });

  it.each([
    [{ input: [{ type: 'message', role: 'user', content: [{ type: 'input_audio' }] }] }, 'invalid_input'],
    [{ tools: { type: 'function' } }, 'unsupported_tool'],
    [{ tool_choice: { type: 'function' } }, 'invalid_tool_choice'],
    [{ metadata: { key: 42 } }, 'invalid_metadata'],
    [{ background: true }, 'unsupported_parameter'],
    [{ prompt_cache_retention: '7d' }, 'invalid_parameter'],
    [{ prompt_cache_key: null }, 'invalid_parameter'],
    [{ safety_identifier: 'x'.repeat(65) }, 'invalid_parameter'],
    [{ text: { format: { type: 'json_schema', name: '', schema: {} } } }, 'invalid_parameter'],
  ])('rejects malformed Responses fields before provider invocation', async (override, code) => {
    const { ctx, model } = createContext({
      model: 'test-service/test-model',
      input: 'Hello',
      ...override,
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({ error: { code } });
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('maps Responses function tools to Chat Completions tool format', async () => {
    const { ctx, model } = createContext({
      model: 'test-service/test-model',
      input: 'Weather?',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(200);
    expect(model.bindTools).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_weather' }) })],
      expect.any(Object),
    );
  });

  it('passes LangChain call options without leaking camelCase names into provider model kwargs', async () => {
    const { ctx, model } = createContext({
      model: 'test-service/test-model',
      input: 'Hello',
      prompt_cache_key: 'cache-key',
      prompt_cache_retention: '24h',
      safety_identifier: 'hashed-user',
      reasoning: { effort: 'medium' },
      text: { verbosity: 'low' },
    });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(model.invoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        promptCacheKey: 'cache-key',
        promptCacheRetention: '24h',
        reasoning: { effort: 'medium' },
        verbosity: 'low',
      }),
    );
    expect(model.modelKwargs).toMatchObject({ safety_identifier: 'hashed-user' });
    expect(model.modelKwargs).not.toHaveProperty('promptCacheKey');
    expect(model.modelKwargs).not.toHaveProperty('promptCacheRetention');
  });

  it.each([
    ['auto', 'truncate'],
    ['disabled', 'reject'],
  ])('maps truncation=%s to the direct-context overflow policy', async (truncation, overflowBehavior) => {
    const { ctx } = createContext({ model: 'test-service/test-model', input: 'Hello', truncation });

    await handleResponses(ctx, {} as PluginAiApiServer);

    expect(prepareDirectLlmContext).toHaveBeenCalledWith(ctx, expect.objectContaining({ overflowBehavior }));
  });
});
describe('stored Responses API handlers', () => {
  it('retrieves a stored response for its owner', async () => {
    const { ctx } = createContext({});
    vi.mocked(getResponseRecord).mockResolvedValue({
      id: 1,
      responseId: 'resp_saved',
      userId: 42,
      model: 'service/model',
      input: 'Hello',
      output: { id: 'resp_saved', object: 'response' } as never,
      expiresAt: new Date(Date.now() + 1000),
    });

    await handleGetResponse(ctx, 'resp_saved');

    expect(getResponseRecord).toHaveBeenCalledWith(ctx, 'resp_saved', 42);
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ id: 'resp_saved', object: 'response' });
  });

  it.each([{ stream: 'true' }, { include: 'reasoning.encrypted_content' }, { starting_after: '10' }])(
    'rejects unsupported retrieve query parameters: %o',
    async (query) => {
      const { ctx } = createContext({});
      ctx.query = query;

      await handleGetResponse(ctx, 'resp_saved');

      expect(ctx.status).toBe(400);
      expect(ctx.body).toMatchObject({ error: { code: 'unsupported_parameter' } });
      expect(getResponseRecord).not.toHaveBeenCalled();
    },
  );

  it('returns 404 without disclosing a response owned by another user', async () => {
    const { ctx } = createContext({});
    vi.mocked(getResponseRecord).mockResolvedValue(null);

    await handleGetResponse(ctx, 'resp_private');

    expect(ctx.status).toBe(404);
    expect(ctx.body).toMatchObject({ error: { code: 'response_not_found' } });
  });

  it('deletes only an owner-scoped stored response', async () => {
    const { ctx } = createContext({});
    vi.mocked(deleteResponseRecord).mockResolvedValue(true);

    await handleDeleteResponse(ctx, 'resp_saved');

    expect(deleteResponseRecord).toHaveBeenCalledWith(ctx, 'resp_saved', 42);
    expect(ctx.status).toBe(204);
    expect(ctx.body).toBeUndefined();
  });
});
