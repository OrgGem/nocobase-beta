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
import { isStreamingRequested } from '../utils/streaming';
import { getAiApiConfig } from '../utils/request-cache';
import type PluginAiApiServer from '../plugin';
import { finalizeLlmBilling } from '../billing';
import { finishAiApiObservation, startAiApiObservation } from '../utils/app-observability';

const API_PREFIX = '/api/ai-llm/v1';

/** Shared so the plugin can disable the core body parser for exactly these routes. */
export const AI_LLM_PREFIX = API_PREFIX;

type DataWrappingContext = Context & { withoutDataWrapping?: boolean };

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
 * - Sliding window rate limiting (enforces rateLimitPerMinute from the user's usage group)
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
    (ctx as DataWrappingContext).withoutDataWrapping = true;

    // Parse the sub-path after prefix
    const subPath = path.substring(API_PREFIX.length);

    // ─── CORS — applies to all requests, including preflight ──────────────
    // '*' is safe here because all endpoints require Bearer token auth.
    // Browsers cannot send cookies to '*' origins, but Authorization headers work fine.
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-AI-Mode, X-Timezone, X-Locale');
    ctx.set(
      'Access-Control-Expose-Headers',
      'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reason, Retry-After',
    );
    ctx.set('Access-Control-Max-Age', '86400');

    // ─── OPTIONS preflight — return immediately after CORS headers ────────
    if (method === 'OPTIONS') {
      ctx.status = 204;
      return;
    }

    // ─── Request ID — set before any response ─────────────────────────────
    const requestId = `req-${crypto.randomBytes(12).toString('hex')}`;
    ctx.set('X-Request-Id', requestId);

    // ─── Authenticate ─────────────────────────────────────────────────────
    // Runs before the body is read: buffering a multi-megabyte payload for an
    // anonymous caller would let unauthenticated traffic pin memory.
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

    // ─── Parse body for POST requests if not already parsed ───────────────
    if (method === 'POST' && !ctx.request.body) {
      const maxBodyBytes = await resolveMaxBodyBytes(ctx);
      const declaredLength = Number(ctx.get('Content-Length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        respondBodyTooLarge(ctx, maxBodyBytes);
        logRequest(ctx, requestId, '-', 'body_too_large', 0);
        return;
      }
      try {
        const rawBody = await getRawBody(ctx, maxBodyBytes);
        ctx.request.body = JSON.parse(rawBody);
      } catch (bodyErr: unknown) {
        const tooLarge =
          bodyErr && typeof bodyErr === 'object' && 'statusCode' in bodyErr && bodyErr.statusCode === 413;
        if (tooLarge) {
          respondBodyTooLarge(ctx, maxBodyBytes);
          logRequest(ctx, requestId, '-', 'body_too_large', 0);
          return;
        }
        ctx.status = 400;
        ctx.body = toOpenAIError(400, 'Invalid JSON in request body', 'invalid_request_error');
        return;
      }
    }

    // ─── Route matching ───────────────────────────────────────────────────
    const requestBody = (ctx.request.body || {}) as Record<string, unknown>;
    const model = requestBody.model === undefined || requestBody.model === null ? '-' : String(requestBody.model);
    const isUsageEndpoint =
      method === 'POST' && (subPath === '/chat/completions' || subPath === '/completions' || subPath === '/embeddings');
    const isStreamingEndpoint = method === 'POST' && (subPath === '/chat/completions' || subPath === '/completions');
    const resolvedMode = isUsageEndpoint ? await resolveMode(ctx) : 'llm';
    const streaming = isStreamingEndpoint && isStreamingRequested(requestBody.stream);
    if (streaming) {
      const streamOptions = requestBody.stream_options;
      ctx.request.body = {
        ...requestBody,
        stream_options: {
          ...(streamOptions && typeof streamOptions === 'object' ? streamOptions : {}),
          include_usage: true,
        },
      };
    }
    const t0 = Date.now();
    if (isUsageEndpoint) {
      const service =
        subPath === '/embeddings'
          ? 'llm.embedding'
          : resolvedMode === 'agent'
            ? 'llm.agent'
            : subPath === '/completions'
              ? 'llm.completion'
              : 'llm.chat';
      startAiApiObservation(ctx, {
        service,
        operation: subPath,
        streaming,
        model: model === '-' ? undefined : model,
        mode: resolvedMode,
      });
    }
    let usageId: unknown;
    try {
      usageId = isUsageEndpoint
        ? await startUsageRecord(ctx, requestId, subPath, model, streaming, resolvedMode)
        : undefined;
    } catch (usageError) {
      ctx.log.error('AI API usage record could not be created:', usageError);
    }

    try {
      // POST /v1/chat/completions — route based on mode
      if (method === 'POST' && subPath === '/chat/completions') {
        await (resolvedMode === 'agent' ? handleAgentCompletions(ctx, plugin) : handleChatCompletions(ctx, plugin));
        logRequest(
          ctx,
          requestId,
          model,
          ctx.state.aiApiStreamResult?.succeeded === false ? 'error' : 'ok',
          Date.now() - t0,
        );
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
        const completionsMode = resolvedMode;
        if (completionsMode === 'agent') {
          // Convert legacy prompt → messages format for agent handler
          const reqBody = (ctx.request.body || {}) as Record<string, unknown>;
          if (reqBody.prompt !== undefined) {
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
        logRequest(
          ctx,
          requestId,
          model,
          ctx.state.aiApiStreamResult?.succeeded === false ? 'error' : 'ok',
          Date.now() - t0,
        );
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
        ctx.body = toOpenAIError(
          500,
          err instanceof Error && err.message ? err.message : 'Internal server error',
          'server_error',
        );
      }
    } finally {
      if (usageId !== undefined) {
        try {
          await finishUsageRecord(ctx, usageId, t0, ctx.status >= 200 && ctx.status < 400 ? 'succeeded' : 'failed');
        } catch (usageError) {
          ctx.log.error('AI API usage record could not be finalized:', usageError);
        }
      } else if (ctx.state.aiApiLlmBilling) {
        try {
          const usageResult = ctx.state.aiApiUsageResult;
          const providerUsage = usageResult?.source === 'provider' ? usageResult.usage : undefined;
          const succeeded = ctx.state.aiApiStreamResult
            ? ctx.state.aiApiStreamResult.succeeded
            : ctx.status >= 200 && ctx.status < 400;
          await finalizeLlmBilling(ctx, providerUsage, succeeded);
        } catch (billingError) {
          ctx.log.error('AI API quota reservation could not be finalized:', billingError);
        }
      }
      if (isUsageEndpoint) {
        const streamResult = ctx.state.aiApiStreamResult;
        finishAiApiObservation(ctx, {
          status:
            streamResult?.errorCode === 'client_disconnected'
              ? 'cancelled'
              : streamResult
                ? streamResult.succeeded
                  ? 'succeeded'
                  : 'failed'
                : ctx.status >= 200 && ctx.status < 400
                  ? 'succeeded'
                  : ctx.status >= 500
                    ? 'failed'
                    : 'rejected',
          errorCode: streamResult?.errorCode,
        });
      }
    }
  };
}

/** Body size cap used when aiApiConfig has no usable maxRequestBodyMb. */
const DEFAULT_MAX_BODY_MB = 10;

/**
 * Upper bound an admin can configure.
 *
 * The gateway buffers the whole payload in memory (raw chunks, the decoded
 * string, and the parsed object all coexist briefly), so an unbounded value
 * would turn a config typo into an out-of-memory risk.
 */
export const MAX_REQUEST_BODY_MB_LIMIT = 100;

/** Clamp a configured megabyte value into the supported range. */
export function normalizeMaxRequestBodyMb(value: unknown): number {
  const mb = Number(value);
  if (!Number.isSafeInteger(mb) || mb <= 0) return DEFAULT_MAX_BODY_MB;
  return Math.min(mb, MAX_REQUEST_BODY_MB_LIMIT);
}

async function resolveMaxBodyBytes(ctx: Context): Promise<number> {
  let configuredMb: unknown;
  try {
    const config = await getAiApiConfig(ctx);
    configuredMb = config?.get('maxRequestBodyMb');
  } catch (err) {
    ctx.log?.warn?.('AI API: could not read maxRequestBodyMb, using default:', err);
  }
  return normalizeMaxRequestBodyMb(configuredMb) * 1024 * 1024;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function respondBodyTooLarge(ctx: Context, maxBodyBytes: number): void {
  ctx.status = 413;
  ctx.body = toOpenAIError(
    413,
    `Request body too large (max ${formatMb(maxBodyBytes)}). ` +
      `Inline base64 images inflate payloads by ~33%; raise "Max request body size" in Settings → AI API Gateway if needed.`,
    'invalid_request_error',
  );
}

/**
 * Read the raw request body.
 *
 * The plugin disables the core koa-bodyparser for these routes (see plugin.ts),
 * so this cap is the one that actually governs gateway payload size.
 * Rejects with a 413-style error once maxBodyBytes is exceeded.
 *
 * Exported so tests can drive the real implementation over a live socket rather
 * than a copy that cannot catch a regression here.
 */
export function getRawBody(ctx: Pick<Context, 'req'>, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let aborted = false;

    ctx.req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      byteCount += chunk.length;
      if (byteCount > maxBodyBytes) {
        // Drop what we buffered and drain the rest instead of destroying the
        // socket: ctx.req and the response share one connection, so destroying
        // it replaces our 413 JSON with an ECONNRESET on the client.
        aborted = true;
        chunks.length = 0;
        ctx.req.resume();
        reject(Object.assign(new Error(`Request body too large (max ${formatMb(maxBodyBytes)})`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    // Decode once at the end: a multi-byte UTF-8 character can straddle a chunk
    // boundary, and per-chunk toString() would corrupt it.
    ctx.req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
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
    const config = await getAiApiConfig(ctx);
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
