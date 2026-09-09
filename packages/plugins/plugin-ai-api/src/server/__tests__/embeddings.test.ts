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
import { handleEmbeddings } from '../routes/embeddings';
import { resolveModelString, resolveModelReference } from '../utils/resolve-service';
import { resolveVirtualModel } from '../utils/virtual-models';
import { finalizeLlmBilling, AiApiQuotaError, prepareLlmBilling } from '../billing';

vi.mock('../utils/resolve-service', () => ({
  resolveModelString: vi.fn(),
  resolveModelReference: vi.fn(),
}));
vi.mock('../utils/virtual-models', () => ({
  resolveVirtualModel: vi.fn().mockResolvedValue(null),
  respondVirtualModelUnavailable: vi.fn(),
}));
vi.mock('../utils/user-permissions', () => ({
  enforceModelAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock('../utils/request-cache', () => ({
  getAiApiConfig: vi.fn().mockResolvedValue({ enabledLlmServices: [] }),
}));
vi.mock('../usage', () => ({
  setAiApiUsageResult: vi.fn().mockReturnValue({
    prompt_tokens: 10,
    completion_tokens: 0,
    total_tokens: 10,
  }),
}));
vi.mock('../billing', () => ({
  AiApiQuotaError: class extends Error {
    code = 'quota_exceeded';
  },
  markLlmProviderAttempted: vi.fn(),
  prepareLlmBilling: vi.fn(),
  finalizeLlmBilling: vi.fn().mockResolvedValue(undefined),
}));

// handleEmbeddings reads service fields as direct properties (service.enabled, service.provider),
// so the mock must be a plain object, not a Sequelize-style { get() } wrapper.
function serviceModel(provider = 'test-provider') {
  return {
    name: 'test-service',
    title: 'Test Service',
    enabled: true,
    provider,
    options: {},
  };
}

function createContext(requestBody: Record<string, unknown>) {
  const embeddingModel = {
    embedDocuments: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  };
  class EmbeddingProvider {
    createEmbedding() {
      return embeddingModel;
    }
  }
  class TestProvider {
    embedding = EmbeddingProvider;
    provider = TestProvider;
    createModel() {
      return { modelKwargs: {} };
    }
  }

  vi.mocked(resolveModelString).mockResolvedValue({
    service: serviceModel() as never,
    modelId: 'test-model',
  });

  const ctx = {
    app: {
      pm: {
        get: vi.fn().mockReturnValue({
          aiManager: {
            llmProviders: new Map([['test-provider', { provider: TestProvider, embedding: EmbeddingProvider }]]),
          },
        }),
      },
    },
    request: { body: requestBody },
    state: { currentUser: { id: 42 } },
    log: { error: vi.fn(), warn: vi.fn() },
    res: { headersSent: false },
    set: vi.fn(),
  } as unknown as Context;
  return { ctx, embeddingModel };
}

describe('handleEmbeddings error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveVirtualModel).mockResolvedValue(null);
    vi.mocked(prepareLlmBilling).mockResolvedValue(undefined);
  });

  it('returns 429 when quota is exceeded (prepareLlmBilling throws AiApiQuotaError)', async () => {
    const { ctx } = createContext({ model: 'test-service/test-model', input: 'Hello' });
    vi.mocked(prepareLlmBilling).mockRejectedValueOnce(new AiApiQuotaError('quota exceeded'));

    await handleEmbeddings(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(429);
    expect(ctx.body).toMatchObject({
      error: { type: 'quota_error', code: 'quota_exceeded' },
    });
    expect(ctx.set).toHaveBeenCalledWith('X-RateLimit-Reason', 'quota_exceeded');
  });

  it('returns 500 when the embedding provider throws', async () => {
    const { ctx } = createContext({ model: 'test-service/test-model', input: 'Hello' });

    class FailingEmbeddingProvider {
      createEmbedding() {
        return {
          embedDocuments: vi.fn().mockRejectedValue(new Error('provider exploded')),
        };
      }
    }
    class FailingProvider {
      embedding = FailingEmbeddingProvider;
      provider = FailingProvider;
      createModel() {
        return { modelKwargs: {} };
      }
    }
    vi.mocked(ctx.app.pm.get as ReturnType<typeof vi.fn>).mockReturnValue({
      aiManager: {
        llmProviders: new Map([['test-provider', { provider: FailingProvider, embedding: FailingEmbeddingProvider }]]),
      },
    });

    await handleEmbeddings(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(500);
    expect(ctx.body).toMatchObject({
      error: { type: 'server_error', message: 'provider exploded' },
    });
  });

  it('returns 500 when the error is not an Error instance (regression for getErrorMessage)', async () => {
    const { ctx } = createContext({ model: 'test-service/test-model', input: 'Hello' });

    class ThrowingEmbeddingProvider {
      createEmbedding() {
        return {
          embedDocuments: vi.fn().mockRejectedValue('raw string error'),
        };
      }
    }
    class ThrowingProvider {
      embedding = ThrowingEmbeddingProvider;
      provider = ThrowingProvider;
      createModel() {
        return { modelKwargs: {} };
      }
    }
    vi.mocked(ctx.app.pm.get as ReturnType<typeof vi.fn>).mockReturnValue({
      aiManager: {
        llmProviders: new Map([
          ['test-provider', { provider: ThrowingProvider, embedding: ThrowingEmbeddingProvider }],
        ]),
      },
    });

    await handleEmbeddings(ctx, {} as PluginAiApiServer);

    expect(ctx.status).toBe(500);
    expect(ctx.body).toMatchObject({
      error: { type: 'server_error', message: 'Failed to generate embeddings' },
    });
  });
});
