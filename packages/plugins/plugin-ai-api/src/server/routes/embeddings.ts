/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { toOpenAIError, toOpenAIEmbeddingsResponse } from '../utils/openai-format';
import { resolveModelString } from '../utils/resolve-service';
import type PluginAiApiServer from '../plugin';

/**
 * POST /api/ai-llm/v1/embeddings
 *
 * OpenAI-compatible embeddings endpoint.
 *
 * Supported providers (those with an `embedding` field in LLMProviderMeta):
 *   - openai            → OpenAiEmbeddingProvider
 *   - openai-completions → OpenAiEmbeddingProvider
 *   - dashscope         → DashscopeEmbeddingProvider
 *   - google-genai      → GoogleGenAIEmbeddingProvider
 *   - ollama            → OllamaEmbeddingProvider
 *
 * Not supported: anthropic, deepseek, kimi (no embedding provider registered).
 *
 * Limitations:
 * - encoding_format 'base64' is not supported (always returns float arrays)
 * - Token counts always return 0 (LangChain embeddings API doesn't expose this)
 * - Token array input (integer[]) is not supported, only string input
 */
export async function handleEmbeddings(ctx: Context, plugin: PluginAiApiServer) {
  const body = ctx.request.body as any;

  // ─── Validate ────────────────────────────────────────────────────────────
  if (!body?.model) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'model' is required", 'invalid_request_error', 'missing_model');
    return;
  }

  if (body.input === undefined || body.input === null) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'input' is required", 'invalid_request_error', 'missing_input');
    return;
  }

  if (body.encoding_format === 'base64') {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      "encoding_format 'base64' is not supported. Use 'float' (default) or omit the parameter.",
      'invalid_request_error',
      'unsupported_encoding_format',
    );
    return;
  }

  // ─── Normalize input to string[] ─────────────────────────────────────────
  let inputs: string[];
  if (typeof body.input === 'string') {
    inputs = [body.input];
  } else if (Array.isArray(body.input)) {
    if (body.input.length === 0) {
      ctx.status = 400;
      ctx.body = toOpenAIError(400, "'input' array must not be empty", 'invalid_request_error');
      return;
    }
    if (typeof body.input[0] === 'number') {
      ctx.status = 400;
      ctx.body = toOpenAIError(
        400,
        'Token array input is not supported. Please provide string input.',
        'invalid_request_error',
        'unsupported_input_type',
      );
      return;
    }
    inputs = body.input as string[];
  } else {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'input' must be a string or array of strings", 'invalid_request_error');
    return;
  }

  // ─── Resolve model ────────────────────────────────────────────────────────
  const resolved = await resolveModelString(ctx, body.model);
  if (!resolved) {
    ctx.status = 404;
    ctx.body = toOpenAIError(
      404,
      `Could not resolve model '${body.model}'. Use GET /v1/models to list available models.`,
      'invalid_request_error',
      'model_not_found',
    );
    return;
  }

  const { service, modelId } = resolved;

  if (service.enabled === false) {
    ctx.status = 404;
    ctx.body = toOpenAIError(
      404,
      `LLM service '${service.title || service.name}' is disabled`,
      'invalid_request_error',
      'model_not_found',
    );
    return;
  }

  // ─── Check service whitelist ──────────────────────────────────────────────
  try {
    const config = await ctx.db.getRepository('aiApiConfig').findOne();
    if (config?.enabledLlmServices?.length) {
      const allowed = config.enabledLlmServices.some((s: string) => s === service.name || s === service.title);
      if (!allowed) {
        ctx.status = 403;
        ctx.body = toOpenAIError(
          403,
          `LLM service '${service.title || service.name}' is not enabled for API access`,
          'invalid_request_error',
          'model_not_available',
        );
        return;
      }
    }
  } catch {
    // Config read failure: fail open
  }

  // ─── Get embedding provider ───────────────────────────────────────────────
  const aiPlugin = ctx.app.pm.get('ai') as any;
  if (!aiPlugin) {
    ctx.status = 500;
    ctx.body = toOpenAIError(500, 'AI plugin not available', 'server_error');
    return;
  }

  const providerMeta = aiPlugin.aiManager.llmProviders.get(service.provider);
  if (!providerMeta) {
    ctx.status = 500;
    ctx.body = toOpenAIError(500, `Provider '${service.provider}' not registered`, 'server_error');
    return;
  }

  // providerMeta.embedding is the EmbeddingProvider constructor (if supported by this provider)
  if (!providerMeta.embedding) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `Provider '${providerMeta.title || service.provider}' does not support embeddings. ` +
        `Embedding-capable providers: openai, openai-completions, dashscope, google-genai, ollama.`,
      'invalid_request_error',
      'model_not_supported',
    );
    return;
  }

  try {
    // ─── Instantiate and call the embedding provider ──────────────────────
    const EmbeddingClass = providerMeta.embedding;
    const embeddingProvider = new EmbeddingClass({
      app: ctx.app,
      serviceOptions: service.options, // Contains apiKey, baseURL, etc.
      modelOptions: { model: modelId }, // The specific embedding model
    });

    // createEmbedding() returns a LangChain EmbeddingsInterface.
    // embedDocuments() accepts string[] and returns number[][] (one vector per input).
    const embeddingModel = embeddingProvider.createEmbedding();
    const vectors: number[][] = await embeddingModel.embedDocuments(inputs);

    ctx.status = 200;
    ctx.set('Content-Type', 'application/json');
    ctx.body = toOpenAIEmbeddingsResponse({
      model: body.model,
      embeddings: vectors,
      // LangChain's EmbeddingsInterface does not expose token counts.
      promptTokens: null,
    });
  } catch (err) {
    ctx.log.error('AI API embeddings error:', err);
    if (!ctx.res.headersSent) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, err.message || 'Failed to generate embeddings', 'server_error');
    }
  }
}
