/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import type PluginAiApiServer from '../plugin';
import { AiApiQuotaError, markLlmProviderAttempted, prepareLlmBilling } from '../billing';
import { FileProcessorError } from '../services/file-processor';
import { extractProviderRequestId, normalizeUsage, setAiApiUsageResult, type Usage } from '../usage';
import { markAiApiFirstProviderOutput } from '../utils/app-observability';
import {
  DirectLlmContextError,
  prepareDirectLlmContext,
  type ContextOverflowBehavior,
  type OpenAIMessage,
} from '../utils/direct-llm-context';
import { formatSSE, formatSSEDone, toOpenAIError } from '../utils/openai-format';
import { getAiApiConfig } from '../utils/request-cache';
import {
  deleteResponseRecord,
  getResponseRecord,
  loadConversationChain,
  storeResponseRecord,
} from '../utils/response-store';
import {
  chatResultToResponse,
  extractReasoningText,
  extractResponseIncompleteReason,
  extractResponseOutputText,
  extractResponseServiceTier,
  findUnsupportedResponseInput,
  findUnsupportedResponseParameter,
  findResponseInputProblem,
  findResponseParameterProblem,
  findResponseToolChoiceProblem,
  findResponseToolProblem,
  generateResponseId,
  isRecord,
  isResponseServiceTier,
  responsesBodyToChatBody,
  type ResponseObject,
} from '../utils/responses-format';
import {
  appendResponseStreamChunk,
  createResponseErrorEvent,
  createResponseFailedEvent,
  createResponseStartEvents,
  createResponseStreamState,
  finalizeResponseStream,
  setResponseStreamUsage,
} from '../utils/responses-stream';
import { resolveModelString } from '../utils/resolve-service';
import { createRequestAbortController, isClientDisconnected, writeResponse } from '../utils/streaming';
import { enforceModelAccess } from '../utils/user-permissions';
import { resolveVirtualModel, respondVirtualModelUnavailable } from '../utils/virtual-models';
import {
  applyProviderRequestParameters,
  bindRequestTools,
  extractFinishReason,
  findContentBlockProblem,
  findMessageProblem,
  getProviderRequestParameters,
  normalizeMessageContent,
  normalizeToolCalls,
  processMessageContentFileBlocks,
  type MessageContent,
} from './chat-completions';

interface ProviderResult {
  content?: unknown;
  usage_metadata?: unknown;
  response_metadata?: unknown;
  tool_calls?: unknown;
  additional_kwargs?: unknown;
  reasoning_content?: unknown;
}

interface RunnableChatModel {
  invoke(messages: unknown[], params: Record<string, unknown>): Promise<ProviderResult>;
  stream(messages: unknown[], params: Record<string, unknown>): Promise<AsyncIterable<ProviderResult>>;
}

interface LlmProviderInstance {
  createModel(): unknown;
}

interface LlmProviderConstructor {
  new (options: { app: unknown; serviceOptions: unknown; modelOptions: Record<string, unknown> }): LlmProviderInstance;
}

interface LlmProviderMetadata {
  provider: LlmProviderConstructor;
}

// Provider keys registered in plugin-ai whose chat model speaks the OpenAI Responses protocol.
// Only these providers accept the `store` field in the upstream request payload.
export const RESPONSES_CAPABLE_PROVIDERS = new Set(['openai']);

