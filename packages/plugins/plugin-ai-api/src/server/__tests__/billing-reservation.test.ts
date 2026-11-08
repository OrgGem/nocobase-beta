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
import { calculateLlmCost, finalizeLlmBilling, type LlmBillingState } from '../billing';
import { handleChatCompletions } from '../routes/chat-completions';
import { handleCompletions } from '../routes/completions';
import { handleEmbeddings } from '../routes/embeddings';
import { handleResponses } from '../routes/responses';
import { invalidateGroupAccessCache } from '../utils/user-permissions';

function record(values: Record<string, unknown>) {
  return { ...values, get: (key?: string) => (key ? values[key] : values) };
}

function context(
  body: Record<string, unknown>,
  options: {
    tokenLimit?: number;
    costLimit?: string;
    contextWindow?: number;
    systemPrompt?: string;
    truncate?: boolean;
    history?: string;
  } = {},
) {
  const model = {
    invoke: vi.fn().mockResolvedValue({ content: 'ok' }),
    modelKwargs: {},
    bindTools: vi.fn(function () {
      return model;
    }),
  };
  const embedDocuments = vi.fn().mockResolvedValue([[0.1]]);
  const providerOptions: Record<string, unknown>[] = [];
  class Provider {
    constructor({ modelOptions }: { modelOptions: Record<string, unknown> }) {
      providerOptions.push(modelOptions);
    }
    createModel() {
      return model;
    }
    createEmbedding() {
      return { embedDocuments };
    }
  }
  const service = record({ name: 'svc', provider: 'mock', enabled: true, options: {} });
  const group = record({
    id: 1,
    enabled: true,
    quotaMode: 'per_user',
    periodType: 'monthly',
    timezone: 'UTC',
    totalTokenLimit: options.tokenLimit ?? 1000000,
    costLimit: options.costLimit ?? null,
    currency: 'USD',
    rejectUnpricedModel: true,
    missingUsageBehavior: 'use_reserved',
    allowAllModels: true,
    contextOverflowBehavior: options.truncate ? 'truncate' : 'reject',
  });
  const bucketValues: Record<string, unknown> = {
    id: 1,
    requestCount: 0,
    totalTokens: 0,
    cost: '0',
    reservedRequests: 0,
    reservedTokens: 0,
    reservedCost: '0',
  };
  const bucket = {
    get: (key: string) => bucketValues[key],
    reload: vi.fn(),
    update: vi.fn(async (values: Record<string, unknown>) => Object.assign(bucketValues, values)),
  };
  const ctx = {
    app: {
      name: 'reservation-tests',
      pm: {
        get: () => ({ aiManager: { llmProviders: new Map([['mock', { provider: Provider, embedding: Provider }]]) } }),
      },
    },
    state: { currentUser: { id: 7 } },
    request: { body },
    res: { headersSent: false },
    set: vi.fn(),
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    db: {
      getRepository: (name: string) => ({
        findOne: async () => {
          if (name === 'llmServices') return service;
          if (name === 'aiApiConfig') return record({ quotaEnabled: true, defaultReservationOutputTokens: 4096 });
          if (name === 'aiApiUsageGroups') return group;
          if (name === 'aiApiModelMetadata')
            return record({
              enabled: true,
              contextWindow: options.contextWindow ?? 128000,
              maxCompletionTokens: 8192,
              systemPrompt: options.systemPrompt,
            });
          if (name === 'aiApiModelPrices')
            return record({
              id: 1,
              currency: 'USD',
              inputPricePerMillionTokens: '1',
              outputPricePerMillionTokens: '2',
            });
          if (name === 'aiApiResponseRecords' && options.history)
            return record({
              responseId: 'resp_previous',
              userId: 7,
              model: 'svc/model',
              input: options.history,
              output: { output: [] },
              expiresAt: new Date(Date.now() + 60000),
            });
          return null;
        },
        create: vi.fn(),
      }),
      getModel: () => ({ findOrCreate: async () => [bucket], findByPk: async () => bucket }),
      sequelize: {
        transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({ LOCK: { UPDATE: 'UPDATE' } }),
      },
    },
  } as unknown as Context;
  return { ctx, model, embedDocuments, providerOptions, bucketValues };
}

beforeEach(() => invalidateGroupAccessCache());
const plugin = {} as PluginAiApiServer;

