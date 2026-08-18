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
  toOpenAIUsageChunk,
  toOpenAIError,
  formatSSE,
  formatSSEDone,
  OpenAIToolCall,
  OpenAIToolCallChunk,
} from '../utils/openai-format';
import { resolveModelString } from '../utils/resolve-service';
import {
  createRequestAbortController,
  isClientDisconnected,
  isStreamingRequested,
  writeResponse,
} from '../utils/streaming';
import { enforceModelAccess } from '../utils/user-permissions';
import { getAiApiConfig } from '../utils/request-cache';
import { extractProviderRequestId, normalizeUsage, setAiApiUsageResult, type Usage } from '../usage';
import type PluginAiApiServer from '../plugin';
import { AiApiQuotaError, markLlmProviderAttempted, prepareLlmBilling } from '../billing';
import { DirectLlmContextError, prepareDirectLlmContext, type OpenAIMessage } from '../utils/direct-llm-context';
import { markAiApiFirstProviderOutput } from '../utils/app-observability';
import { FileContentBlock, FileProcessorError } from '../services/file-processor';

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

  const messageProblem = findMessageProblem(body.messages);
  if (messageProblem) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `Invalid messages[${messageProblem.index}]: ${messageProblem.reason}.`,
      'invalid_request_error',
      'invalid_message',
    );
    return;
  }

  const blockProblem = findContentBlockProblem(body.messages);
  if (blockProblem) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `Invalid content block in messages[${blockProblem.index}]: ${blockProblem.reason}.`,
      'invalid_request_error',
      'invalid_content_block',
    );
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
    const config = await getAiApiConfig(ctx);
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

    const providerRequestParameters = getProviderRequestParameters(body);
    if (stream) {
      const streamOptions = isRecord(body.stream_options) ? body.stream_options : {};
      providerRequestParameters.stream_options = {
        ...streamOptions,
        include_usage: true,
      };
    }
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

    // Direct LLM mode ignores the default AI Employee: its prompt belongs to agent
    // mode only. The model metadata system prompt is still applied later by
    // prepareDirectLlmContext.
    let messages: OpenAIMessage[] = [...body.messages];

    // ─── Process file / file_url blocks through the file processor service ───
    messages = await Promise.all(
      messages.map(async (msg) => ({
        ...msg,
        content: await processMessageContentFileBlocks(msg.content, ctx, plugin),
      })),
    );

    const preparedContext = await prepareDirectLlmContext(ctx, {
      serviceName: service.name,
      modelId,
      messages,
      tools: body.tools,
      maxCompletionTokens: body.max_completion_tokens,
      maxTokens: body.max_tokens,
    });
    messages = preparedContext.messages;

    await prepareLlmBilling(ctx, resolved);

    const Provider = providerMeta.provider;
    const provider = new Provider({
      app: ctx.app,
      serviceOptions: service.options,
      modelOptions,
    });

    // ─── Build message tuples for LangChain model ───
    // LangChain chat models accept [role, content] tuples or BaseMessage objects.
    // We use tuples to avoid importing @langchain/core directly.
    //
    // `content` may be a string OR an array of content blocks (OpenAI vision
    // format: [{type:'text'}, {type:'image_url', image_url:{url:'data:...'}}]).
    // Arrays must be forwarded structurally — stringifying them would turn an
    // image into literal JSON text and the model would never see the picture.
    const langchainMessages = messages.map((msg: any) => {
      const role = msg.role === 'assistant' ? 'ai' : msg.role;
      const content = normalizeMessageContent(msg.content);
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
      return [role, content] as [string, MessageContent];
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
    if (!ctx.res?.headersSent) {
      const isQuotaError = err instanceof AiApiQuotaError;
      const isContextError = err instanceof DirectLlmContextError;
      const isFileError = err instanceof FileProcessorError;
      ctx.status = isQuotaError ? 429 : isContextError || isFileError ? 400 : 500;
      if (isQuotaError) ctx.set('X-RateLimit-Reason', err.code);
      ctx.body = toOpenAIError(
        ctx.status,
        getErrorMessage(err, 'Internal server error'),
        isQuotaError ? 'quota_error' : isContextError || isFileError ? 'invalid_request_error' : 'server_error',
        isQuotaError || isContextError || isFileError ? err.code : undefined,
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
  const usage = setAiApiUsageResult(
    ctx,
    result.usage_metadata,
    {
      gatewayResponseId: completionId,
      providerRequestId: extractProviderRequestId(result),
    },
    result.response_metadata,
  );

  ctx.status = 200;
  const toolCalls = normalizeToolCalls(result.tool_calls);
  const providerFinishReason = extractFinishReason(result);
  ctx.body = toOpenAIResponse({
    id: completionId,
    model: modelName,
    content,
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    toolCalls,
    ...(providerFinishReason ? { finishReason: providerFinishReason } : {}),
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
  let usageResponseMetadata: unknown;
  let providerRequestId: string | undefined;
  let providerFinishReason: string | undefined;
  let sawToolCalls = false;
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
        markAiApiFirstProviderOutput(ctx);
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
        markAiApiFirstProviderOutput(ctx);
        sawToolCalls = true;
        await writeResponse(
          ctx,
          formatSSE(
            toOpenAIStreamChunk({
              id: completionId,
              model: modelName,
              delta: { tool_calls: toolCallChunks },
            }),
          ),
        );
      }
      if (chunk.usage_metadata) {
        const normalized = normalizeUsage(chunk.usage_metadata);
        if (normalized) {
          usage = normalized;
          usageResponseMetadata = chunk.response_metadata;
        }
      }
      const chunkFinishReason = extractFinishReason(chunk);
      if (chunkFinishReason) providerFinishReason = chunkFinishReason;
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
          finishReason: providerFinishReason ?? (sawToolCalls ? 'tool_calls' : 'stop'),
        }),
      ),
    );

    if (usage) {
      await writeResponse(
        ctx,
        formatSSE(
          toOpenAIUsageChunk({
            id: completionId,
            model: modelName,
            usage,
          }),
        ),
      );
    }

    // Send [DONE]
    await writeResponse(ctx, formatSSEDone());
    setAiApiUsageResult(ctx, usage, { gatewayResponseId: completionId, providerRequestId }, usageResponseMetadata);
    ctx.state.aiApiStreamResult = { succeeded: true, id: completionId };
  } catch (err) {
    const cancelled = isClientDisconnected(ctx, err);
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
    setAiApiUsageResult(ctx, usage, { gatewayResponseId: completionId, providerRequestId }, usageResponseMetadata);
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

/**
 * Reads the provider's finish_reason from a LangChain result or stream chunk.
 * LangChain surfaces it in response_metadata.finish_reason; some adapters put it
 * in additional_kwargs.finish_reason instead. Returns undefined when the provider
 * reported nothing, so callers can fall back to their own default.
 */
export function extractFinishReason(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidates = [
    isRecord(value.response_metadata) ? value.response_metadata.finish_reason : undefined,
    isRecord(value.additional_kwargs) ? value.additional_kwargs.finish_reason : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Content block types every provider adapter in `@nocobase/plugin-ai` maps to a
 * native equivalent.
 *
 * Anything else is rejected rather than forwarded: the LangChain block
 * converters are if/else-if chains with no fallback branch, so an unrecognized
 * block (OpenAI's `{type:'file'}` on Anthropic, for example) yields nothing and
 * the model answers as if the attachment was never sent. A 400 is far easier to
 * debug than a confidently wrong completion.
 */
const SUPPORTED_CONTENT_BLOCK_TYPES = new Set(['text', 'image_url', 'file', 'file_url']);

/**
 * Deliberately mirrors the exact grammar `@langchain/core`'s `parseBase64DataUrl`
 * accepts (`\w+/\w+`, standard base64). A looser pattern here would admit URLs
 * the provider adapter then fails to parse — it falls through to `new URL()`,
 * sees the `data:` protocol and throws, which reaches the client as a 500.
 * Compound subtypes such as `image/svg+xml` are rejected for that reason.
 */
const BASE64_DATA_URL_PATTERN = /^data:(\w+\/\w+);base64,([A-Za-z0-9+/]+=*)$/;

/**
 * File blocks accept a wider range of MIME types than `image_url` blocks:
 * documents such as `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
 * or `image/svg+xml` are valid attachments. The grammar still requires a proper
 * `type/subtype` and standard base64 payload.
 */
const FILE_BASE64_DATA_URL_PATTERN = /^data:([^;\s]+);base64,([A-Za-z0-9+/]+=*)$/;

/**
 * The regex above is LangChain's, and LangChain's is lenient: `A===`, `A=`,
 * `AAAAA` and `AAAA=` all match it but are not decodable base64. LangChain then
 * calls `atob` on the payload, which throws a DOMException for each of them, and
 * that escapes as an HTTP 500. Re-encoding is the cheapest exact check — the
 * canonical form of a valid payload is the payload itself.
 */
function isDecodableBase64(payload: string): boolean {
  try {
    return Buffer.from(payload, 'base64').toString('base64') === payload;
  } catch {
    return false;
  }
}

export interface ContentBlockProblem {
  index: number;
  reason: string;
}

/**
 * Roles `_constructMessageFromParams` can turn into a message. Anything else
 * reaches its final `else` and throws MESSAGE_COERCION_FAILURE.
 *
 * `function` is deliberately absent: OpenAI deprecated it, and LangChain has no
 * branch for it despite mapping the class name internally.
 */
const SUPPORTED_MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'human', 'assistant', 'ai', 'tool']);

/**
 * Validate the shape of each message before any provider work happens.
 *
 * Requiring only "non-empty array" lets `messages: [null]` through to
 * `messages.some((m) => m.role === 'system')`, which throws a TypeError and is
 * reported as a 500. An unsupported role travels further still and dies inside
 * LangChain with MESSAGE_COERCION_FAILURE. Both are caller errors, so both
 * should be a 400 that names the offending index.
 */
export function findMessageProblem(messages: unknown[]): ContentBlockProblem | undefined {
  for (const [index, message] of messages.entries()) {
    if (!isRecord(message)) return { index, reason: 'each message must be an object' };

    const role = typeof message.role === 'string' ? message.role : undefined;
    if (!role) return { index, reason: "each message requires a string 'role' field" };
    if (!SUPPORTED_MESSAGE_ROLES.has(role)) {
      return {
        index,
        reason: `role '${role}' is not supported — use one of ` + `${[...SUPPORTED_MESSAGE_ROLES].join(', ')}`,
      };
    }

    if (role === 'tool' && typeof message.tool_call_id !== 'string') {
      return { index, reason: "a 'tool' message requires a string 'tool_call_id' field" };
    }

    const { content } = message;
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (content === undefined || content === null) {
      // An assistant turn that only calls tools legitimately carries no content.
      if ((role === 'assistant' || role === 'ai') && hasToolCalls) continue;
      return { index, reason: "each message requires a 'content' field" };
    }
    if (typeof content !== 'string' && !Array.isArray(content)) {
      return { index, reason: "'content' must be a string or an array of content blocks" };
    }
  }
  return undefined;
}

/**
 * Validate the multimodal content blocks of a chat request.
 *
 * Checking `type` alone is not enough. The provider adapters either drop or
 * throw on malformed blocks, and both outcomes surface badly:
 *
 * - A block whose payload fails every branch of the converter yields nothing,
 *   so the model answers as if the attachment was never sent.
 * - `_formatImage` throws on a malformed or non-http(s) URL, and that escapes as
 *   a generic HTTP 500 instead of telling the caller what was wrong.
 * - `parseBase64DataUrl` matches any `data:<type>/<subtype>;base64,` URL without
 *   checking for `image/*`, so a PDF becomes an `image` block with
 *   `media_type: application/pdf` that the model cannot read.
 *
 * Validating up front turns all of those into an actionable 400.
 */
export function findContentBlockProblem(messages: unknown[]): ContentBlockProblem | undefined {
  for (const [index, message] of messages.entries()) {
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === 'string') continue;
      const reason = describeContentBlockProblem(block);
      if (reason) return { index, reason };
    }
  }
  return undefined;
}