function isResponsesCapableProvider(providerName: string): boolean {
  return RESPONSES_CAPABLE_PROVIDERS.has(providerName);
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function getCurrentUserId(ctx: Context): string | number | bigint | undefined {
  return ctx.state.currentUser?.id;
}

function validateRequest(ctx: Context, body: Record<string, unknown>): boolean {
  if (typeof body.model !== 'string' || !body.model) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'model' is required", 'invalid_request_error', 'missing_model');
    return false;
  }
  if (body.input === undefined || body.input === null) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'input' is required", 'invalid_request_error', 'missing_input');
    return false;
  }
  if (body.model.trim().length === 0) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'model' must not be blank", 'invalid_request_error', 'missing_model');
    return false;
  }
  const parameterProblem = findResponseParameterProblem(body);
  if (parameterProblem) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, parameterProblem, 'invalid_request_error', 'invalid_parameter');
    return false;
  }
  const inputProblem = findResponseInputProblem(body.input);
  if (inputProblem) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, inputProblem, 'invalid_request_error', 'invalid_input');
    return false;
  }
  const unsupportedParameter = findUnsupportedResponseParameter(body);
  if (unsupportedParameter) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `Responses API parameter '${unsupportedParameter}' is not supported by this gateway`,
      'invalid_request_error',
      'unsupported_parameter',
    );
    return false;
  }
  if (
    body.truncation !== undefined &&
    body.truncation !== null &&
    body.truncation !== 'auto' &&
    body.truncation !== 'disabled'
  ) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      "'truncation' must be 'auto' or 'disabled'",
      'invalid_request_error',
      'invalid_truncation',
    );
    return false;
  }
  if (body.service_tier !== undefined && body.service_tier !== null && !isResponseServiceTier(body.service_tier)) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      "'service_tier' must be one of auto, default, flex, scale, or priority",
      'invalid_request_error',
      'invalid_service_tier',
    );
    return false;
  }
  const unsupportedInput = findUnsupportedResponseInput(body.input);
  if (unsupportedInput) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `Responses API input '${unsupportedInput}' is not supported because this gateway has no OpenAI file store. Use image_url, file_url, or file_data instead.`,
      'invalid_request_error',
      'unsupported_input',
    );
    return false;
  }
  const toolProblem = findResponseToolProblem(body.tools);
  if (toolProblem) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, toolProblem, 'invalid_request_error', 'unsupported_tool');
    return false;
  }
  const toolChoiceProblem = findResponseToolChoiceProblem(body.tool_choice);
  if (toolChoiceProblem) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, toolChoiceProblem, 'invalid_request_error', 'invalid_tool_choice');
    return false;
  }
  if (body.metadata !== undefined && body.metadata !== null) {
    const entries = isRecord(body.metadata) ? Object.entries(body.metadata) : [];
    if (
      !isRecord(body.metadata) ||
      entries.length > 16 ||
      entries.some(([key, value]) => key.length > 64 || typeof value !== 'string' || value.length > 512)
    ) {
      ctx.status = 400;
      ctx.body = toOpenAIError(
        400,
        "'metadata' must contain at most 16 string values (keys <= 64 chars, values <= 512 chars)",
        'invalid_request_error',
        'invalid_metadata',
      );
      return false;
    }
  }
  return true;
}

function toLangChainMessages(messages: OpenAIMessage[]): Array<unknown> {
  return messages.map((message) => {
    const role = message.role === 'assistant' ? 'ai' : message.role;
    const content = normalizeMessageContent(message.content);
    if (message.role === 'assistant' && message.tool_calls) {
      return {
        role,
        content,
        tool_calls: message.tool_calls,
        additional_kwargs: {
          ...(isRecord(message.additional_kwargs) ? message.additional_kwargs : {}),
          tool_calls: message.tool_calls,
        },
        ...(isRecord(message.response_metadata) ? { response_metadata: message.response_metadata } : {}),
      };
    }
    if (message.role === 'assistant' && message.additional_kwargs) {
      return {
        role,
        content,
        additional_kwargs: message.additional_kwargs,
        ...(isRecord(message.response_metadata) ? { response_metadata: message.response_metadata } : {}),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', content, tool_call_id: message.tool_call_id, name: message.name };
    }
    return [role, content] as [string, MessageContent];
  });
}

function responseOverflowBehavior(body: Record<string, unknown>): ContextOverflowBehavior {
  return body.truncation === 'auto' ? 'truncate' : 'reject';
}

const RESPONSE_INVOCATION_PARAMETERS = new Set([
  'max_completion_tokens',
  'parallel_tool_calls',
  'promptCacheKey',
  'promptCacheRetention',
  'reasoning',
  'response_format',
  'service_tier',
  'temperature',
  'top_p',
  'user',
  'verbosity',
]);

function responseModelKwargs(parameters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(parameters).filter(([name]) => !RESPONSE_INVOCATION_PARAMETERS.has(name)));
}

function findCompletedResponse(events: Array<Record<string, unknown>>): ResponseObject | undefined {
  const terminal = events.find((event) => event.type === 'response.completed' || event.type === 'response.incomplete');
  return terminal && isRecord(terminal.response) ? (terminal.response as unknown as ResponseObject) : undefined;
}

