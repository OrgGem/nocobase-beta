import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import { authenticateBearer } from '../routes/auth';
import {
  extractProviderRequestId,
  finishUsageRecord,
  normalizeUsage,
  setAiApiUsageResult,
  setAiApiUsageUnavailable,
  startUsageRecord,
} from '../usage';

function createContext(overrides: Record<string, unknown> = {}): Context {
  return {
    state: {},
    request: { body: {} },
    ...overrides,
  } as unknown as Context;
}

describe('AI API usage normalization', () => {
  it('normalizes LangChain fields and derives a missing total', () => {
    expect(normalizeUsage({ input_tokens: 12, output_tokens: 5 })).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_cache_tokens: null,
    });
  });

  it('preserves explicit zero usage from a provider', () => {
    expect(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_cache_tokens: null,
    });
  });

  it('extracts prompt_cache_tokens when present in various provider formats', () => {
    expect(
      normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_cache_tokens: 8,
    });
    expect(normalizeUsage({ input_tokens: 20, output_tokens: 10, input_token_details: { cache_read: 15 } })).toEqual({
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      prompt_cache_tokens: 15,
    });
  });

  it('is idempotent so streaming double-normalization keeps prompt_cache_tokens', () => {
    const streamChunkUsage = {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_token_details: { cache_read: 80 },
    };
    const firstPass = normalizeUsage(streamChunkUsage);
    expect(firstPass?.prompt_cache_tokens).toBe(80);

    // Streaming routes normalize the chunk once, then setAiApiUsageResult
    // normalizes the result again — the extracted value must survive.
    expect(normalizeUsage(firstPass)).toEqual(firstPass);
  });

  it('keeps prompt_cache_tokens when setAiApiUsageResult receives pre-normalized usage', () => {
    const ctx = createContext();
    const preNormalized = normalizeUsage({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_token_details: { cache_read: 80 },
    });

    const usage = setAiApiUsageResult(ctx, preNormalized, { gatewayResponseId: 'gateway-stream-id' });

    expect(usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_cache_tokens: 80,
    });
    expect(ctx.state.aiApiUsageResult).toMatchObject({
      source: 'provider',
      usage: { prompt_cache_tokens: 80 },
    });
  });

  it('rejects synthetic or invalid usage values', () => {
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({ prompt_tokens: '12', completion_tokens: -1, total_tokens: Number.NaN })).toBeUndefined();
    expect(normalizeUsage({ prompt_tokens: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
  });

  it('extracts a provider request ID only from provider metadata', () => {
    expect(extractProviderRequestId({ id: 'gateway-id', response_metadata: { request_id: 'provider-id' } })).toBe(
      'provider-id',
    );
    expect(extractProviderRequestId({ id: 'gateway-id' })).toBeUndefined();
  });
});

describe('AI API usage persistence', () => {
  it('preserves the authenticated BIGINT identifier without Number or String coercion', async () => {
    const create = vi.fn().mockResolvedValue({ id: 91 });
    const ctx = createContext({
      state: {
        currentUser: { id: '9007199254740993' },
        currentRole: 'member',
        aiApiAuthType: 'bearer',
      },
      request: {
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          max_completion_tokens: 200,
        },
      },
      db: { getRepository: vi.fn().mockReturnValue({ create }) },
    });

    await expect(startUsageRecord(ctx, 'req-1', '/chat/completions', 'service/model', false, 'llm')).resolves.toBe(91);
    expect(create).toHaveBeenCalledWith({
      values: expect.objectContaining({
        userId: '9007199254740993',
        authType: 'bearer',
        requestMetadata: {
          messageCount: 1,
          promptCount: undefined,
          embeddingInputCount: undefined,
          requestedMaxTokens: 200,
        },
      }),
    });
  });

  it('refuses to create a usage record without an authenticated user ID', async () => {
    const ctx = createContext({
      db: { getRepository: vi.fn() },
    });

    await expect(startUsageRecord(ctx, 'req-1', '/chat/completions', 'service/model', false, 'llm')).rejects.toThrow(
      'requires an authenticated NocoBase user ID',
    );
  });

  it('stores real provider usage and separates provider and gateway IDs', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const ctx = createContext({
      status: 200,
      body: { id: 'gateway-body-id' },
      db: { getRepository: vi.fn().mockReturnValue({ update }) },
    });

    setAiApiUsageResult(
      ctx,
      { input_tokens: 20, output_tokens: 4 },
      {
        gatewayResponseId: 'gateway-result-id',
        providerRequestId: 'provider-id',
      },
    );
    await finishUsageRecord(ctx, 1, Date.now() - 10, 'succeeded');

    expect(update).toHaveBeenCalledWith({
      filterByTk: 1,
      values: expect.objectContaining({
        status: 'succeeded',
        inputTokens: 20,
        outputTokens: 4,
        totalTokens: 24,
        cacheInputPricePerMillionTokens: null,
        providerRequestId: 'provider-id',
        responseMetadata: { usageSource: 'provider', gatewayResponseId: 'gateway-result-id' },
      }),
    });
  });

  it('does not persist synthetic zeroes when provider usage is unavailable', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const ctx = createContext({
      status: 200,
      body: {
        id: 'gateway-id',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      db: { getRepository: vi.fn().mockReturnValue({ update }) },
    });

    setAiApiUsageUnavailable(ctx, 'gateway-id');
    await finishUsageRecord(ctx, 2, Date.now() - 10, 'succeeded');

    expect(update).toHaveBeenCalledWith({
      filterByTk: 2,
      values: expect.objectContaining({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        providerRequestId: null,
        responseMetadata: { usageSource: 'unavailable', gatewayResponseId: 'gateway-id' },
      }),
    });
  });

  it('uses streaming execution state to persist a failed stream', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const ctx = createContext({
      status: 200,
      state: {
        aiApiStreamResult: { succeeded: false, id: 'gateway-stream-id', errorCode: 'stream_error' },
      },
      db: { getRepository: vi.fn().mockReturnValue({ update }) },
    });

    await finishUsageRecord(ctx, 3, Date.now() - 10, 'succeeded');

    expect(update).toHaveBeenCalledWith({
      filterByTk: 3,
      values: expect.objectContaining({
        status: 'failed',
        httpStatus: 200,
        errorCode: 'stream_error',
        responseMetadata: { usageSource: 'unavailable', gatewayResponseId: 'gateway-stream-id' },
      }),
    });
  });
});

describe('AI API authentication provenance', () => {
  it('classifies a pre-authenticated NocoBase principal as bearer rather than session', async () => {
    const ctx = createContext({
      state: { currentUser: { id: 1 }, currentRole: 'member' },
      get: vi.fn((name: string) => (name === 'Authorization' ? 'Bearer token' : '')),
    });

    await expect(authenticateBearer(ctx)).resolves.toBe(true);
    expect(ctx.state.aiApiAuthType).toBe('bearer');
  });

  it('classifies a principal as OIDC only when verified OAuth state is present', async () => {
    const ctx = createContext({
      state: {
        currentUser: { id: 1 },
        currentRole: 'member',
        oauthPrincipal: { subject: '1', clientId: 'client-1' },
      },
      get: vi.fn((name: string) => (name === 'Authorization' ? 'Bearer token' : '')),
    });

    await expect(authenticateBearer(ctx)).resolves.toBe(true);
    expect(ctx.state.aiApiAuthType).toBe('oidc');
  });
});