function describeContentBlockProblem(block: unknown): string | undefined {
  if (!isRecord(block)) return 'each content block must be an object';

  const type = typeof block.type === 'string' ? block.type : undefined;
  if (!type) return "each content block requires a 'type' field";
  if (!SUPPORTED_CONTENT_BLOCK_TYPES.has(type)) {
    return (
      `content block type '${type}' is not supported — this gateway forwards 'text', 'image_url', ` +
      `'file', and 'file_url' only. Send documents as text, or inline them as a 'file' / 'file_url' block`
    );
  }

  if (type === 'text') {
    return typeof block.text === 'string' ? undefined : "a 'text' block requires a string 'text' field";
  }

  if (type === 'file') {
    return describeFileProblem(block.file);
  }

  if (type === 'file_url') {
    return describeFileUrlProblem(block.file_url);
  }

  return describeImageUrlProblem(block.image_url);
}

function describeFileProblem(file: unknown): string | undefined {
  if (!isRecord(file)) return "a 'file' block requires an object 'file' field";
  const fileData = typeof file.file_data === 'string' ? file.file_data : undefined;
  if (!fileData) return "a 'file' block requires a string 'file.file_data' field";
  if (!fileData.startsWith('data:')) {
    return "a 'file' block's 'file_data' must be a base64 data URL starting with 'data:'";
  }
  const match = FILE_BASE64_DATA_URL_PATTERN.exec(fileData);
  if (!match || !match[1].includes('/')) {
    return (
      `malformed base64 data URL. Expected 'data:<mime-type>;base64,<base64>' ` +
      `with a valid type/subtype and standard base64 (no whitespace or URL-safe characters)`
    );
  }
  if (!isDecodableBase64(match[2])) {
    return (
      `base64 payload is not decodable. Check the padding and length — ` +
      `the data must be a multiple of 4 characters with at most two trailing '='`
    );
  }
  return undefined;
}