function findUnsupportedRetrieveParameter(ctx: Context): string | undefined {
  const query = isRecord(ctx.query) ? ctx.query : {};
  for (const name of ['include', 'include[]', 'include_obfuscation', 'starting_after']) {
    if (Object.hasOwn(query, name)) return name === 'include[]' ? 'include' : name;
  }
  if (Object.hasOwn(query, 'stream') && query.stream !== false && query.stream !== 'false') return 'stream';
  return undefined;
}

export async function handleGetResponse(ctx: Context, responseId: string): Promise<void> {
  const unsupportedParameter = findUnsupportedRetrieveParameter(ctx);
  if (unsupportedParameter) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `Responses API retrieve parameter '${unsupportedParameter}' is not supported by this gateway`,
      'invalid_request_error',
      'unsupported_parameter',
    );
    return;
  }
  const userId = getCurrentUserId(ctx);
  const record = userId === undefined ? null : await getResponseRecord(ctx, responseId, userId);
  if (!record) {
    ctx.status = 404;
    ctx.body = toOpenAIError(
      404,
      `Response '${responseId}' was not found`,
      'invalid_request_error',
      'response_not_found',
    );
    return;
  }
  ctx.status = 200;
  ctx.body = record.output;
}

export async function handleDeleteResponse(ctx: Context, responseId: string): Promise<void> {
  const userId = getCurrentUserId(ctx);
  const deleted = userId === undefined ? false : await deleteResponseRecord(ctx, responseId, userId);
  if (!deleted) {
    ctx.status = 404;
    ctx.body = toOpenAIError(
      404,
      `Response '${responseId}' was not found`,
      'invalid_request_error',
      'response_not_found',
    );
    return;
  }
  ctx.status = 204;
  ctx.body = undefined;
}

