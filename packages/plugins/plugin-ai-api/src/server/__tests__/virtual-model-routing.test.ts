/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type PluginAiApiServer from '../plugin';
import { handleChatCompletions } from '../routes/chat-completions';
import { handleEmbeddings } from '../routes/embeddings';
import { resolveModelReference, resolveModelString } from '../utils/resolve-service';
import { detectRequestSignals, listAccessibleVirtualModels } from '../utils/virtual-models';
import { invalidateGroupAccessCache } from '../utils/user-permissions';

vi.mock('../utils/resolve-service', () => ({
  resolveModelString: vi.fn(),
  resolveModelReference: vi.fn(),
}));

interface ModelResult {
  content: string;
  response_metadata?: Record<string, unknown>;
  usage_metadata?: Record<string, unknown>;
}

interface RepositoryOverride {
  findOne?: () => unknown;
  find?: () => unknown;
}

function createContext(
  result: ModelResult,
  requestBody: Record<string, unknown>,
  repositories: Record<string, RepositoryOverride>,
  metadataGet?: (key: string) => unknown,
) {
  const model = {
    invoke: vi.fn().mockResolvedValue(result),
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

  const getMetadataValue =
    metadataGet ??
    ((key: string) => (key === 'contextWindow' ? 128_000 : key === 'maxCompletionTokens' ? 16_384 : true));

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
        if (repositories[name]) return repositories[name];
        if (name === 'aiApiModelMetadata') {
          return {
            findOne: vi.fn().mockResolvedValue({ get: getMetadataValue }),
            find: vi.fn().mockResolvedValue([]),
          };
        }
        if (name === 'aiApiUsageGroups') {
          return {
            findOne: vi.fn().mockResolvedValue({ id: 1, name: 'Default', isDefault: true, allowAllModels: true }),
          };
        }
        return { findOne: vi.fn().mockResolvedValue(null), find: vi.fn().mockResolvedValue([]) };
      }),
    },
    log: { error: vi.fn() },
    request: { body: requestBody },
    state: { currentUser: { id: 1 } } as Record<string, unknown>,
    set: vi.fn(),
    // Minimal req/res mocks so streaming.ts helpers do not touch undefined.
    req: {
      aborted: false,
      once: vi.fn(),
      off: vi.fn(),
    },
    res: {
      writableEnded: false,
      destroyed: false,
      once: vi.fn(),
      off: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(),
    },
  } as unknown as Context;

  return { ctx, model };
}

const VIRTUAL_MODEL_ROW = {
  get: (key: string) => {
    const row: Record<string, unknown> = {
      name: 'auto',
      mode: 'chat',
      enabled: true,
      fallbackModel: 'fallback-svc/fallback-model',
      visionModels: ['vision-svc/vision-model'],
      toolModels: ['tool-svc/tool-model'],
      reasoningModels: ['reasoning-svc/reasoning-model'],
      cheapModels: [],
      generalModels: ['general-svc/general-model'],
    };
    return row[key];
  },
};

