/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import crypto from 'crypto';
import { Context, Next } from '@nocobase/actions';
import { authenticateBearer } from './auth';
import { handleListModels, handleGetModel } from './models';
import { handleChatCompletions } from './chat-completions';
import { handleCompletions } from './completions';
import { handleAgentCompletions } from './agent-completions';
import { handleEmbeddings } from './embeddings';
import { toOpenAIError } from '../utils/openai-format';
import { createRateLimitMiddleware } from '../middleware/rate-limit';
import { checkRolePermission } from '../middleware/role-permission';
import { startUsageRecord, finishUsageRecord } from '../usage';
import type PluginAiApiServer from '../plugin';

const API_PREFIX = '/api/ai-llm/v1';

/**
 * Main Koa middleware router for OpenAI-compatible endpoints.
 *
 * Intercepts all requests to /api/ai-llm/v1/* and routes them
 * to the appropriate handler. Runs before NocoBase's resourcer
 * so the URL paths follow OpenAI convention.
 *
 * Features:
 * - CORS support (Access-Control-Allow-Origin: *)
 * - OPTIONS preflight handling (204)
 * - X-Request-Id on every response
 * - Bearer token authentication
 * - Sliding window rate limiting (enforces rateLimitPerMinute from config)
 * - Structured request logging via app.logger
 *
 * Supported endpoints:
 *   POST /v1/chat/completions  — OpenAI chat completions (LLM or agent mode)
 *   POST /v1/completions       — Legacy text completions (LiteLLM compat)
 *   POST /v1/embeddings        — OpenAI embeddings
 *   GET  /v1/models            — List available models
 *   GET  /v1/models/:id        — Get a single model
 *   DELETE /v1/models/:id      — Not implemented (501 stub)
 */
export function createAiLlmRouter(plugin: PluginAiApiServer) {
  const checkRateLimit = createRateLimitMiddleware(plugin.rateLimiter);

  return async (ctx: Context, next: Next) => {
    const { path, method } = ctx;

    // Only handle our prefix
    if (!path.startsWith(API_PREFIX)) {
      return next();
    }

    // Prevent NocoBase's dataWrapping middleware from wrapping OpenAI-format responses
    // in an extra {"data": ...} envelope, which breaks OpenAI-compatible clients like n8n.
    (ctx as any).withoutDataWrapping = true;

    // Parse the sub-path after prefix
    const subPath = path.substring(API_PREFIX.length);

    // ─── CORS — applies to all requests, including preflight ──────────────
    // '*' is safe here because all endpoints require Bearer token auth.
    // Browsers cannot send cookies to '*' origins, but Authorization headers work fine.
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-AI-Mode, X-Timezone, X-Locale');
    ctx.set('Access-Control-Expose-Headers', 'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After');
    ctx.set('Access-Control-Max-Age', '86400');

    // ─── OPTIONS preflight — return immediately after CORS headers ────────
    if (method === 'OPTIONS') {
      ctx.status = 204;
      return;
    }

    // ─── Request ID — set before any response ─────────────────────────────
    const requestId = `req-${crypto.randomBytes(12).toString('hex')}`;
    ctx.set('X-Request-Id', requestId);

    // ─── Parse body for POST requests if not already parsed ───────────────
    if (method === 'POST' && !ctx.request.body) {
      try {
        const rawBody = await getRawBody(ctx);
        ctx.request.body = JSON.parse(rawBody);
      } catch (bodyErr: any) {
        const status = bodyErr?.statusCode === 413 ? 413 : 400;
        const message = status === 413 ? 'Request body too large (max 10 MB)' : 'Invalid JSON in request body';
        ctx.status = status;
        ctx.body = toOpenAIError(status, message, 'invalid_request_error');
        return;
      }
    }

    // ─── Authenticate ─────────────────────────────────────────────────────
    const isAuth = await authenticateBearer(ctx);
    if (!isAuth) {
      logRequest(ctx, requestId, '-', 'auth_failed', 0);
      return;
    }

    // ─── Role permission check ────────────────────────────────────────────
    const permitted = await checkRolePermission(ctx);
    if (!permitted) {
      logRequest(ctx, requestId, '-', 'forbidden', 0);
      return;
    }

    // ─── Rate limiting ────────────────────────────────────────────────────
    const allowed = await checkRateLimit(ctx);
    if (!allowed) {
      logRequest(ctx, requestId, '-', 'rate_limited', 0);
      return;
    }

    // ─── Route matching ───────────────────────────────────────────────────
    const model = (ctx.request.body as any)?.model ?? '-';
    const t0 = Date.now();
    let usageId: unknown;
    try {
      usageId = await startUsageRecord(
        ctx,
        requestId,
        subPath,
        String(model),
        Boolean((ctx.request.body as any)?.stream),
      );
    } catch (usageError) {
      ctx.log.error('AI API usage record could not be created:', usageError);
    }

    try {
      // POST /v1/chat/completions — route based on mode
      if (method === 'POST' && subPath === '/chat/completions') {
        const mode = await resolveMode(ctx);
        await (mode === 'agent' ? handleAgentCompletions(ctx, plugin) : handleChatCompletions(ctx, plugin));
        logRequest(ctx, requestId, model, 'ok', Date.now() - t0);
        return;
      }

      // POST /v1/embeddings
      if (method === 'POST' && subPath === '/embeddings') {
        await handleEmbeddings(ctx, plugin);
        logRequest(ctx, requestId, model, 'ok', Date.now() - t0);
        return;
      }

      // POST /v1/completions (legacy text completions — used by LiteLLM)
      if (method === 'POST' && subPath === '/completions') {
        const completionsMode = await resolveMode(ctx);
        if (completionsMode === 'agent') {
          // Convert legacy prompt → messages format for agent handler
          const reqBody = ctx.request.body as any;
          if (reqBody?.prompt !== undefined) {
            const prompt =
              typeof reqBody.prompt === 'string'
                ? reqBody.prompt
                : Array.isArray(reqBody.prompt)
                  ? reqBody.prompt.join('\n')
                  : String(reqBody.prompt);
            ctx.request.body = { ...reqBody, messages: [{ role: 'user', content: prompt }] };
          }
          await handleAgentCompletions(ctx, plugin);
        } else {
          await handleCompletions(ctx, plugin);
        }
        logRequest(ctx, requestId, model, 'ok', Date.now() - t0);
        return;
      }

      // GET /v1/models
      if (method === 'GET' && subPath === '/models') {
        await handleListModels(ctx, plugin);
        logRequest(ctx, requestId, '-', 'ok', Date.now() - t0);
        return;
      }

      // GET /v1/models/:model (model can contain '/' for service/model format)
      if (method === 'GET' && subPath.startsWith('/models/')) {
        const modelId = subPath.substring('/models/'.length);
        if (modelId) {
          await handleGetModel(ctx, decodeURIComponent(modelId), plugin);
          logRequest(ctx, requestId, modelId, 'ok', Date.now() - t0);
          return;
        }
      }

      // DELETE /v1/models/:model — stub (OpenAI fine-tune model deletion, not applicable here)
      if (method === 'DELETE' && subPath.startsWith('/models/')) {
        ctx.status = 501;
        ctx.body = toOpenAIError(
          501,
          'Model deletion is not supported by this API gateway. ' +
            'Use the NocoBase admin panel to manage LLM services.',
          'invalid_request_error',
          'not_implemented',
        );
        logRequest(ctx, requestId, '-', 'not_implemented', Date.now() - t0);
        return;
      }

      // ─── Unsupported endpoint ──────────────────────────────────────────
      ctx.status = 404;
      ctx.body = toOpenAIError(
        404,
        `Unknown endpoint: ${method} ${path}. ` +
          `Supported: POST /v1/chat/completions, POST /v1/completions, POST /v1/embeddings, GET /v1/models`,
        'invalid_request_error',
        'unknown_url',
      );
      logRequest(ctx, requestId, '-', 'not_found', Date.now() - t0);
    } catch (err) {
      ctx.log.error('AI API router error:', err);
      logRequest(ctx, requestId, model, 'error', Date.now() - t0);
      if (!ctx.res.headersSent) {
        ctx.status = 500;
        ctx.body = toOpenAIError(500, err.message || 'Internal server error', 'server_error');
      }
    } finally {
      if (usageId !== undefined) {
        try {
          await finishUsageRecord(ctx, usageId, t0, ctx.status >= 200 && ctx.status < 400 ? 'succeeded' : 'failed');
        } catch (usageError) {
          ctx.log.error('AI API usage record could not be finalized:', usageError);
        }
      }
    }
  };
}