describe('gateway quota matches the provider request', () => {
  it('rejects Responses input and max_output_tokens above quota before invoking the provider', async () => {
    const { ctx, model } = context(
      { model: 'svc/model', input: 'x'.repeat(40000), max_output_tokens: 8000, store: false },
      { tokenLimit: 5000 },
    );
    await handleResponses(ctx, plugin);
    expect(ctx.status).toBe(429);
    expect(ctx.body).toMatchObject({ error: { code: 'token_quota_exceeded' } });
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('includes previous_response_id history in the reservation', async () => {
    const { ctx, model } = context(
      { model: 'svc/model', input: 'Next', previous_response_id: 'resp_previous', max_output_tokens: 16, store: false },
      { tokenLimit: 10000, history: 'x'.repeat(48000) },
    );
    await handleResponses(ctx, plugin);
    expect(ctx.status).toBe(429);
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['chat', handleChatCompletions, { messages: [{ role: 'user', content: 'Hi' }] }],
    ['legacy', handleCompletions, { prompt: 'Hi' }],
  ] as const)('reserves the default provider output limit for %s', async (_name, handler, body) => {
    const { ctx, model } = context({ model: 'svc/model', ...body, stream: false }, { tokenLimit: 5000 });
    await handler(ctx, plugin);
    expect(ctx.status).toBe(429);
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('includes tool schemas and model system prompts in the cost reservation', async () => {
    const { ctx, model } = context(
      {
        model: 'svc/model',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        max_tokens: 16,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'x'.repeat(18000),
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      },
      { costLimit: '0.001', systemPrompt: 's'.repeat(18000) },
    );
    await handleChatCompletions(ctx, plugin);
    expect(ctx.status).toBe(429);
    expect(ctx.body).toMatchObject({ error: { code: 'cost_quota_exceeded' } });
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('reserves retained context after truncation and reconciles missing usage with that budget', async () => {
    const { ctx, model, bucketValues, providerOptions } = context(
      {
        model: 'svc/model',
        stream: false,
        max_tokens: 32,
        messages: [
          { role: 'user', content: 'x'.repeat(4000) },
          { role: 'assistant', content: 'previous' },
          { role: 'user', content: 'latest' },
        ],
      },
      { tokenLimit: 100, contextWindow: 200, truncate: true, systemPrompt: 'Be helpful' },
    );
    await handleChatCompletions(ctx, plugin);
    expect(ctx.status).toBe(200);
    expect(model.invoke).toHaveBeenCalledOnce();
    expect(providerOptions[0].maxTokens).toBe(32);
    const prepared = ctx.state.aiApiPreparedContext;
    expect(prepared.truncated).toBe(true);
    const billing = ctx.state.aiApiLlmBilling as LlmBillingState;
    expect(Number(bucketValues.reservedTokens)).toBe(prepared.estimatedInputTokens + 32);
    if (!billing.price) throw new Error('Expected configured model price');
    expect(bucketValues.reservedCost).toBe(calculateLlmCost(prepared.estimatedInputTokens, 32, billing.price));
    const finalized = await finalizeLlmBilling(ctx, undefined, true);
    expect(finalized.usage?.total_tokens).toBe(prepared.estimatedInputTokens + 32);
    expect(bucketValues.reservedTokens).toBe('0');
  });

  it.each([
    ['responses', handleResponses, { input: 'hello', max_output_tokens: 64, store: false }],
    ['legacy', handleCompletions, { prompt: 'hello', stream: false }],
  ] as const)('uses the same output budget for billing and the %s provider', async (_name, handler, body) => {
    const { ctx, providerOptions, bucketValues } = context({ model: 'svc/model', ...body });
    await handler(ctx, plugin);
    expect(ctx.status).toBe(200);
    const prepared = ctx.state.aiApiPreparedContext;
    expect(providerOptions[0].maxTokens).toBe(prepared.reservedOutputTokens);
    expect(Number(bucketValues.reservedTokens)).toBe(prepared.estimatedInputTokens + prepared.reservedOutputTokens);
  });

  it('rejects a large embedding input before invoking the embedding provider', async () => {
    const { ctx, embedDocuments } = context({ model: 'svc/model', input: 'x'.repeat(40000) }, { tokenLimit: 5000 });
    await handleEmbeddings(ctx, plugin);
    expect(ctx.status).toBe(429);
    expect(embedDocuments).not.toHaveBeenCalled();
  });

  it('reserves only embedding input tokens with zero output tokens', async () => {
    const { ctx, embedDocuments, bucketValues } = context(
      { model: 'svc/model', input: ['abcdefgh', 'ijklmnop'] },
      { tokenLimit: 4 },
    );
    await handleEmbeddings(ctx, plugin);
    expect(ctx.status).toBe(200);
    expect(embedDocuments).toHaveBeenCalledWith(['abcdefgh', 'ijklmnop']);
    expect(bucketValues.reservedTokens).toBe('4');
    expect(bucketValues.reservedCost).toBe('0.00000400');
  });
});