/** POST /api/ai-llm/v1/responses */
export async function handleResponses(ctx: Context, plugin: PluginAiApiServer): Promise<void> {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  if (!validateRequest(ctx, body)) return;

  const chatBody = responsesBodyToChatBody(body);
  let messages = Array.isArray(chatBody.messages) ? (chatBody.messages as OpenAIMessage[]) : [];
  if (messages.length === 0) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      "'input' must contain at least one supported message or function call item",
      'invalid_request_error',
      'invalid_input',
    );
    return;
  }

  const messageProblem = findMessageProblem(messages);
  if (messageProblem) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `Invalid input[${messageProblem.index}]: ${messageProblem.reason}.`,
      'invalid_request_error',
      'invalid_input',
    );
    return;
  }
  const blockProblem = findContentBlockProblem(messages);
  if (blockProblem) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `Invalid content block in input[${blockProblem.index}]: ${blockProblem.reason}.`,
      'invalid_request_error',
      'invalid_content_block',
    );
    return;
  }

  const userId = getCurrentUserId(ctx);
  if (typeof body.previous_response_id === 'string') {
    if (userId === undefined) {
      ctx.status = 401;
      ctx.body = toOpenAIError(401, 'Authentication is required', 'authentication_error', 'invalid_api_key');
      return;
    }
    const previousMessages = await loadConversationChain(ctx, body.previous_response_id, userId);
    if (!previousMessages) {
      ctx.status = 404;
      ctx.body = toOpenAIError(
        404,
        `Previous response '${body.previous_response_id}' was not found`,
        'invalid_request_error',
        'previous_response_not_found',
      );
      return;
    }
    messages = [...previousMessages, ...messages];
  }

  const virtual = await resolveVirtualModel(ctx, body.model as string, chatBody, 'chat');
  if (virtual?.status === 'unavailable') {
    respondVirtualModelUnavailable(ctx, virtual);
    return;
  }
  if (virtual?.status === 'resolved') {
    ctx.state.aiApiVirtualModel = virtual.virtualModel;
    ctx.state.aiApiRoutingReason = virtual.reason;
  }
  const resolved = virtual?.resolved ?? (await resolveModelString(ctx, body.model as string));
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
    const aiPlugin = ctx.app.pm.get('ai') as
      | { aiManager?: { llmProviders?: Map<string, LlmProviderMetadata> } }
      | undefined;
    if (!aiPlugin?.aiManager?.llmProviders) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, 'AI plugin not available', 'server_error');
      return;
    }
    if (service.get('enabled') === false) {
      ctx.status = 404;
      ctx.body = toOpenAIError(404, 'LLM service is disabled', 'invalid_request_error', 'model_not_found');
      return;
    }
    const config = await getAiApiConfig(ctx);
    if (!(await enforceModelAccess(ctx, config?.enabledLlmServices, service, modelId))) return;

    const providerName = service.get('provider') as string;
    const providerMeta = aiPlugin.aiManager.llmProviders.get(providerName);
    if (!providerMeta) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, `Provider '${providerName}' not registered`, 'server_error');
      return;
    }

    messages = await Promise.all(
      messages.map(async (message) => ({
        ...message,
        content: await processMessageContentFileBlocks(message.content, ctx, plugin),
      })),
    );
    const prepared = await prepareDirectLlmContext(ctx, {
      serviceName: service.get('name') as string,
      modelId,
      messages,
      tools: chatBody.tools,
      maxCompletionTokens: chatBody.max_completion_tokens,
      overflowBehavior: responseOverflowBehavior(body),
    });
    await prepareLlmBilling(ctx, resolved);

    const modelOptions: Record<string, unknown> = {
      model: modelId,
      llmService: service.get('name'),
    };
    if (chatBody.temperature !== undefined) modelOptions.temperature = chatBody.temperature;
    if (chatBody.top_p !== undefined) modelOptions.topP = chatBody.top_p;
    if (chatBody.max_completion_tokens !== undefined) modelOptions.maxTokens = chatBody.max_completion_tokens;
    if (chatBody.reasoning !== undefined) modelOptions.reasoning = chatBody.reasoning;
    if (chatBody.service_tier !== undefined) modelOptions.service_tier = chatBody.service_tier;
    if (chatBody.promptCacheKey !== undefined) modelOptions.promptCacheKey = chatBody.promptCacheKey;
    if (chatBody.promptCacheRetention !== undefined) modelOptions.promptCacheRetention = chatBody.promptCacheRetention;
    if (chatBody.verbosity !== undefined) modelOptions.verbosity = chatBody.verbosity;
    if (chatBody.user !== undefined) modelOptions.user = chatBody.user;

    const provider = new providerMeta.provider({
      app: ctx.app,
      serviceOptions: service.get('options'),
      modelOptions,
    });
    const providerParameters = getProviderRequestParameters(chatBody);
    const baseModel = provider.createModel();
    applyProviderRequestParameters(baseModel, responseModelKwargs(providerParameters));
    // Forward store=false only to providers that speak the OpenAI Responses protocol, so they do not
    // persist the response on the provider side. Chat Completions backends (e.g. openai-completions,
    // dashscope, kimi) receive modelKwargs verbatim in the /chat/completions payload and would reject
    // the unknown `store` field, so they must not get it.
    if (
      body.store === false &&
      isResponsesCapableProvider(providerName) &&
      baseModel &&
      typeof baseModel === 'object'
    ) {
      (baseModel as { modelKwargs?: Record<string, unknown> }).modelKwargs = {
        ...((baseModel as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {}),
        store: false,
      };
    }
    const chatModel = bindRequestTools(
      baseModel,
      chatBody.tools,
      chatBody.tool_choice,
      providerParameters,
    ) as RunnableChatModel;
    markLlmProviderAttempted(ctx);

    const modelName = `${service.get('name')}/${modelId}`;
    const langchainMessages = toLangChainMessages(prepared.messages);
    if (body.stream === true) {
      await handleStreamingResponse(ctx, chatModel, langchainMessages, body, modelName, providerParameters, userId);
    } else {
      await handleNonStreamingResponse(ctx, chatModel, langchainMessages, body, modelName, providerParameters, userId);
    }
  } catch (error) {
    ctx.log.error('AI API responses error:', error);
    if (!ctx.res?.headersSent) {
      const quotaError = error instanceof AiApiQuotaError;
      const requestError = error instanceof DirectLlmContextError || error instanceof FileProcessorError;
      ctx.status = quotaError ? 429 : requestError ? 400 : 500;
      if (quotaError) ctx.set('X-RateLimit-Reason', error.code);
      ctx.body = toOpenAIError(
        ctx.status,
        getErrorMessage(error, 'Internal server error'),
        quotaError ? 'quota_error' : requestError ? 'invalid_request_error' : 'server_error',
        quotaError || requestError ? error.code : undefined,
      );
    }
  }
}