/** Maximum allowed request body size (10 MB) to prevent OOM DoS attacks. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read raw body from request stream (fallback if bodyparser didn't handle it).
 * Rejects with a 413-style error if the body exceeds MAX_BODY_BYTES.
 */
function getRawBody(ctx: Context): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let byteCount = 0;

    ctx.req.on('data', (chunk: Buffer) => {
      byteCount += chunk.length;
      if (byteCount > MAX_BODY_BYTES) {
        ctx.req.destroy();
        reject(Object.assign(new Error('Request body too large (max 10 MB)'), { statusCode: 413 }));
        return;
      }
      body += chunk.toString();
    });
    ctx.req.on('end', () => resolve(body));
    ctx.req.on('error', reject);
  });
}

/**
 * Determine the API mode for a request.
 *
 * Priority:
 * 1. X-AI-Mode request header ('llm' or 'agent')
 * 2. Config `mode` field from aiApiConfig
 * 3. Default: 'llm'
 */
async function resolveMode(ctx: Context): Promise<'llm' | 'agent'> {
  const headerMode = ctx.get('X-AI-Mode')?.toLowerCase();
  if (headerMode === 'agent' || headerMode === 'llm') {
    ctx.app.logger?.info(`[ai-api] Mode resolved from header: ${headerMode}`);
    return headerMode;
  }

  try {
    const config = await ctx.db.getRepository('aiApiConfig').findOne();
    if (config) {
      const dbMode = config.get('mode') || config.mode;
      if (dbMode === 'agent' || dbMode === 'llm') {
        ctx.app.logger?.info(`[ai-api] Mode resolved from DB config: ${dbMode}`);
        return dbMode as 'llm' | 'agent';
      }
    }
  } catch (err) {
    ctx.app.logger?.error('[ai-api] Failed to get mode from config:', err);
    // Ignore config errors — default to llm
  }

  ctx.app.logger?.info(`[ai-api] Mode fallback to default: llm`);
  return 'llm';
}

/**
 * Write a structured log line for every handled request.
 */
function logRequest(ctx: Context, requestId: string, model: string, status: string, durationMs: number): void {
  const userId = ctx.state.currentUser?.id ?? 'anon';
  ctx.app.logger?.info(
    `[ai-api] ${ctx.method} ${ctx.path} requestId=${requestId} userId=${userId} ` +
      `model=${model} status=${status} duration=${durationMs}ms`,
  );
}
