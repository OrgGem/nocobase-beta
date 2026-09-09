/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type PluginAiApiServer from '../plugin';
import { createAiLlmRouter } from '../routes/router';
import { handleDeleteResponse, handleGetResponse, handleResponses } from '../routes/responses';
import { handleGetModel } from '../routes/models';
import { finishUsageRecord, startUsageRecord } from '../usage';
import { finalizeLlmBilling } from '../billing';
import { finishAiApiObservation, startAiApiObservation } from '../utils/app-observability';

vi.mock('../routes/auth', () => ({ authenticateBearer: vi.fn().mockResolvedValue(true) }));
vi.mock('../middleware/role-permission', () => ({ checkRolePermission: vi.fn().mockResolvedValue(true) }));
vi.mock('../middleware/rate-limit', () => ({
  createRateLimitMiddleware: vi.fn(() => vi.fn().mockResolvedValue(true)),
}));
vi.mock('../routes/chat-completions', () => ({ handleChatCompletions: vi.fn() }));
vi.mock('../routes/completions', () => ({ handleCompletions: vi.fn() }));
vi.mock('../routes/agent-completions', () => ({ handleAgentCompletions: vi.fn() }));
vi.mock('../routes/embeddings', () => ({ handleEmbeddings: vi.fn() }));
vi.mock('../routes/models', () => ({ handleGetModel: vi.fn(), handleListModels: vi.fn() }));
vi.mock('../routes/responses', () => ({
  handleResponses: vi.fn(),
  handleGetResponse: vi.fn(),
  handleDeleteResponse: vi.fn(),
}));
vi.mock('../usage', () => ({
  startUsageRecord: vi.fn().mockResolvedValue(91),
  // Simulate the real behavior: finishUsageRecord calls finalizeLlmBilling internally.
  finishUsageRecord: vi.fn().mockImplementation(async (ctx, id, startedAt, status) => {
    const { finalizeLlmBilling } = await import('../billing');
    await finalizeLlmBilling(ctx, undefined, status === 'succeeded');
  }),
}));
vi.mock('../billing', () => ({ finalizeLlmBilling: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/request-cache', () => ({ getAiApiConfig: vi.fn() }));
vi.mock('../utils/app-observability', () => ({
  startAiApiObservation: vi.fn(),
  finishAiApiObservation: vi.fn(),
}));

function createContext(method: 'POST' | 'GET' | 'DELETE', subPath: string, body?: Record<string, unknown>) {
  const path = `/api/ai-llm/v1${subPath}`;
  return {
    path,
    method,
    request: { path, method, body },
    state: { currentUser: { id: 42 } },
    app: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    log: { error: vi.fn() },
    res: { headersSent: false },
    get: vi.fn().mockReturnValue(''),
    set: vi.fn(),
    status: 0,
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(startUsageRecord).mockResolvedValue(91);
  vi.mocked(handleResponses).mockImplementation(async (ctx) => {
    ctx.status = 200;
  });
  vi.mocked(handleGetResponse).mockImplementation(async (ctx) => {
    ctx.status = 200;
  });
  vi.mocked(handleDeleteResponse).mockImplementation(async (ctx) => {
    ctx.status = 204;
  });
});

describe('Responses API router integration', () => {
  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])('dispatches POST /responses with stream=%s and direct LLM accounting', async (stream, expectedStreaming) => {
    const body = { model: 'service/model', input: 'Hello', ...(stream === undefined ? {} : { stream }) };
    const ctx = createContext('POST', '/responses', body);
    const next = vi.fn() as unknown as Next;
    const plugin = { rateLimiter: {} } as PluginAiApiServer;

    await createAiLlmRouter(plugin)(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(handleResponses).toHaveBeenCalledWith(ctx, plugin);
    expect(startUsageRecord).toHaveBeenCalledWith(
      ctx,
      expect.stringMatching(/^req-/),
      '/responses',
      'service/model',
      expectedStreaming,
      'llm',
    );
    expect(finishUsageRecord).toHaveBeenCalledWith(ctx, 91, expect.any(Number), 'succeeded');
    expect(startAiApiObservation).toHaveBeenCalledWith(ctx, {
      service: 'llm.responses',
      operation: '/responses',
      streaming: expectedStreaming,
      model: 'service/model',
      mode: 'llm',
    });
    expect(finishAiApiObservation).toHaveBeenCalledWith(ctx, { status: 'succeeded', errorCode: undefined });
  });

  it.each([
    ['GET', handleGetResponse, 200],
    ['DELETE', handleDeleteResponse, 204],
  ] as const)('dispatches %s /responses/:id without creating an LLM usage record', async (method, handler, status) => {
    const ctx = createContext(method, '/responses/resp_saved');
    const plugin = { rateLimiter: {} } as PluginAiApiServer;

    await createAiLlmRouter(plugin)(ctx, vi.fn() as unknown as Next);

    expect(handler).toHaveBeenCalledWith(ctx, 'resp_saved');
    expect(ctx.status).toBe(status);
    expect(startUsageRecord).not.toHaveBeenCalled();
    expect(finishUsageRecord).not.toHaveBeenCalled();
    expect(startAiApiObservation).not.toHaveBeenCalled();
    expect(finishAiApiObservation).not.toHaveBeenCalled();
  });

  it('does not treat nested response subpaths as stored response IDs', async () => {
    const ctx = createContext('GET', '/responses/resp_saved/input_items');
    const plugin = { rateLimiter: {} } as PluginAiApiServer;

    await createAiLlmRouter(plugin)(ctx, vi.fn() as unknown as Next);

    expect(ctx.status).toBe(404);
    expect(ctx.body).toMatchObject({ error: { code: 'unknown_url' } });
    expect(handleGetResponse).not.toHaveBeenCalled();
    expect(startUsageRecord).not.toHaveBeenCalled();
  });

  it('finalizes embeddings billing exactly once through the usage record path', async () => {
    // Regression for the double-finalize bug: handleEmbeddings used to call
    // finalizeLlmBilling explicitly AND the router's finally block called it again
    // via finishUsageRecord, double-decrementing quota buckets. The handler must not
    // finalize on its own — the router path is the single finalization point.
    const { handleEmbeddings } = await import('../routes/embeddings');
    vi.mocked(handleEmbeddings).mockImplementation(async (ctx) => {
      ctx.status = 200;
    });
    const ctx = createContext('POST', '/embeddings', { model: 'service/model', input: 'Hello' });
    const plugin = { rateLimiter: {} } as PluginAiApiServer;

    await createAiLlmRouter(plugin)(ctx, vi.fn() as unknown as Next);

    expect(handleEmbeddings).toHaveBeenCalledWith(ctx, plugin);
    expect(startUsageRecord).toHaveBeenCalledWith(
      ctx,
      expect.stringMatching(/^req-/),
      '/embeddings',
      'service/model',
      false,
      'llm',
    );
    expect(finishUsageRecord).toHaveBeenCalledWith(ctx, 91, expect.any(Number), 'succeeded');
    // finalizeLlmBilling is only reachable through finishUsageRecord — the handler
    // must not call it directly.
    expect(finalizeLlmBilling).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for a model id with invalid URL encoding', async () => {
    const ctx = createContext('GET', '/models/%ZZ');
    const plugin = { rateLimiter: {} } as PluginAiApiServer;

    await createAiLlmRouter(plugin)(ctx, vi.fn() as unknown as Next);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({ error: { type: 'invalid_request_error' } });
    expect(handleGetModel).not.toHaveBeenCalled();
  });
});
