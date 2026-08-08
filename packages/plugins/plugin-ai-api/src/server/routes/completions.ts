/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import {
  generateCompletionId,
  toOpenAIError,
  formatSSE,
  formatSSEDone,
  toOpenAIUsageChunk,
} from '../utils/openai-format';
import { resolveModelString } from '../utils/resolve-service';
import { enforceModelAccess } from '../utils/user-permissions';
import {
  createRequestAbortController,
  isClientDisconnected,
  isStreamingRequested,
  writeResponse,
} from '../utils/streaming';
import { extractProviderRequestId, normalizeUsage, setAiApiUsageResult, type Usage } from '../usage';
import type PluginAiApiServer from '../plugin';
import { AiApiQuotaError, markLlmProviderAttempted, prepareLlmBilling } from '../billing';
import { markAiApiFirstProviderOutput } from '../utils/app-observability';

/**
 * POST /api/ai-llm/v1/completions
 *
 * Handles legacy OpenAI text completions API.
 * Converts prompt to messages and delegates to the chat model.
 * Required by LiteLLM and other tools that test via legacy completions endpoint.
 */
export async function handleCompletions(ctx: Context, plugin: PluginAiApiServer) {
  const body = ctx.request.body as any;

  // ─── Validate request ───
  if (!body?.model) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'model' is required", 'invalid_request_error', 'missing_model');
    return;
  }

  if (!body?.prompt && body.prompt !== '') {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'prompt' is required", 'invalid_request_error', 'missing_prompt');
    return;
  }

  // ─── Reject unsupported n parameter ───
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `The 'n' parameter value ${body.n} is not supported. ` +
        `This API gateway always returns exactly one completion (n=1). Please omit 'n' or set it to 1.`,
      'invalid_request_error',
      'unsupported_parameter',
    );
    return;
  }

  const stream = isStreamingRequested(body.stream);

  // ─── Resolve model string against DB ───
  const resolved = await resolveModelString(ctx, body.model);
  if (!resolved) {
    ctx.status = 404;
    ctx.body = toOpenAIError(
      404,
      `Could not resolve model '${body.model}'. Format: 'serviceName/modelId'. Use GET /v1/models to see available models.`,
      'invalid_request_error',
      'model_not_found',
    );
    return;
  }

  const { service, modelId } = resolved;

  try {
    const aiPlugin = ctx.app.pm.get('ai') as any;
    if (!aiPlugin) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, 'AI plugin not available', 'server_error');
      return;
    }

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

    // ─── Check whitelist (global config ∩ per-user grant) ───
    const config = await ctx.db.getRepository('aiApiConfig').findOne();
    if (!(await enforceModelAccess(ctx, config?.enabledLlmServices, service, modelId))) {
      return;
    }

    // ─── Create LLM provider instance ───
    const providerMeta = aiPlugin.aiManager.llmProviders.get(service.provider);
    if (!providerMeta) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, `Provider '${service.provider}' not registered`, 'server_error');
      return;
    }

    await prepareLlmBilling(ctx, resolved);

    const modelOptions: Record<string, any> = {
      model: modelId,
      llmService: service.name,
    };

    if (body.temperature !== undefined) modelOptions.temperature = body.temperature;
    if (body.top_p !== undefined) modelOptions.topP = body.top_p;
    if (body.max_tokens !== undefined) modelOptions.maxTokens = body.max_tokens;
    if (body.stop !== undefined) modelOptions.stop = body.stop;

    const Provider = providerMeta.provider;
    const provider = new Provider({
      app: ctx.app,
      serviceOptions: service.options,
      modelOptions,
    });

    // ─── Convert prompt to message tuple ───
    const prompt =
      typeof body.prompt === 'string'
        ? body.prompt
        : Array.isArray(body.prompt)
          ? body.prompt.join('\n')
          : String(body.prompt);

    // Inject system prompt from AI Employee if configured
    const langchainMessages: [string, string][] = [];
    if (config?.defaultAiEmployee) {
      const employee = await ctx.db.getRepository('aiEmployees').findOne({
        filter: { username: config.defaultAiEmployee },
      });
      if (employee) {
        const systemPrompt = employee.about || employee.defaultPrompt || '';
        if (systemPrompt) {
          langchainMessages.push(['system', systemPrompt]);
        }
      }
    }
    langchainMessages.push(['human', prompt]);

    const completionId = generateCompletionId().replace('chatcmpl-', 'cmpl-');
    const chatModel = provider.createModel();
    markLlmProviderAttempted(ctx);

    if (stream) {
      await handleStreamingTextCompletion(
        ctx,
        chatModel,
        langchainMessages,
        completionId,
        body.model,
        body.stream_options,
      );
    } else {
      await handleNonStreamingTextCompletion(ctx, chatModel, langchainMessages, completionId, body.model);
    }
  } catch (err) {
    ctx.log.error('AI API completions error:', err);
    if (!ctx.res.headersSent) {
      const isQuotaError = err instanceof AiApiQuotaError;
      ctx.status = isQuotaError ? 429 : 500;
      if (isQuotaError) ctx.set('X-RateLimit-Reason', err.code);
      ctx.body = toOpenAIError(
        ctx.status,
        getErrorMessage(err, 'Internal server error'),
        isQuotaError ? 'quota_error' : 'server_error',
        isQuotaError ? err.code : undefined,
      );
    }
  }
}

