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
  toOpenAIResponse,
  toOpenAIStreamChunk,
  toOpenAIError,
  formatSSE,
  formatSSEDone,
  OpenAIToolCall,
  OpenAIToolCallChunk,
} from '../utils/openai-format';
import { resolveModelString } from '../utils/resolve-service';
import { createRequestAbortController, isStreamingRequested, writeResponse } from '../utils/streaming';
import { checkEmployeeAccess } from '../middleware/role-permission';
import { extractProviderRequestId, normalizeUsage, setAiApiUsageResult, type Usage } from '../usage';
import type PluginAiApiServer from '../plugin';
import { AiApiQuotaError, markLlmProviderAttempted, prepareLlmBilling } from '../billing';

/**
 * POST /api/ai-llm/v1/chat/completions
 *
 * Handles OpenAI-compatible chat completion requests.
 * Supports both streaming (SSE) and non-streaming modes.
 */
export async function handleChatCompletions(ctx: Context, plugin: PluginAiApiServer) {
  const body = ctx.request.body as any;

  // ─── Validate request ───
  if (!body?.model) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'model' is required", 'invalid_request_error', 'missing_model');
    return;
  }

  if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'messages' must be a non-empty array", 'invalid_request_error', 'missing_messages');
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

    // ─── Check whitelist ───
    const config = await ctx.db.getRepository('aiApiConfig').findOne();
    if (config?.enabledLlmServices?.length) {
      const serviceName = service.name;
      const serviceTitle = service.title;
      const isAllowed = config.enabledLlmServices.some((s: string) => s === serviceName || s === serviceTitle);
      if (!isAllowed) {
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

    // ─── Create LLM provider instance ───
    const providerMeta = aiPlugin.aiManager.llmProviders.get(service.provider);
    if (!providerMeta) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, `Provider '${service.provider}' not registered`, 'server_error');
      return;
    }

    await prepareLlmBilling(ctx, resolved);

    const providerRequestParameters = getProviderRequestParameters(body);
    const modelOptions: Record<string, unknown> = {
      model: modelId,
      llmService: service.name,
    };

    // Pass through optional parameters
    if (body.temperature !== undefined) modelOptions.temperature = body.temperature;
    if (body.top_p !== undefined) modelOptions.topP = body.top_p;
    if (body.max_completion_tokens !== undefined) modelOptions.maxTokens = body.max_completion_tokens;
    else if (body.max_tokens !== undefined) modelOptions.maxTokens = body.max_tokens;
    if (body.frequency_penalty !== undefined) modelOptions.frequencyPenalty = body.frequency_penalty;
    if (body.presence_penalty !== undefined) modelOptions.presencePenalty = body.presence_penalty;
    if (body.stop !== undefined) modelOptions.stop = body.stop;

    const Provider = providerMeta.provider;
    const provider = new Provider({
      app: ctx.app,
      serviceOptions: service.options,
      modelOptions,
    });

    // ─── Build system prompt from AI Employee ───
    let systemPrompt = '';
    if (config?.defaultAiEmployee) {
      // Check role is allowed to use this employee
      if (!checkEmployeeAccess(ctx, config.defaultAiEmployee)) {
        ctx.status = 403;
        ctx.body = toOpenAIError(
          403,
          `Role is not permitted to use AI Employee '${config.defaultAiEmployee}'. ` +
            `An admin must grant access in Settings → Users & Permissions → [Role] → AI API.`,
          'permission_denied',
          'employee_not_permitted',
        );
        return;
      }
      const employee = await ctx.db.getRepository('aiEmployees').findOne({
        filter: { username: config.defaultAiEmployee },
      });
      if (employee) {
        systemPrompt = employee.about || employee.defaultPrompt || '';
      }
    }

    // ─── Build messages (inject system prompt if not provided by client) ───
    const messages = [...body.messages];
    const hasSystemMessage = messages.some((m: any) => m.role === 'system');
    if (systemPrompt && !hasSystemMessage) {
      messages.unshift({ role: 'system', content: systemPrompt });
    }

    // ─── Build message tuples for LangChain model ───
    // LangChain chat models accept [role, content] tuples or BaseMessage objects.
    // We use tuples to avoid importing @langchain/core directly.
    const langchainMessages = messages.map((msg: any) => {
      const role = msg.role === 'assistant' ? 'ai' : msg.role;
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role,
          content,
          tool_calls: msg.tool_calls,
          additional_kwargs: { tool_calls: msg.tool_calls },
        };
      }
      if (msg.role === 'tool') {
        return { role: 'tool', content, tool_call_id: msg.tool_call_id, name: msg.name };
      }
      return [role, content] as [string, string];
    });

    const completionId = generateCompletionId();
    const baseModel = provider.createModel();
    applyProviderRequestParameters(baseModel, providerRequestParameters);
    const chatModel = bindRequestTools(baseModel, body.tools, body.tool_choice, providerRequestParameters);
    markLlmProviderAttempted(ctx);

    if (stream) {
      // ─── Streaming mode ───
      await handleStreamingCompletion(
        ctx,
        chatModel,
        langchainMessages,
        completionId,
        body.model,
        providerRequestParameters,
      );
    } else {
      // ─── Non-streaming mode ───
      await handleNonStreamingCompletion(
        ctx,
        chatModel,
        langchainMessages,
        completionId,
        body.model,
        providerRequestParameters,
      );
    }
  } catch (err) {
    ctx.log.error('AI API chat completions error:', err);
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

// ─── Non-streaming handler ───

async function handleNonStreamingCompletion(
  ctx: Context,
  chatModel: any,
  messages: any[],
  completionId: string,
  modelName: string,
  providerRequestParameters: Record<string, unknown>,
) {
  const result = await chatModel.invoke(messages, providerRequestParameters);

  let content = '';
  if (typeof result.content === 'string') {
    content = result.content;
  } else if (Array.isArray(result.content)) {
    // Handle array content (e.g. OpenAI responses API)
    const textPart = result.content.find((c: any) => c.type === 'text');
    content = textPart?.text || JSON.stringify(result.content);
  }

  // Extract usage if available
  const usage = setAiApiUsageResult(ctx, result.usage_metadata, {
    gatewayResponseId: completionId,
    providerRequestId: extractProviderRequestId(result),
  });

  ctx.status = 200;
  const toolCalls = normalizeToolCalls(result.tool_calls);
  ctx.body = toOpenAIResponse({
    id: completionId,
    model: modelName,
    content,
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    toolCalls,
  });
}

// ─── Streaming handler ───

async function handleStreamingCompletion(
  ctx: Context,
  chatModel: any,
  messages: any[],
  completionId: string,
  modelName: string,
  providerRequestParameters: Record<string, unknown>,
) {
  // Set SSE headers
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });
  ctx.status = 200;

  // Send initial chunk with role
  await writeResponse(
    ctx,
    formatSSE(
      toOpenAIStreamChunk({
        id: completionId,
        model: modelName,
        delta: { role: 'assistant', content: '' },
      }),
    ),
  );

  const requestAbort = createRequestAbortController(ctx);
  let usage: Usage | undefined;
  let providerRequestId: string | undefined;
  let finishReason = 'stop';
  try {
    const stream = await chatModel.stream(messages, { ...providerRequestParameters, signal: requestAbort.signal });

    for await (const chunk of stream) {
      if (requestAbort.signal.aborted) throw requestAbort.signal.reason;
      let content = '';
      if (typeof chunk.content === 'string') {
        content = chunk.content;
      } else if (Array.isArray(chunk.content)) {
        const textPart = chunk.content.find((c: any) => c.type === 'text');
        content = textPart?.text || '';
      }

      if (content) {
        await writeResponse(
          ctx,
          formatSSE(
            toOpenAIStreamChunk({
              id: completionId,
              model: modelName,
              delta: { content },
            }),
          ),
        );
      }

      const toolCallChunks = normalizeToolCallChunks(chunk.tool_call_chunks);
      if (toolCallChunks.length) {
        finishReason = 'tool_calls';
        await writeResponse(
          ctx,
          formatSSE(toOpenAIStreamChunk({ id: completionId, model: modelName, delta: { tool_calls: toolCallChunks } })),
        );
      }
      if (chunk.usage_metadata) {
        usage = normalizeUsage(chunk.usage_metadata) ?? usage;
      }
      providerRequestId = providerRequestId ?? extractProviderRequestId(chunk);
    }

    // Send finish chunk
    await writeResponse(
      ctx,
      formatSSE(
        toOpenAIStreamChunk({
          id: completionId,
          model: modelName,
          delta: {},
          finishReason,
        }),
      ),
    );

    // Send [DONE]
    await writeResponse(ctx, formatSSEDone());
    setAiApiUsageResult(ctx, usage, { gatewayResponseId: completionId, providerRequestId });
    ctx.state.aiApiStreamResult = { succeeded: true, id: completionId };
  } catch (err) {
    ctx.log.error('AI API streaming error:', err);
    // Send error as SSE event before closing
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
    ctx.state.aiApiStreamResult = { succeeded: false, id: completionId, errorCode: 'stream_error' };
  } finally {
    requestAbort.dispose();
    if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end();
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

const GATEWAY_MANAGED_PARAMETERS = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'n']);