async function handleNonStreamingResponse(
  ctx: Context,
  chatModel: RunnableChatModel,
  messages: unknown[],
  body: Record<string, unknown>,
  modelName: string,
  providerParameters: Record<string, unknown>,
  userId: string | number | bigint | undefined,
): Promise<void> {
  const result = await chatModel.invoke(messages, providerParameters);
  const content = extractResponseOutputText(result);
  const responseId = generateResponseId();
  const usage = setAiApiUsageResult(
    ctx,
    result.usage_metadata,
    { gatewayResponseId: responseId, providerRequestId: extractProviderRequestId(result) },
    result.response_metadata,
  );
  const response = chatResultToResponse({
    id: responseId,
    model: modelName,
    content,
    reasoningText: extractReasoningText(result),
    usage,
    toolCalls: normalizeToolCalls(result.tool_calls),
    finishReason: extractFinishReason(result) ?? extractResponseIncompleteReason(result),
    serviceTier: extractResponseServiceTier(result),
    requestBody: body,
  });
  if (body.store !== false && userId !== undefined) await storeResponseRecord(ctx, response, body, userId);
  ctx.status = 200;
  ctx.body = response;
}

async function handleStreamingResponse(
  ctx: Context,
  chatModel: RunnableChatModel,
  messages: unknown[],
  body: Record<string, unknown>,
  modelName: string,
  providerParameters: Record<string, unknown>,
  userId: string | number | bigint | undefined,
): Promise<void> {
  const responseId = generateResponseId();
  const state = createResponseStreamState(responseId, modelName, body);
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  ctx.status = 200;
  for (const event of createResponseStartEvents(state)) await writeResponse(ctx, formatSSE(event));

  const requestAbort = createRequestAbortController(ctx);
  let usage: Usage | undefined;
  let usageMetadata: unknown;
  let providerRequestId: string | undefined;
  try {
    const stream = await chatModel.stream(messages, { ...providerParameters, signal: requestAbort.signal });
    for await (const chunk of stream) {
      if (requestAbort.signal.aborted) throw requestAbort.signal.reason;
      const events = appendResponseStreamChunk(state, chunk);
      if (events.length) markAiApiFirstProviderOutput(ctx);
      for (const event of events) await writeResponse(ctx, formatSSE(event));
      const normalized = normalizeUsage(chunk.usage_metadata);
      if (normalized) {
        usage = normalized;
        usageMetadata = chunk.response_metadata;
        setResponseStreamUsage(state, normalized);
      }
      providerRequestId = providerRequestId ?? extractProviderRequestId(chunk);
    }

    const finalEvents = finalizeResponseStream(state) as Array<Record<string, unknown>>;
    const response = findCompletedResponse(finalEvents);
    if (response && body.store !== false && userId !== undefined) {
      try {
        await storeResponseRecord(ctx, response, body, userId);
      } catch (storeError) {
        // The provider already produced the full result and the client is mid-SSE. We cannot
        // meaningfully turn this into an error response, so deliver the result and log the
        // persistence failure instead of corrupting the terminal stream.
        ctx.log.error('[ai-api] Failed to persist streamed response record:', storeError);
      }
    }
    for (const event of finalEvents) await writeResponse(ctx, formatSSE(event));
    await writeResponse(ctx, formatSSEDone());
    setAiApiUsageResult(ctx, usage, { gatewayResponseId: responseId, providerRequestId }, usageMetadata);
    ctx.state.aiApiStreamResult = { succeeded: true, id: responseId };
  } catch (error) {
    const cancelled = isClientDisconnected(ctx, error);
    ctx.log.error('AI API Responses streaming error:', error);
    if (!ctx.res.destroyed && !ctx.res.writableEnded) {
      const streamError = {
        message: getErrorMessage(error, 'Streaming error'),
        code: cancelled ? 'client_disconnected' : 'server_error',
      };
      await writeResponse(ctx, formatSSE(createResponseErrorEvent(state, streamError)));
      await writeResponse(ctx, formatSSE(createResponseFailedEvent(state, streamError)));
    }
    setAiApiUsageResult(ctx, usage, { gatewayResponseId: responseId, providerRequestId }, usageMetadata);
    ctx.state.aiApiStreamResult = {
      succeeded: false,
      id: responseId,
      errorCode: cancelled ? 'client_disconnected' : 'stream_error',
    };
  } finally {
    requestAbort.dispose();
    if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end();
  }
}