// ─── Non-streaming text completion ───

async function handleNonStreamingTextCompletion(
  ctx: Context,
  chatModel: any,
  messages: [string, string][],
  completionId: string,
  modelName: string,
) {
  const result = await chatModel.invoke(messages);

  let text = '';
  if (typeof result.content === 'string') {
    text = result.content;
  } else if (Array.isArray(result.content)) {
    const textPart = result.content.find((c: any) => c.type === 'text');
    text = textPart?.text || JSON.stringify(result.content);
  }

  const usage = setAiApiUsageResult(ctx, result.usage_metadata, {
    gatewayResponseId: completionId,
    providerRequestId: extractProviderRequestId(result),
  });

  ctx.status = 200;
  ctx.body = {
    id: completionId,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    system_fingerprint: null,
    choices: [
      {
        text,
        index: 0,
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ─── Streaming text completion ───

async function handleStreamingTextCompletion(
  ctx: Context,
  chatModel: any,
  messages: [string, string][],
  completionId: string,
  modelName: string,
  streamOptions: Record<string, unknown> | undefined,
) {
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  ctx.status = 200;

  const requestAbort = createRequestAbortController(ctx);
  let usage: Usage | undefined;
  let providerRequestId: string | undefined;
  try {
    const stream = await chatModel.stream(messages, {
      stream_options: { ...streamOptions, include_usage: true },
      signal: requestAbort.signal,
    });

    for await (const chunk of stream) {
      if (requestAbort.signal.aborted) throw requestAbort.signal.reason;
      let text = '';
      if (typeof chunk.content === 'string') {
        text = chunk.content;
      } else if (Array.isArray(chunk.content)) {
        const textPart = chunk.content.find((c: any) => c.type === 'text');
        text = textPart?.text || '';
      }

      if (text) {
        markAiApiFirstProviderOutput(ctx);
        await writeResponse(
          ctx,
          formatSSE({
            id: completionId,
            object: 'text_completion',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            system_fingerprint: null,
            choices: [
              {
                text,
                index: 0,
                logprobs: null,
                finish_reason: null,
              },
            ],
            usage: null,
          }),
        );
      }
      if (chunk.usage_metadata) {
        usage = normalizeUsage(chunk.usage_metadata) ?? usage;
      }
      providerRequestId = providerRequestId ?? extractProviderRequestId(chunk);
    }

    // Final chunk
    await writeResponse(
      ctx,
      formatSSE({
        id: completionId,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        system_fingerprint: null,
        choices: [
          {
            text: '',
            index: 0,
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
        usage: null,
      }),
    );

    if (usage) {
      await writeResponse(
        ctx,
        formatSSE(
          toOpenAIUsageChunk({
            id: completionId,
            model: modelName,
            object: 'text_completion',
            usage,
          }),
        ),
      );
    }

    await writeResponse(ctx, formatSSEDone());
    setAiApiUsageResult(ctx, usage, { gatewayResponseId: completionId, providerRequestId });
    ctx.state.aiApiStreamResult = { succeeded: true, id: completionId };
  } catch (err) {
    const cancelled = isClientDisconnected(ctx, err);
    ctx.log.error('AI API completions streaming error:', err);
    if (!ctx.res.destroyed && !ctx.res.writableEnded) {
      await writeResponse(
        ctx,
        formatSSE({
          error: {
            message: getErrorMessage(err, 'Streaming error'),
            type: 'server_error',
          },
        }),
      );
    }
    setAiApiUsageResult(ctx, usage, { gatewayResponseId: completionId, providerRequestId });
    ctx.state.aiApiStreamResult = {
      succeeded: false,
      id: completionId,
      errorCode: cancelled ? 'client_disconnected' : 'stream_error',
    };
  } finally {
    requestAbort.dispose();
    if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end();
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