export function getProviderRequestParameters(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([name, value]) => !GATEWAY_MANAGED_PARAMETERS.has(name) && value !== undefined),
  );
}

interface ModelWithKwargs {
  modelKwargs?: Record<string, unknown>;
}

export function applyProviderRequestParameters(chatModel: unknown, parameters: Record<string, unknown>): void {
  if (!chatModel || typeof chatModel !== 'object') return;

  const model = chatModel as ModelWithKwargs;
  const modelKwargs = { ...(model.modelKwargs ?? {}) };

  // OpenAI providers currently install a synthetic text response format even when
  // the client did not request one. Remove that default so LLM mode matches the
  // original OpenAI-compatible request more closely.
  if (!Object.hasOwn(parameters, 'response_format')) {
    if (isDefaultTextResponseFormat(modelKwargs.response_format)) delete modelKwargs.response_format;
    if (isDefaultResponsesTextFormat(modelKwargs.text)) delete modelKwargs.text;
  }

  model.modelKwargs = { ...modelKwargs, ...parameters };
}

function bindRequestTools(
  chatModel: any,
  tools: unknown,
  toolChoice: unknown,
  providerRequestParameters: Record<string, unknown>,
) {
  if (!Array.isArray(tools) || tools.length === 0) return chatModel;
  if (typeof chatModel.bindTools !== 'function') {
    throw new Error('The selected LLM provider does not support tool calling');
  }
  return chatModel.bindTools(tools, {
    ...providerRequestParameters,
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  });
}

function isDefaultTextResponseFormat(value: unknown): boolean {
  return isRecord(value) && value.type === 'text' && Object.keys(value).length === 1;
}

function isDefaultResponsesTextFormat(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.format)) return false;
  return value.format.type === 'text' && Object.keys(value.format).length === 1 && Object.keys(value).length === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeToolCalls(value: unknown): OpenAIToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((call: any) => ({
    id: String(call.id || ''),
    type: 'function',
    function: {
      name: String(call.name || call.function?.name || ''),
      arguments: serializeToolArguments(call.args ?? call.function?.arguments),
    },
  }));
}

function normalizeToolCallChunks(value: unknown): OpenAIToolCallChunk[] {
  if (!Array.isArray(value)) return [];
  return value.map((call: any, fallbackIndex) => ({
    index: typeof call.index === 'number' ? call.index : fallbackIndex,
    ...(call.id ? { id: String(call.id), type: 'function' as const } : {}),
    function: {
      ...(call.name ? { name: String(call.name) } : {}),
      ...(call.args !== undefined || call.function?.arguments !== undefined
        ? { arguments: serializeToolArguments(call.args ?? call.function?.arguments) }
        : {}),
    },
  }));
}

function serializeToolArguments(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}