describe('AI API virtual model routing (llm mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateGroupAccessCache();
    // Default: every concrete model resolves successfully.
    const resolveAny = async (_ctx: unknown, modelString: unknown) => {
      const [service, modelId] = String(modelString).split('/');
      if (!service || !modelId) return null;
      return {
        service: { enabled: true, name: service, options: {}, provider: 'test-provider' } as unknown as Model,
        modelId,
      };
    };
    vi.mocked(resolveModelReference).mockImplementation(resolveAny);
    vi.mocked(resolveModelString).mockImplementation(resolveAny);
  });

  it('skips bucket candidates whose service reference does not resolve (no default-service fallback)', async () => {
    // A typo like "missing-svc/model" must be skipped, not silently reinterpreted as a model id
    // on the default service. Only the valid fallback resolves.
    const fallbackModel = {
      enabled: true,
      name: 'fallback-svc',
      title: 'fallback-svc',
      options: {},
      provider: 'test-provider',
    } as unknown as Model;
    vi.mocked(resolveModelReference).mockImplementation(async (_ctx, reference) => {
      const [service, modelId] = String(reference).split('/');
      if (service === 'missing-svc') return null;
      if (!service || !modelId) return null;
      if (service === 'fallback-svc') return { service: fallbackModel, modelId };
      return {
        service: {
          enabled: true,
          name: service,
          title: service,
          options: {},
          provider: 'test-provider',
        } as unknown as Model,
        modelId,
      };
    });
    const row = {
      get: (key: string) =>
        (
          ({
            name: 'auto',
            mode: 'chat',
            enabled: true,
            fallbackModel: 'fallback-svc/fallback-model',
            visionModels: ['missing-svc/typo-model'],
            toolModels: [],
            reasoningModels: [],
            cheapModels: [],
            generalModels: [],
          }) as Record<string, unknown>
        )[key],
    };
    const { ctx } = createContext(
      { content: 'fallback used' },
      {
        model: 'auto',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }],
      },
      {
        aiApiVirtualModels: { findOne: () => Promise.resolve(row), find: () => Promise.resolve([row]) },
        aiApiUsageGroups: {
          findOne: () =>
            Promise.resolve({
              id: 1,
              name: 'Default',
              isDefault: true,
              allowedLlmServices: ['fallback-svc'],
              allowAllModels: true,
            }),
        },
      },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer).catch((e) => {
      throw new Error(`handleChatCompletions threw: ${e}\nctx.body=${JSON.stringify(ctx.body)}`);
    });

    if (ctx.status !== 200) {
      throw new Error(`expected 200, got ${ctx.status}: ${JSON.stringify(ctx.body)}`);
    }
    expect(ctx.state.aiApiRoutingReason).toBe('fallback');
    // The typo candidate was attempted strictly and returned null — not resolved on another service.
    expect(resolveModelReference).toHaveBeenCalledWith(ctx, 'missing-svc/typo-model');
    // Routing fell through to the valid fallback.
    expect(resolveModelReference).toHaveBeenCalledWith(ctx, 'fallback-svc/fallback-model');
  });

  it('skips bucket candidates with typo service references (direct resolution)', async () => {
    // Pure resolution check without the HTTP handler, to isolate routing from request plumbing.
    const { resolveVirtualModel } = await import('../utils/virtual-models');
    const fallbackModel = {
      enabled: true,
      name: 'fallback-svc',
      title: 'fallback-svc',
      options: {},
      provider: 'test-provider',
    } as unknown as Model;
    vi.mocked(resolveModelReference).mockImplementation(async (_ctx, reference) => {
      const [service, modelId] = String(reference).split('/');
      if (service === 'missing-svc') return null;
      if (!service || !modelId) return null;
      if (service === 'fallback-svc') return { service: fallbackModel, modelId };
      return {
        service: {
          enabled: true,
          name: service,
          title: service,
          options: {},
          provider: 'test-provider',
        } as unknown as Model,
        modelId,
      };
    });
    const row = {
      get: (key: string) =>
        (
          ({
            name: 'auto',
            mode: 'chat',
            enabled: true,
            fallbackModel: 'fallback-svc/fallback-model',
            visionModels: ['missing-svc/typo-model'],
            toolModels: [],
            reasoningModels: [],
            cheapModels: [],
            generalModels: [],
          }) as Record<string, unknown>
        )[key],
    };
    const { ctx } = createContext(
      { content: 'fallback used' },
      {
        model: 'auto',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }],
      },
      {
        aiApiVirtualModels: { findOne: () => Promise.resolve(row), find: () => Promise.resolve([row]) },
        aiApiUsageGroups: {
          findOne: () =>
            Promise.resolve({
              id: 1,
              name: 'Default',
              isDefault: true,
              allowedLlmServices: ['fallback-svc'],
              allowAllModels: true,
            }),
        },
      },
    );

    const result = await resolveVirtualModel(ctx, 'auto', ctx.request.body as Record<string, unknown>, 'chat');

    expect(result?.status).toBe('resolved');
    expect(result?.reason).toBe('fallback');
    expect((result as { resolved?: { modelId: string } }).resolved?.modelId).toBe('fallback-model');
    expect(resolveModelReference).toHaveBeenCalledWith(ctx, 'missing-svc/typo-model');
  });

  it('derives the general bucket from every metadata tier ordered by sortOrder when no bucket is configured', async () => {
    // Characterization: empty generalModels/cheapModels means the general bucket is derived
    // from model metadata across ALL reasoningTiers, ordered by sortOrder. A plain request
    // (no capability signals) is served by the lowest-sortOrder row even if that row is a
    // reasoning-tier model — the general bucket is a catch-all, not a tier filter.
    const { resolveVirtualModel } = await import('../utils/virtual-models');
    const metadataRow = (llmService: string, model: string, reasoningTier: string, sortOrder: number) => ({
      get: (key: string) => ({ llmService, model, reasoningTier, sortOrder })[key],
    });
    const row = {
      get: (key: string) =>
        (
          ({
            name: 'auto',
            mode: 'chat',
            enabled: true,
            fallbackModel: 'svc/fallback',
            visionModels: [],
            toolModels: [],
            reasoningModels: [],
            cheapModels: [],
            generalModels: [],
          }) as Record<string, unknown>
        )[key],
    };
    const { ctx } = createContext(
      { content: 'general answer' },
      { model: 'auto', messages: [{ role: 'user', content: 'Hello' }], stream: false },
      {
        aiApiVirtualModels: { findOne: () => Promise.resolve(row), find: () => Promise.resolve([row]) },
        aiApiModelMetadata: {
          findOne: () => Promise.resolve(null),
          find: () =>
            Promise.resolve([
              metadataRow('svc', 'reasoning-a', 'reasoning', 1),
              metadataRow('svc', 'general-b', 'general', 2),
            ]),
        },
      },
    );

    const result = await resolveVirtualModel(ctx, 'auto', ctx.request.body as Record<string, unknown>, 'chat');

    expect(result?.status).toBe('resolved');
    expect(result?.reason).toBe('general');
    expect((result as { resolved?: { modelId: string } }).resolved?.modelId).toBe('reasoning-a');
  });

  it('routes a vision request to the first permitted vision candidate', async () => {
    const { ctx } = createContext(
      { content: 'I see an image.' },
      {
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
            ],
          },
        ],
        stream: false,
      },
      { aiApiVirtualModels: { findOne: () => Promise.resolve(VIRTUAL_MODEL_ROW) } },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    if (ctx.status !== 200) throw new Error(`vision test expected 200, got ${ctx.status}: ${JSON.stringify(ctx.body)}`);
    expect(ctx.state.aiApiVirtualModel).toBe('auto');
    expect(ctx.state.aiApiRoutingReason).toBe('vision');
    expect(ctx.state.aiApiLlmBilling).toMatchObject({
      resolution: { service: 'vision-svc', model: 'vision-model' },
    });
    // Response must carry the resolved concrete model, not the alias.
    expect((ctx.body as { model: string }).model).toBe('vision-svc/vision-model');
  });

  it('routes a tool-calling request to the tool bucket', async () => {
    const { ctx } = createContext(
      { content: 'ok' },
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'Call a tool' }],
        tools: [{ type: 'function', function: { name: 'x' } }],
        stream: false,
      },
      { aiApiVirtualModels: { findOne: () => Promise.resolve(VIRTUAL_MODEL_ROW) } },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(200);
    expect(ctx.state.aiApiRoutingReason).toBe('tools');
    expect(ctx.state.aiApiLlmBilling).toMatchObject({
      resolution: { service: 'tool-svc', model: 'tool-model' },
    });
  });

  it('treats file blocks as vision input', () => {
    expect(
      detectRequestSignals({
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', file: { file_data: 'data:application/pdf;base64,YQ==' } }],
          },
        ],
      }),
    ).toMatchObject({ hasImage: true });
  });

  it('routes an explicit reasoning request to the reasoning bucket', async () => {
    const { ctx } = createContext(
      { content: 'reasoned answer' },
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'Think carefully' }],
        reasoning_effort: 'high',
        stream: false,
      },
      { aiApiVirtualModels: { findOne: () => Promise.resolve(VIRTUAL_MODEL_ROW) } },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(200);
    expect(ctx.state.aiApiRoutingReason).toBe('reasoning');
    expect(ctx.state.aiApiLlmBilling).toMatchObject({
      resolution: { service: 'reasoning-svc', model: 'reasoning-model' },
    });
  });

  it('does not resolve a chat alias for the embeddings endpoint', async () => {
    const { ctx } = createContext(
      { content: '' },
      { model: 'auto', input: 'Embed this' },
      { aiApiVirtualModels: { findOne: () => Promise.resolve(VIRTUAL_MODEL_ROW) } },
    );

    await handleEmbeddings(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(404);
    expect(ctx.body).toMatchObject({ error: { code: 'model_not_found' } });
    expect(resolveModelReference).not.toHaveBeenCalled();
  });

  it('does not resolve an embedding alias for the chat endpoint', async () => {
    const embeddingRow = {
      get: (key: string) => (key === 'mode' ? 'embedding' : VIRTUAL_MODEL_ROW.get(key)),
    };
    const { ctx } = createContext(
      { content: '' },
      { model: 'auto', messages: [{ role: 'user', content: 'Hello' }] },
      { aiApiVirtualModels: { findOne: () => Promise.resolve(embeddingRow) } },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(404);
    expect(ctx.body).toMatchObject({ error: { code: 'model_not_found' } });
    expect(resolveModelReference).not.toHaveBeenCalled();
  });

  it('resolves an embedding alias directly to its fallback without using chat buckets', async () => {
    const embeddingRow = {
      get: (key: string) => (key === 'mode' ? 'embedding' : VIRTUAL_MODEL_ROW.get(key)),
    };
    const embeddingModel = { embedDocuments: vi.fn().mockResolvedValue([[0.1, 0.2]]) };
    class EmbeddingProvider {
      createEmbedding() {
        return embeddingModel;
      }
    }
    const { ctx } = createContext(
      { content: '' },
      { model: 'auto', input: 'Embed this' },
      { aiApiVirtualModels: { findOne: () => Promise.resolve(embeddingRow) } },
    );
    vi.mocked(ctx.app.pm.get).mockReturnValue({
      aiManager: { llmProviders: new Map([['test-provider', { embedding: EmbeddingProvider }]]) },
    });

    await handleEmbeddings(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(200);
    expect(ctx.state.aiApiRoutingReason).toBe('fallback');
    expect(ctx.body).toMatchObject({ model: 'fallback-svc/fallback-model' });
    expect(resolveModelReference).toHaveBeenCalledTimes(1);
    expect(resolveModelReference).toHaveBeenCalledWith(ctx, 'fallback-svc/fallback-model');
  });

  it('falls back to the configured fallback when no bucket candidate is permitted', async () => {
    // Only the fallback model resolves; every other candidate returns null.
    vi.mocked(resolveModelReference).mockImplementation(async (_ctx, modelString) => {
      if (String(modelString) === 'fallback-svc/fallback-model') {
        return {
          service: { enabled: true, name: 'fallback-svc', options: {}, provider: 'test-provider' } as unknown as Model,
          modelId: 'fallback-model',
        };
      }
      return null;
    });

    const { ctx } = createContext(
      { content: 'fallback ok' },
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
      { aiApiVirtualModels: { findOne: () => Promise.resolve(VIRTUAL_MODEL_ROW) } },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(200);
    expect(ctx.state.aiApiRoutingReason).toBe('fallback');
    expect(ctx.state.aiApiLlmBilling).toMatchObject({
      resolution: { service: 'fallback-svc', model: 'fallback-model' },
    });
  });

  it('does not bypass the caller scope through the fallback model', async () => {
    const restrictedGroup = {
      id: 2,
      name: 'Restricted',
      isDefault: true,
      allowedLlmServices: ['other-svc'],
      allowAllModels: true,
    };
    const { ctx } = createContext(
      { content: '' },
      { model: 'auto', messages: [{ role: 'user', content: 'Hello' }] },
      {
        aiApiVirtualModels: { findOne: () => Promise.resolve(VIRTUAL_MODEL_ROW) },
        aiApiUsageGroups: { findOne: () => Promise.resolve(restrictedGroup) },
      },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(403);
    expect(ctx.body).toMatchObject({ error: { code: 'model_not_available' } });
    expect(ctx.state.aiApiLlmBilling).toBeUndefined();
  });

  it('passes through non-virtual models unchanged', async () => {
    const { ctx } = createContext(
      { content: 'direct' },
      {
        model: 'direct-svc/direct-model',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      },
      {
        aiApiVirtualModels: { findOne: () => Promise.resolve(null) },
        aiApiUsageGroups: {
          findOne: () =>
            Promise.resolve({
              id: 1,
              name: 'Default',
              isDefault: true,
              allowedLlmServices: ['direct-svc'],
              allowAllModels: true,
            }),
        },
      },
    );

    await handleChatCompletions(ctx, {} as PluginAiApiServer);

    if (ctx.status !== 200)
      throw new Error(`non-virtual test expected 200, got ${ctx.status}: ${JSON.stringify(ctx.body)}`);
    expect(ctx.state.aiApiVirtualModel).toBeUndefined();
    expect(ctx.state.aiApiRoutingReason).toBeUndefined();
    expect(ctx.state.aiApiLlmBilling).toMatchObject({
      resolution: { service: 'direct-svc', model: 'direct-model' },
    });
  });

  it('does not expose an alias whose fallback model is outside the caller scope', async () => {
    const { ctx } = createContext(
      { content: '' },
      {},
      { aiApiVirtualModels: { find: () => Promise.resolve([VIRTUAL_MODEL_ROW]) } },
    );
    const scope = {
      groupId: 1,
      allowedServices: ['other-svc'],
      allowAllModels: true,
      allowedModels: new Set<string>(),
      lookupFailed: false,
    };

    await expect(listAccessibleVirtualModels(ctx, scope, [])).resolves.toEqual([]);
  });
});