function describeFileUrlProblem(fileUrl: unknown): string | undefined {
  if (!isRecord(fileUrl)) return "a 'file_url' block requires an object 'file_url' field";
  const url = typeof fileUrl.url === 'string' ? fileUrl.url : undefined;
  if (!url) return "a 'file_url' block requires a string 'file_url.url' field";
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return `'${url}' is not a valid URL. Use an http(s) URL`;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return `URL protocol '${protocol}' is not supported. Use an http(s) URL`;
  }
  return undefined;
}

function describeImageUrlProblem(imageUrl: unknown): string | undefined {
  const url = typeof imageUrl === 'string' ? imageUrl : isRecord(imageUrl) ? imageUrl.url : undefined;
  if (typeof url !== 'string' || url === '') {
    return "an 'image_url' block requires a non-empty 'image_url.url' string";
  }

  if (url.startsWith('data:')) {
    const match = BASE64_DATA_URL_PATTERN.exec(url);
    if (!match) {
      return (
        `malformed base64 data URL. Expected 'data:<mime-type>;base64,<base64>' ` +
        `with standard base64 (no whitespace or URL-safe characters)`
      );
    }
    const mimeType = match[1].toLowerCase();
    if (!mimeType.startsWith('image/')) {
      return (
        `data URL MIME type '${mimeType}' is not an image. Only 'image/*' data URLs are forwarded, ` +
        `because providers reject or ignore other types on an 'image_url' block`
      );
    }
    if (!isDecodableBase64(match[2])) {
      return (
        `base64 payload is not decodable. Check the padding and length — ` +
        `the data must be a multiple of 4 characters with at most two trailing '='`
      );
    }
    return undefined;
  }

  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return `'${url}' is not a valid URL. Use an http(s) URL or a base64 data URL`;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return `URL protocol '${protocol}' is not supported. Use an http(s) URL or a base64 data URL`;
  }
  return undefined;
}

/**
 * A LangChain message content value: plain text, or an array of content blocks
 * (`{type:'text'}`, `{type:'image_url'}`, ...) for multimodal requests.
 */
type MessageContent = string | Record<string, unknown>[];

/**
 * Normalize an OpenAI `message.content` into something LangChain accepts.
 *
 * Content blocks are passed through unchanged so vision requests reach the
 * provider intact — `@langchain/core` coerces `image_url` blocks into the
 * provider's native format. Only genuinely unusable shapes (numbers, objects)
 * are stringified as a last resort.
 *
 * The one rewrite is `image_url: '<url>'` → `image_url: { url: '<url>' }`.
 * `isOpenAIDataBlock` gates on `_isObject(block.image_url)`, so the string form
 * is never recognised as a data block: core forwards it untouched and only
 * Anthropic's adapter happens to accept it. Widening it here keeps the lenient
 * request working on every provider instead of just one.
 */
export function normalizeMessageContent(content: unknown): MessageContent {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return { type: 'text', text: block };
      const record = block as Record<string, unknown>;
      if (record?.type === 'image_url' && typeof record.image_url === 'string') {
        return { ...record, image_url: { url: record.image_url } };
      }
      return record;
    });
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

/**
 * Run any `file` or `file_url` content blocks through the plugin's file
 * processor service. Custom plugins can register processors to fetch URLs,
 * extract text, OCR, etc. Other block types are left untouched.
 *
 * The service is invoked repeatedly if a processor returns another file-like
 * block (e.g. a `file_url` becomes a `file` block, which may then be converted
 * to images by the PDF processor).
 */
async function processMessageContentFileBlocks(
  content: unknown,
  ctx: Context,
  plugin: PluginAiApiServer,
): Promise<unknown> {
  if (!Array.isArray(content)) return content;
  const processed: unknown[] = [];
  for (const block of content) {
    processed.push(...(await processFileBlockChain(block, ctx, plugin, 0)));
  }
  return processed;
}

const MAX_FILE_PROCESSOR_CHAIN_DEPTH = 3;

async function processFileBlockChain(
  block: unknown,
  ctx: Context,
  plugin: PluginAiApiServer,
  depth: number,
): Promise<unknown[]> {
  if (!isRecord(block) || (block.type !== 'file' && block.type !== 'file_url')) {
    return [block];
  }
  if (depth > MAX_FILE_PROCESSOR_CHAIN_DEPTH) {
    return [block];
  }

  const result = await plugin.fileProcessorService.process(block as FileContentBlock, { ctx });
  const results = Array.isArray(result) ? result : [result];

  const next: unknown[] = [];
  for (const item of results) {
    if (isRecord(item) && (item.type === 'file' || item.type === 'file_url')) {
      // The output is still a file-like block; run it through the chain again
      // so that a `file_url` -> `file` -> images pipeline can complete.
      next.push(...(await processFileBlockChain(item, ctx, plugin, depth + 1)));
    } else {
      next.push(item);
    }
  }
  return next;
}

const GATEWAY_MANAGED_PARAMETERS = new Set(['model', 'messages', 'prompt', 'tools', 'tool_choice', 'stream', 'n']);

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
