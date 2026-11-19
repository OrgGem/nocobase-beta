// SPDX-License-Identifier: Apache-2.0

import { LLMProvider, LLMProviderMeta } from '@nocobase/plugin-ai';
import { EmbeddingProvider, SupportedModel } from '../utils/ai-types';
import { EmbeddingsInterface } from '@langchain/core/embeddings';
import { Model } from '@nocobase/database';
import type { AttachmentModel, PluginFileManagerServer } from '@nocobase/plugin-file-manager';
import { serverRequest } from '@nocobase/utils';
import path from 'node:path';
import { Context } from '@nocobase/actions';
import {
  createChatCompletionsFetch,
  createInvalidToolCallFailure,
  createTimeoutFailure,
  isChatCompletionFailure,
  recoverChatCompletionFailure,
  TransportOptions,
} from './chat-completions-transport';
import {
  collectRequestMessageContexts,
  prepareSignedMessage,
  restoreRequestMessageContexts,
  shortToolCallId,
  SIGNED_CONTEXT_KEY,
  SignedContextScope,
  SignedStreamAccumulator,
} from './signed-context';

export { createMappingFetch } from './chat-completions-transport';

// Keepalive marker — zero-width space prefix to distinguish from real content
const KEEPALIVE_PREFIX = '\u200B\u200B\u200B';
const DEFAULT_KEEPALIVE_INTERVAL_MS = 5000;
const DEFAULT_STREAM_CHUNK_SIZE = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function cloneDeep<T>(value: T): T {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  const structuredCloneFn = (globalThis as any).structuredClone;
  if (typeof structuredCloneFn === 'function') {
    try {
      return structuredCloneFn(value);
    } catch {
      // Fall through to JSON cloning for plain API payloads.
    }
  }

  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolve a module from the main NocoBase app's node_modules.
 */
function requireFromApp(moduleName: string) {
  const appNodeModules = process.env.NODE_MODULES_PATH || path.join(process.cwd(), 'node_modules');
  const resolved = require.resolve(moduleName, { paths: [appNodeModules] });
  return require(resolved);
}

let _ChatOpenAI: any = null;
function getChatOpenAI() {
  if (!_ChatOpenAI) {
    const mod = requireFromApp('@langchain/openai');
    _ChatOpenAI = mod.ChatOpenAI;
  }
  return _ChatOpenAI;
}

/**
 * Lazy-load ChatOpenAICompletions — the lower-level class used as the base
 * for ReasoningChatOpenAI so we can support reasoning_content round-trips
 * required by models like DeepSeek-R1.
 */
let _ChatOpenAICompletions: any = null;
function getChatOpenAICompletions() {
  if (!_ChatOpenAICompletions) {
    const mod = requireFromApp('@langchain/openai');
    _ChatOpenAICompletions = mod.ChatOpenAICompletions;
  }
  return _ChatOpenAICompletions;
}

/**
 * Strip the `__thought__<base64>` suffix that Gemini models append to
 * tool call IDs during streaming. The suffix is excessively long and
 * causes errors when langgraph reads messages back from history.
 */
export function stripGeminiThoughtSuffix(id: string | undefined): string | undefined {
  return typeof id === 'string' ? shortToolCallId(id) : id;
}

const REQUEST_MESSAGE_CONTEXTS_KEY = '__custom_llm_request_contexts';
const STREAM_THINKING_BLOCKS_KEY = '__custom_llm_stream_thinking_blocks';

/**
 * Preserve provider-specific state across the OpenAI message conversion. Tool
 * calls are released after the stream ends, when their full IDs and signatures
 * are known and the gateway has confirmed a complete response.
 */
function createCompatibleCompletionsClass(
  scope: SignedContextScope,
  enableReasoning: boolean,
  normalizeClaudeSampling: boolean,
  transportOptions: TransportOptions,
) {
  const ChatOpenAICompletions = getChatOpenAICompletions();
  if (!ChatOpenAICompletions) {
    throw new Error('The installed @langchain/openai does not provide ChatOpenAICompletions');
  }

  return class CompatibleChatOpenAICompletions extends ChatOpenAICompletions {
    constructor(fields: Record<string, unknown>) {
      super(fields);
    }

    async _generate(messages: any[], options: any, runManager?: any) {
      const contexts = collectRequestMessageContexts(messages, scope, enableReasoning);
      const nextOptions = {
        ...(options || {}),
        [REQUEST_MESSAGE_CONTEXTS_KEY]: contexts,
        options: { ...(options?.options || {}), [REQUEST_MESSAGE_CONTEXTS_KEY]: contexts },
      };
      return super._generate(messages, nextOptions, runManager);
    }

    async *_streamResponseChunks(messages: any[], options: any, runManager?: any) {
      const contexts = collectRequestMessageContexts(messages, scope, enableReasoning);
      const stream = super._streamResponseChunks(messages, {
        ...(options || {}),
        [REQUEST_MESSAGE_CONTEXTS_KEY]: contexts,
      });
      const accumulator = new SignedStreamAccumulator();
      const ChatGenerationChunk = requireFromApp('@langchain/core/outputs').ChatGenerationChunk;
      let finishReason: string | undefined;

      for await (const chunk of stream) {
        const message = chunk.message;
        const kwargs = { ...(message.additional_kwargs || {}) };
        const rawToolCalls = kwargs.tool_calls;
        const thinkingBlocks = kwargs[STREAM_THINKING_BLOCKS_KEY];
        accumulator.addToolCalls(rawToolCalls);
        accumulator.addThinkingBlocks(thinkingBlocks);
        if (typeof chunk.generationInfo?.finish_reason === 'string') {
          finishReason = chunk.generationInfo.finish_reason;
        }
        delete kwargs.tool_calls;
        delete kwargs[STREAM_THINKING_BLOCKS_KEY];

        const safeMessage = createAIMessageChunk({
          id: message.id,
          name: message.name,
          content: message.content,
          additional_kwargs: kwargs,
          response_metadata: message.response_metadata,
          usage_metadata: message.usage_metadata,
        });
        const safeChunk = new ChatGenerationChunk({
          message: safeMessage,
          text: chunk.text,
          generationInfo: chunk.generationInfo,
        });
        yield safeChunk;
        await runManager?.handleLLMNewToken(
          safeChunk.text ?? '',
          { prompt: options?.promptIndex ?? 0, completion: safeChunk.generationInfo?.completion ?? 0 },
          undefined,
          undefined,
          undefined,
          { chunk: safeChunk },
        );
      }

      if (options?.signal?.aborted) return;
      const { toolCallChunks, signedContext } = accumulator.result(scope);
      if (finishReason === 'tool_calls' && !toolCallChunks.length) {
        throw createInvalidToolCallFailure(transportOptions, 'stream');
      }
      for (const toolCall of toolCallChunks) {
        try {
          if (typeof toolCall.id !== 'string' || !toolCall.id || typeof toolCall.name !== 'string' || !toolCall.name) {
            throw new Error('Missing tool call identifier or name');
          }
          const args = JSON.parse(String(toolCall.args));
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            throw new Error('Tool call arguments must be an object');
          }
        } catch {
          throw createInvalidToolCallFailure(transportOptions, 'stream');
        }
      }
      if (toolCallChunks.length || signedContext) {
        const message = createAIMessageChunk({
          content: '',
          tool_call_chunks: toolCallChunks,
          additional_kwargs: signedContext ? { [SIGNED_CONTEXT_KEY]: signedContext } : {},
        });
        const finalChunk = new ChatGenerationChunk({
          message,
          text: '',
          generationInfo: { prompt: options?.promptIndex ?? 0, completion: 0 },
        });
        yield finalChunk;
        await runManager?.handleLLMNewToken(
          '',
          { prompt: options?.promptIndex ?? 0, completion: 0 },
          undefined,
          undefined,
          undefined,
          { chunk: finalChunk },
        );
      }
    }

    _convertCompletionsDeltaToBaseMessageChunk(delta: any, rawResponse: any, defaultRole?: any) {
      const chunk = super._convertCompletionsDeltaToBaseMessageChunk(delta, rawResponse, defaultRole);
      const thinkingBlocks = delta?.thinking_blocks ?? delta?.provider_specific_fields?.thinking_blocks;
      if (Array.isArray(thinkingBlocks)) {
        chunk.additional_kwargs = {
          ...(chunk.additional_kwargs || {}),
          [STREAM_THINKING_BLOCKS_KEY]: thinkingBlocks,
        };
      }
      return chunk;
    }

    _convertCompletionsMessageToBaseMessage(message: any, rawResponse: any) {
      const prepared = prepareSignedMessage(message, scope);
      const result = super._convertCompletionsMessageToBaseMessage(prepared.message, rawResponse);
      if (
        result.invalid_tool_calls?.length ||
        result.tool_calls?.some(
          (toolCall: { id?: string; name?: string; args?: unknown }) =>
            !toolCall?.id ||
            !toolCall.name ||
            !toolCall.args ||
            typeof toolCall.args !== 'object' ||
            Array.isArray(toolCall.args),
        ) ||
        (rawResponse?.choices?.[0]?.finish_reason === 'tool_calls' && !result.tool_calls?.length)
      ) {
        throw createInvalidToolCallFailure(transportOptions);
      }
      if (prepared.signedContext) {
        result.additional_kwargs = {
          ...(result.additional_kwargs || {}),
          [SIGNED_CONTEXT_KEY]: prepared.signedContext,
        };
        result.lc_kwargs.additional_kwargs = result.additional_kwargs;
      }
      return result;
    }

    async completionWithRetry(request: any, requestOptions?: any): Promise<any> {
      const contexts = requestOptions?.[REQUEST_MESSAGE_CONTEXTS_KEY];
      if (Array.isArray(contexts)) restoreRequestMessageContexts(request, contexts);
      if (normalizeClaudeSampling) {
        if (request.temperature === -1) delete request.temperature;
        if (request.top_p === -1) delete request.top_p;
        if (request.temperature !== undefined && request.temperature !== null) {
          delete request.top_p;
        }
        delete request.top_k;
      }
      try {
        return await super.completionWithRetry(request, requestOptions);
      } catch (error) {
        const failure = recoverChatCompletionFailure(error);
        if (failure) throw failure;
        if (
          error &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'TimeoutError' &&
          !requestOptions?.signal?.aborted
        ) {
          throw createTimeoutFailure(transportOptions);
        }
        throw error;
      }
    }
  };
}

let _AIMessageChunk: any = null;
function getAIMessageChunk() {
  if (!_AIMessageChunk) {
    const mod = requireFromApp('@langchain/core/messages');
    _AIMessageChunk = mod.AIMessageChunk;
  }
  return _AIMessageChunk;
}

function createAIMessageChunk(fields: Record<string, any>) {
  const AIMessageChunk = getAIMessageChunk();
  return new AIMessageChunk(fields);
}

function createKeepAliveChunk() {
  return createAIMessageChunk({
    content: KEEPALIVE_PREFIX,
    additional_kwargs: { __keepalive: true },
  });
}

function normalizePositiveNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function hasToolCallDelta(chunk: any): boolean {
  return Boolean(chunk?.tool_call_chunks?.length || chunk?.tool_calls?.length);
}

function createSplitMessageChunk(source: any, content: string, index: number, total: number) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const fields: Record<string, any> = {
    content,
    additional_kwargs: isFirst ? cloneDeep(source?.additional_kwargs || {}) : {},
    response_metadata: isLast ? cloneDeep(source?.response_metadata || {}) : {},
  };

  if (isFirst && source?.id) {
    fields.id = source.id;
  }
  if (isFirst && source?.name) {
    fields.name = source.name;
  }
  if (isLast && source?.usage_metadata) {
    fields.usage_metadata = cloneDeep(source.usage_metadata);
  }
  if (isLast && source?.tool_calls?.length) {
    fields.tool_calls = cloneDeep(source.tool_calls);
  }
  if (isLast && source?.invalid_tool_calls?.length) {
    fields.invalid_tool_calls = cloneDeep(source.invalid_tool_calls);
  }

  return createAIMessageChunk(fields);
}

function splitTextChunk(chunk: any, chunkSize: number): any[] {
  const content = chunk?.content;
  if (
    typeof content !== 'string' ||
    content.length <= chunkSize ||
    content === KEEPALIVE_PREFIX ||
    hasToolCallDelta(chunk)
  ) {
    return [chunk];
  }

  const parts: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    parts.push(content.slice(i, i + chunkSize));
  }
  return parts.map((part, index) => createSplitMessageChunk(chunk, part, index, parts.length));
}

function splitStreamChunk(chunk: any, chunkSize: number): any[] {
  return splitTextChunk(chunk, chunkSize);
}

async function* streamWithKeepAliveAndChunking(
  iterable: AsyncIterable<any>,
  options: { keepAlive: boolean; intervalMs: number; chunkSize: number },
) {
  const iterator = iterable?.[Symbol.asyncIterator]?.();
  if (!iterator) {
    return;
  }

  if (!options.keepAlive) {
    while (true) {
      const { value: chunk, done: chunkDone } = await iterator.next();
      if (chunkDone) break;
      for (const splitChunk of splitStreamChunk(chunk, options.chunkSize)) {
        yield splitChunk;
      }
    }
    return;
  }

  let done = false;
  let toolCallActive = false;
  let next = iterator.next();

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const result = await Promise.race([
        next.then(
          (value) => ({ type: 'value' as const, value }),
          (error) => ({ type: 'error' as const, error }),
        ),
        new Promise<{ type: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ type: 'timeout' }), options.intervalMs);
        }),
      ]);

      if (timer) {
        clearTimeout(timer);
      }

      if (result.type === 'timeout') {
        if (!toolCallActive) {
          yield createKeepAliveChunk();
        }
        continue;
      }

      if (result.type === 'error') {
        throw result.error;
      }

      if (result.value.done) {
        done = true;
        break;
      }

      const chunks = splitStreamChunk(result.value.value, options.chunkSize);
      for (const chunk of chunks) {
        if (hasToolCallDelta(chunk)) {
          toolCallActive = true;
        } else if (chunk?.content && chunk.content !== KEEPALIVE_PREFIX) {
          toolCallActive = false;
        }
        yield chunk;
      }

      next = iterator.next();
    }
  } finally {
    if (!done && typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch {
        // Ignore cleanup errors from aborted upstream iterators.
      }
    }
  }
}

function stripToolCallTags(content: string): string | null {
  if (typeof content !== 'string') {
    return content;
  }
  return content.replace(/<[|｜]tool▁(?:calls▁begin|calls▁end|call▁begin|call▁end|sep)[|｜]>/g, '');
}

function extractTextContent(content: any, contentPath?: string): string {
  if (contentPath && contentPath !== 'auto') {
    try {
      const keys = contentPath.split('.');
      let result = content;
      for (const key of keys) {
        if (result == null) break;
        result = result[key];
      }
      if (typeof result === 'string') return result;
    } catch {
      // Fall through to auto
    }
  }
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block && block.type === 'text')
      .map((block: any) => block.text ?? '')
      .join('');
  }
  if (content && typeof content === 'object' && content.text) {
    return String(content.text);
  }
  return '';
}

/**
 * Detect whether a MIME type is text-decodable (UTF-8 safe).
 */
function isTextMimetype(mimetype?: string): boolean {
  if (!mimetype) return false;
  // All text/* subtypes are UTF-8 decodable
  if (mimetype.startsWith('text/')) return true;
  // Common text-based application types
  const TEXT_APPLICATION_TYPES = new Set([
    'application/json',
    'application/xml',
    'application/xhtml+xml',
    'application/atom+xml',
    'application/rss+xml',
    'application/csv',
    'application/javascript',
    'application/typescript',
    'application/x-javascript',
    'application/x-typescript',
    'application/x-yaml',
    'application/yaml',
    'application/x-json',
    'application/geo+json',
    'application/ld+json',
    'application/manifest+json',
    'application/graphql',
    'application/x-www-form-urlencoded',
    'application/toml',
    'application/x-sh',
    'application/x-shellscript',
    'application/sql',
  ]);
  return TEXT_APPLICATION_TYPES.has(mimetype);
}

function safeParseJSON(str: any, fieldName?: string): any {
  if (!str || typeof str !== 'string') return {};
  try {
    return JSON.parse(str);
  } catch (e) {
    // Warn so misconfigured JSON doesn't silently fall through to defaults
    console.warn(`[CustomLLM] Failed to parse ${fieldName || 'JSON config'}: ${(e as Error).message}`);
    return {};
  }
}

/**
 * Get a nested value from an object using a dot-path string.
 * e.g. getByPath({a:{b:"hello"}}, "a.b") => "hello"
 */
function getByPath(obj: any, dotPath: string): any {
  if (!obj || !dotPath) return undefined;
  const keys = dotPath.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Check if a text string is a keepalive marker.
 */
function isKeepAlive(text: string): boolean {
  return typeof text === 'string' && text.startsWith(KEEPALIVE_PREFIX);
}

/* bindTools empty-tool-properties fix is now integrated into patchRunnableForSanitization below */

/**
 * Strip Gemini __thought__ suffixes from tool_calls on an AIMessage (mutates in place).
 */
function sanitizeAIMessageToolCalls(msg: any): void {
  if (!msg) return;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tc.id = stripGeminiThoughtSuffix(tc.id);
    }
  }
  if (msg.tool_call_chunks) {
    for (const tc of msg.tool_call_chunks) {
      tc.id = stripGeminiThoughtSuffix(tc.id);
    }
  }
}

/**
 * Estimate token count for a message.
 * ⚠️ ROUGH HEURISTIC ONLY — not suitable for hard budget enforcement.
 * Uses CJK chars ~1 token each, Latin ~4 chars/token. Does NOT account
 * for tool_calls payload, role/structure overhead, or emoji (which cost
 * 2-3 tokens each but are counted as 1 here). Consider js-tiktoken if
 * accuracy is critical.
 */
function estimateTokens(msg: any): number {
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    text = msg.content.map((c: any) => c.text || '').join('');
  }
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    // CJK Unified Ideographs and related blocks are ~1 token each
    tokens += char.charCodeAt(0) > 0x2e80 ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * Truncate messages to fit within a token budget.
 *
 * IMPORTANT: Messages are removed in complete "conversation turns" to
 * preserve the strict AI↔Tool message pairing required by LangChain and
 * the OpenAI API. A turn is:
 *   - A single user/system message, OR
 *   - An AI message with tool_calls + all its corresponding ToolMessages
 *
 * The system message (if first) and the most recent messages are preserved.
 */
function truncateMessages(messages: any[], maxTokens: number): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  if (totalTokens <= maxTokens) return messages;

  const result = [...messages];
  // Preserve system message separately
  const systemMsg =
    result.length > 0 && (result[0].getType?.() === 'system' || result[0]._getType?.() === 'system')
      ? result.shift()
      : null;
  const systemTokenCost = systemMsg ? estimateTokens(systemMsg) : 0;
  totalTokens -= systemTokenCost;

  // Group remaining messages into conversation turns.
  // A turn is: [user/human] or [ai + tool*] (ai message with its tool responses)
  const turns: any[][] = [];
  let i = 0;
  while (i < result.length) {
    const msg = result[i];
    const msgType = msg.getType?.() ?? msg._getType?.() ?? msg.role ?? '';

    if (msgType === 'ai' || msgType === 'assistant') {
      // Group this AI message with all following tool messages
      const turn = [msg];
      i++;
      while (i < result.length) {
        const next = result[i];
        const nextType = next.getType?.() ?? next._getType?.() ?? next.role ?? '';
        if (nextType === 'tool') {
          turn.push(next);
          i++;
        } else {
          break;
        }
      }
      turns.push(turn);
    } else {
      turns.push([msg]);
      i++;
    }
  }

  // Remove oldest turns until under budget (including system message cost),
  // keeping at least the last turn
  const effectiveBudget = maxTokens - systemTokenCost;
  while (turns.length > 1 && totalTokens > effectiveBudget) {
    const removed = turns.shift() ?? [];
    for (const msg of removed) {
      totalTokens -= estimateTokens(msg);
    }
  }

  // Flatten turns back into a flat message array
  const truncated = turns.flat();
  if (systemMsg) {
    truncated.unshift(systemMsg);
  }
  return truncated;
}

/**
 * Patch a runnable (model or bound model) so that `invoke` and `stream`
 * sanitize tool call IDs on every AIMessage output.
 * Also patches `bindTools` and `bind` so that derived runnables inherit
 * the sanitization — this is critical because langgraph calls
 * `model.bindTools(tools)` and then uses the BOUND model.
 */
function patchRunnableForSanitization(
  runnable: any,
  options?: {
    enableTokenTruncation?: boolean;
    maxContextTokens?: number;
    enableToolRetry?: boolean;
    maxToolRetries?: number;
    streamKeepAlive?: boolean;
    keepAliveIntervalMs?: number;
    streamChunkSize?: number;
  },
): any {
  if (!runnable || runnable.__toolCallSanitized) return runnable;
  runnable.__toolCallSanitized = true;

  // Patch invoke — covers non-streaming and internal streaming-via-invoke
  const origInvoke = runnable.invoke?.bind(runnable);
  if (origInvoke) {
    runnable.invoke = async function (...args: any[]) {
      let messages = args[0];
      if (options?.enableTokenTruncation && options.maxContextTokens) {
        messages = truncateMessages(messages, options.maxContextTokens);
        args[0] = messages;
      }

      const retries = options?.enableToolRetry ? options.maxToolRetries || 1 : 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const result = await origInvoke(...args);
          sanitizeAIMessageToolCalls(result);
          return result;
        } catch (e: any) {
          // Only retry model-output failures (e.g. invalid tool-call JSON).
          // HTTP/transport errors (auth, rate limit, network, aborts) would
          // fail again and the corrective prompt below does not apply.
          const isTransportError =
            isChatCompletionFailure(e) ||
            typeof e?.status === 'number' ||
            e?.name === 'AbortError' ||
            e?.code === 'ECONNABORTED' ||
            e?.code === 'ETIMEDOUT';
          if (attempt === retries || isTransportError) {
            throw e;
          }
          if (Array.isArray(messages)) {
            try {
              const HumanMessage = requireFromApp('@langchain/core/messages').HumanMessage;
              // Clone to avoid mutating the caller's original message array
              messages = [
                ...messages,
                new HumanMessage(
                  `Your previous response was invalid. Please correct it and try again. Error: ${e.message}`,
                ),
              ];
              args[0] = messages;
            } catch (err) {
              // Ignore errors if HumanMessage fails to import
            }
          }
        }
      }
    };
  }

  // Patch stream — covers streaming path.
  // NOTE: Tool-call retry is NOT applied here because stream() returns an
  // async iterable — errors from bad tool-call JSON surface during iteration
  // (downstream in ai-employee.ts), not during stream creation. Retry at this
  // level would require buffering the entire stream, which defeats the purpose.
  // Auto tool-call retry is only effective via the invoke() path.
  const origStream = runnable.stream?.bind(runnable);
  if (origStream) {
    runnable.stream = async function (...args: any[]) {
      let messages = args[0];
      if (options?.enableTokenTruncation && options.maxContextTokens) {
        messages = truncateMessages(messages, options.maxContextTokens);
        args[0] = messages;
      }

      const iter = await origStream(...args);
      const safeIter = streamWithKeepAliveAndChunking(iter, {
        keepAlive: options?.streamKeepAlive ?? false,
        intervalMs: normalizePositiveNumber(options?.keepAliveIntervalMs, DEFAULT_KEEPALIVE_INTERVAL_MS),
        chunkSize: normalizePositiveNumber(options?.streamChunkSize, DEFAULT_STREAM_CHUNK_SIZE),
      });

      return (async function* () {
        for await (const value of safeIter) {
          if (value) {
            sanitizeAIMessageToolCalls(value);
          }
          yield value;
        }
      })();
    };
  }

  // Patch bindTools — combined wrapper that fixes empty tool properties (Gemini
  // rejects `properties: {}`) AND propagates sanitization to derived runnables.
  const PLACEHOLDER_PROP = {
    _placeholder: { type: 'string', description: 'No parameters required' },
  };

  /**
   * Recursively fix empty properties in a JSON Schema-like object.
   * Handles: top-level properties, function.parameters.properties,
   * and nested anyOf/oneOf/allOf schemas.
   */
  function fixPropertiesInSchema(schema: any): void {
    if (!schema || typeof schema !== 'object') return;
    if (schema.properties && typeof schema.properties === 'object' && Object.keys(schema.properties).length === 0) {
      schema.properties = { ...PLACEHOLDER_PROP };
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(schema[key])) {
        schema[key].forEach((sub: any) => fixPropertiesInSchema(sub));
      }
    }
  }

  const origBindTools = runnable.bindTools?.bind(runnable);
  if (origBindTools) {
    runnable.bindTools = function (tools: any[], kwargs?: any) {
      // Phase 1: Pre-conversion fix for raw JSON Schema tool definitions
      const fixedTools = tools.map((tool: any) => {
        if (!tool || typeof tool !== 'object') return tool;
        // Skip Zod schema tools — they'll be handled post-conversion
        if (typeof tool.schema?.safeParse === 'function') return tool;
        const schema = tool.schema;
        if (schema && typeof schema === 'object' && !schema.safeParse) {
          const props = schema.properties;
          if (props && typeof props === 'object' && Object.keys(props).length === 0) {
            return { ...tool, schema: { ...schema, properties: { ...PLACEHOLDER_PROP } } };
          }
        }
        const funcParams = tool.function?.parameters;
        if (funcParams?.properties) {
          if (typeof funcParams.properties === 'object' && Object.keys(funcParams.properties).length === 0) {
            return {
              ...tool,
              function: { ...tool.function, parameters: { ...funcParams, properties: { ...PLACEHOLDER_PROP } } },
            };
          }
        }
        return tool;
      });
      const bound = origBindTools(fixedTools, kwargs);
      // Phase 2: Post-conversion fix — patch the converted tools in the result
      try {
        for (const config of [bound?.kwargs, bound?.defaultOptions, bound?.config]) {
          if (Array.isArray(config?.tools)) {
            for (const tool of config.tools) {
              if (tool?.function?.parameters) fixPropertiesInSchema(tool.function.parameters);
              if (tool?.parameters) fixPropertiesInSchema(tool.parameters);
            }
          }
        }
      } catch {
        /* don't break tool binding if post-fix inspection fails */
      }
      return patchRunnableForSanitization(bound, options);
    };
  }

  // Patch bind — bindTools internally calls bind(), some runnables use it directly
  const origBind = runnable.bind?.bind(runnable);
  if (origBind) {
    runnable.bind = function (...args: any[]) {
      const bound = origBind(...args);
      return patchRunnableForSanitization(bound, options);
    };
  }

  return runnable;
}

export class CustomLLMProvider extends LLMProvider {
  get baseURL() {
    return null;
  }

  private get requestConfig() {
    return safeParseJSON(this.serviceOptions?.requestConfig, 'requestConfig');
  }

  private get responseConfig() {
    return safeParseJSON(this.serviceOptions?.responseConfig, 'responseConfig');
  }

  private getProviderDefaultHeaders(): Record<string, string> {
    return typeof this.getDefaultHeaders === 'function' ? this.getDefaultHeaders() : {};
  }

  createModel() {
    const { apiKey, disableStream, timeout, streamKeepAlive, keepAliveIntervalMs, enableReasoning } =
      this.serviceOptions || {};
    // baseURL comes from core's options.baseURL field
    const baseURL = this.serviceOptions?.baseURL;
    const parsedBaseURL = baseURL ? new URL(baseURL) : undefined;
    const isOpenAI = parsedBaseURL?.protocol === 'https:' && parsedBaseURL.hostname === 'api.openai.com';
    const {
      responseFormat,
      jsonSchemaDefinition,
      enableTokenTruncation,
      maxContextTokens,
      enableToolRetry,
      maxToolRetries,
    } = this.modelOptions || {};
    const reqConfig = this.requestConfig;
    const resConfig = this.responseConfig;

    const reasoningMode = this.modelReasoningOptions?.mode;
    const modelKwargs: Record<string, unknown> = {
      ...(reqConfig.modelKwargs || {}),
    };

    // NOTE: response_format is NOT set in modelKwargs here.
    // It is applied lazily in prepareChain() so that withStructuredOutput()
    // (from AI Employee context) takes priority when both are configured.
    // See: prepareChain() override below.

    if (reqConfig.extraBody && typeof reqConfig.extraBody === 'object') {
      Object.assign(modelKwargs, reqConfig.extraBody);
    }

    // Exclude plugin-specific fields from the LangChain config spread.
    // Fields like maxToolRetries, enableToolRetry, enableVision etc. are not
    // LangChain constructor params and could cause collisions (e.g. maxRetries).
    const {
      responseFormat: _rf,
      jsonSchemaDefinition: _jsd,
      enableTokenTruncation: _ett,
      maxContextTokens: _mct,
      enableToolRetry: _etr,
      maxToolRetries: _mtr,
      enableVision: _ev,
      ...langchainModelOptions
    } = this.modelOptions || {};
    const config: Record<string, any> = {
      apiKey,
      ...langchainModelOptions,
      modelKwargs,
      configuration: {
        baseURL,
      },
      verbose: false,
    };

    if (
      (isOpenAI || reqConfig.useReasoningEffort === true) &&
      reasoningMode &&
      reasoningMode !== 'default' &&
      langchainModelOptions.reasoning == null &&
      !Object.prototype.hasOwnProperty.call(modelKwargs, 'reasoning') &&
      !Object.prototype.hasOwnProperty.call(modelKwargs, 'reasoning_effort')
    ) {
      config.reasoning = { effort: reasoningMode === 'off' ? 'none' : reasoningMode };
    }

    // Generic OpenAI-compatible endpoints may reject prompt_cache_key, so only OpenAI receives
    // an automatic session key. Other endpoints can opt in using requestConfig.
    if (Object.prototype.hasOwnProperty.call(modelKwargs, 'prompt_cache_key')) {
      config.promptCacheKey = modelKwargs.prompt_cache_key;
    } else if (
      (isOpenAI || reqConfig.useSessionPromptCache === true) &&
      this.requestContext?.sessionId &&
      langchainModelOptions.promptCacheKey == null
    ) {
      config.promptCacheKey = this.requestContext.sessionId;
    }

    // Disable streaming for models with long thinking phases
    // that return empty stream values causing processing to terminate
    if (disableStream) {
      config.streaming = false;
    }

    // Apply a long request timeout for slow-thinking models. The OpenAI SDK
    // default is 10 minutes; custom providers can exceed that before headers.
    const timeoutMs = timeout && Number(timeout) > 0 ? Number(timeout) : 0;
    const effectiveTimeoutMs = Math.max(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    config.timeout = effectiveTimeoutMs;
    config.configuration.timeout = effectiveTimeoutMs;

    // Preserve base provider headers (for example OpenCode's per-session headers).
    config.configuration.defaultHeaders = this.getProviderDefaultHeaders();
    if (reqConfig.extraHeaders && typeof reqConfig.extraHeaders === 'object') {
      config.configuration.defaultHeaders = { ...config.configuration.defaultHeaders, ...reqConfig.extraHeaders };
    }

    const transportOptions: TransportOptions = {
      mapping: resConfig.responseMapping,
      retry: reqConfig.retry,
      sessionId: this.requestContext?.sessionId,
      model: typeof this.modelOptions?.model === 'string' ? this.modelOptions.model : undefined,
      logger: this.app?.logger,
      sdkErrorEnvelope: true,
    };
    config.configuration.fetch = createChatCompletionsFetch(transportOptions);

    const serviceName = this.modelOptions?.llmService;
    const scope: SignedContextScope = {
      service:
        typeof serviceName === 'string' && serviceName
          ? serviceName
          : parsedBaseURL
            ? `${parsedBaseURL.origin}${parsedBaseURL.pathname}`
            : '',
      model: typeof this.modelOptions?.model === 'string' ? this.modelOptions.model : '',
      ...(this.requestContext?.sessionId ? { sessionId: this.requestContext.sessionId } : {}),
    };
    const claudeAliases = Array.isArray(this.serviceOptions?.claudeModelAliases)
      ? this.serviceOptions.claudeModelAliases
      : [];
    const CompatibleCompletions = createCompatibleCompletionsClass(
      scope,
      enableReasoning === true,
      claudeAliases.includes(scope.model),
      transportOptions,
    );
    // A response can fail after HTTP 200. Do not let AsyncCaller resend it.
    // Non-streaming HTTP retries remain available through requestConfig.retry.
    const completions = new CompatibleCompletions({ ...config, maxRetries: 0 });
    const forceCompletions = this.serviceOptions?.apiMode === 'chat-completions' || enableReasoning === true;
    let model = forceCompletions ? completions : new (getChatOpenAI())({ ...config, completions });

    // Sanitize Gemini's __thought__<base64> suffixes in tool call IDs.
    // Patches invoke/stream/bindTools/bind at the public API level so that
    // ALL code paths (including langgraph's internal model calls via
    // RunnableBinding after bindTools) return clean IDs.
    model = patchRunnableForSanitization(model, {
      enableTokenTruncation,
      maxContextTokens,
      enableToolRetry,
      maxToolRetries,
      streamKeepAlive: streamKeepAlive !== false,
      keepAliveIntervalMs: normalizePositiveNumber(keepAliveIntervalMs, DEFAULT_KEEPALIVE_INTERVAL_MS),
      streamChunkSize: normalizePositiveNumber(this.serviceOptions?.streamChunkSize, DEFAULT_STREAM_CHUNK_SIZE),
    });

    return model;
  }

  /**
   * Override listModels to support LiteLLM/custom proxies whose model-listing
   * endpoint, auth scheme, or response shape deviates from OpenAI's GET /models.
   *
   * Configured via the `modelsConfig` service option:
   * {
   *   "path": "models",        // endpoint appended to baseURL
   *   "auth": "bearer",        // "bearer" | "api-key" | "none"
   *   "headers": {},           // extra headers
   *   "dataPath": "data",      // dot-path to the model array in the response
   *   "idPath": "id"           // dot-path to the id within each item
   * }
   */
  async listModels(): Promise<{ models?: { id: string }[]; code?: number; errMsg?: string }> {
    const options = this.serviceOptions || {};
    const modelsConfig = safeParseJSON(options.modelsConfig, 'modelsConfig');
    const pathName = typeof modelsConfig.path === 'string' && modelsConfig.path ? modelsConfig.path : 'models';
    const auth = modelsConfig.auth === 'api-key' || modelsConfig.auth === 'none' ? modelsConfig.auth : 'bearer';
    const apiKey = options.apiKey;

    let url: string;
    try {
      url = this.buildRequestURL(pathName);
    } catch (e) {
      return { code: 400, errMsg: e instanceof Error ? e.message : String(e) };
    }

    if (auth !== 'none' && !apiKey) {
      return { code: 400, errMsg: 'API Key required' };
    }

    const headers: Record<string, string> = {
      ...this.getProviderDefaultHeaders(),
      ...(modelsConfig.headers && typeof modelsConfig.headers === 'object' ? modelsConfig.headers : {}),
    };
    if (auth === 'bearer') {
      headers.Authorization = `Bearer ${apiKey}`;
    } else if (auth === 'api-key') {
      headers['x-api-key'] = String(apiKey);
    }

    try {
      const response = await serverRequest({ method: 'GET', url, headers, timeout: 30_000 });
      const body = response.data;
      const rawItems = getByPath(body, modelsConfig.dataPath || 'data');

      if (rawItems == null) {
        return { models: [] };
      }

      const items = Array.isArray(rawItems) ? rawItems : [];
      const models = items.map((item: any) => {
        if (modelsConfig.idPath) {
          return { id: String(getByPath(item, modelsConfig.idPath) ?? '') };
        }
        if (typeof item === 'string') {
          return { id: item };
        }
        return { id: String(item?.id ?? item?.model ?? '') };
      });

      return { models };
    } catch (e) {
      const err = e as { response?: { status?: number; data?: any; statusText?: string }; message?: string };
      const status = err.response?.status || 500;
      const data = err.response?.data;
      const errorMsg =
        data?.error?.message ??
        data?.message ??
        (typeof data?.error === 'string' ? data.error : undefined) ??
        (typeof data === 'string' ? data : undefined) ??
        err.response?.statusText ??
        err.message ??
        'Failed to list models';
      return { code: status, errMsg: errorMsg };
    }
  }

  /**
   * Override prepareChain to apply response_format lazily.
   *
   * When `context.structuredOutput` is present (set by AI Employee),
   * the base class's `withStructuredOutput()` takes full priority and
   * response_format from model settings is NOT applied — avoiding the
   * double-schema conflict that some providers reject.
   *
   * When structuredOutput is NOT present, the user's response_format
   * (json_object, json_schema) is applied via a bound model kwargs.
   */
  prepareChain(context: any) {
    // Let the base class handle tools + structuredOutput
    let chain = super.prepareChain(context);

    // Only apply response_format when structuredOutput is NOT active
    if (!context?.structuredOutput) {
      const { responseFormat, jsonSchemaDefinition } = this.modelOptions || {};

      if (responseFormat === 'json_schema' && jsonSchemaDefinition) {
        try {
          const parsedSchema = JSON.parse(jsonSchemaDefinition);
          chain = chain.bind({
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'custom_response',
                strict: true,
                schema: parsedSchema,
              },
            },
          });
        } catch (e) {
          console.warn('[CustomLLM] Failed to parse jsonSchemaDefinition', e);
        }
      } else if (responseFormat && responseFormat !== 'text') {
        // json_object mode — don't send { type: 'text' } as it breaks non-OpenAI providers
        chain = chain.bind({
          response_format: { type: responseFormat },
        });
      }
    }

    return chain;
  }

  parseResponseChunk(chunk: any): string | null {
    const resConfig = this.responseConfig;
    const text = extractTextContent(chunk, resConfig.contentPath);

    // Return keepalive prefix as-is so protocol.content() emits SSE event.
    // The zero-width spaces are invisible in the client UI but keep
    // proxy/gateway connections alive during long model thinking phases.
    if (isKeepAlive(text)) {
      return KEEPALIVE_PREFIX;
    }

    return stripToolCallTags(text);
  }

  parseResponseMessage(message: Model) {
    const { content: rawContent, messageId, metadata, role, toolCalls, attachments, workContext, createdAt } = message;
    const content: Record<string, any> = {
      ...(rawContent ?? {}),
      messageId,
      metadata,
      attachments,
      workContext,
    };

    if (toolCalls) {
      content.tool_calls = Array.isArray(toolCalls)
        ? toolCalls.map((toolCall: Record<string, unknown> | null) => {
            if (!toolCall || typeof toolCall !== 'object') return toolCall;
            const { provider_specific_fields: _providerFields, extra_content: _extraContent, ...rest } = toolCall;
            return { ...rest, id: typeof rest.id === 'string' ? shortToolCallId(rest.id) : rest.id };
          })
        : toolCalls;
    }

    if (Array.isArray(content.content)) {
      const textBlocks = content.content.filter((block: any) => block.type === 'text');
      content.content = textBlocks.map((block: any) => block.text).join('') || '';
    }

    if (typeof content.content === 'string') {
      // Issue #2: Strip keepalive markers safely — use simple replaceAll instead of
      // greedy regex that could accidentally eat real content between two markers.
      content.content = content.content.replaceAll(KEEPALIVE_PREFIX, '');
      content.content = stripToolCallTags(content.content);
    }

    // Signed provider state is required for replay but is not part of the chat response.
    if (content.metadata?.additional_kwargs) {
      const cleanKwargs = { ...content.metadata.additional_kwargs };
      delete cleanKwargs.__keepalive;
      delete cleanKwargs[SIGNED_CONTEXT_KEY];
      delete cleanKwargs[STREAM_THINKING_BLOCKS_KEY];
      delete cleanKwargs.thinking_blocks;
      delete cleanKwargs.__raw_response;
      if (Array.isArray(cleanKwargs.tool_calls)) {
        cleanKwargs.tool_calls = cleanKwargs.tool_calls.map((toolCall: Record<string, unknown> | null) => {
          if (!toolCall || typeof toolCall !== 'object') return toolCall;
          const { provider_specific_fields: _providerFields, extra_content: _extraContent, ...rest } = toolCall;
          return { ...rest, id: typeof rest.id === 'string' ? shortToolCallId(rest.id) : rest.id };
        });
      }
      content.metadata = { ...content.metadata, additional_kwargs: cleanKwargs };
    }

    return {
      key: messageId,
      createdAt,
      content,
      role,
    };
  }

  parseReasoningContent(chunk: any) {
    const resConfig = this.responseConfig;
    const reasoningKey = resConfig.reasoningKey || 'reasoning_content';

    // Check multiple paths — different providers/chunk formats nest reasoning differently
    const reasoning = chunk?.additional_kwargs?.[reasoningKey] ?? chunk?.kwargs?.additional_kwargs?.[reasoningKey];

    if (reasoning && typeof reasoning === 'string') {
      return { status: 'streaming', content: reasoning };
    }
    return null as any;
  }

  /**
   * Extract response metadata from LLM output for post-save enrichment.
   * Sanitizes overly long message IDs from Gemini or other providers.
   */
  parseResponseMetadata(output: any): any {
    try {
      const generation = output?.generations?.[0]?.[0];
      if (!generation) return [null, null];

      const message = generation.message;
      let id = message?.id;
      if (!id) return [null, null];

      // Sanitize overly long IDs (Gemini can return very long chatcmpl-xxx or run-xxx IDs)
      if (typeof id === 'string' && id.length > 128) {
        id = id.substring(0, 128);
      }

      const metadata: Record<string, any> = {};
      if (message?.response_metadata) {
        metadata.finish_reason = message.response_metadata.finish_reason;
        metadata.system_fingerprint = message.response_metadata.system_fingerprint;
      }
      if (message?.usage_metadata) {
        metadata.usage_metadata = message.usage_metadata;
      }

      return Object.keys(metadata).length > 0 ? [id, metadata] : [null, null];
    } catch {
      return [null, null];
    }
  }

  parseResponseError(err: unknown) {
    let current: unknown = err;
    const seen = new Set<unknown>();
    while (current && typeof current === 'object' && !seen.has(current)) {
      seen.add(current);
      const candidate = current as {
        code?: unknown;
        correlationId?: unknown;
        cause?: unknown;
        error?: { code?: unknown };
        headers?: { get?: (name: string) => string | null };
      };
      const code = typeof candidate.code === 'string' ? candidate.code : candidate.error?.code;
      const reference =
        typeof candidate.correlationId === 'string'
          ? candidate.correlationId
          : candidate.headers?.get?.('x-nocobase-correlation-id');
      if (typeof code === 'string' && typeof reference === 'string') {
        const translate = this.app?.i18n?.t?.bind(this.app.i18n);
        if (translate) {
          const reason = translate(`Custom LLM error ${code}`, { ns: 'plugin-custom-llm' });
          return translate('Custom LLM error: {{reason}} (reference: {{reference}})', {
            ns: 'plugin-custom-llm',
            reason,
            reference,
          });
        }
        return current instanceof Error ? current.message : `LLM service error (${code}), reference ${reference}`;
      }
      current = candidate.cause;
    }
    return err instanceof Error ? err.message : 'Unexpected LLM service error';
  }

  private async readFileData(ctx: Context, attachment: AttachmentModel): Promise<Buffer> {
    const fileManager = this.app.pm.get('file-manager') as PluginFileManagerServer;
    const options =
      typeof ctx.get === 'function'
        ? {
            requestOptions: {
              headers: { Referer: ctx.get('referer') || '', 'User-Agent': ctx.get('user-agent') || '' },
            },
          }
        : undefined;
    const { stream } = await fileManager.getFileStream(attachment, options);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Override parseAttachment to convert all attachments into formats that
   * generic OpenAI-compatible endpoints actually support:
   *
   *   - Images     → image_url block with base64 data URI (vision models)
   *   - Text files → text block with decoded UTF-8 content
   *   - Binary     → text block with base64 data URI (multi-modal or fallback)
   *
   * The base-class implementation returns a LangChain ContentBlock.Multimodal.File
   * (`type: 'file'`) for non-image attachments. LangChain serialises this as the
   * newer OpenAI Files API format which most custom/local endpoints do NOT understand,
   * causing file content to be silently dropped.
   *
   * This method is entirely self-contained — it does not call super — so it is
   * safe to use without modifying plugin-ai core.
   */
  /**
   * Try to extract text from an attachment using DocPixie (if available and
   * the file type is supported). Returns null if DocPixie is unavailable,
   * not ready, or the file type is not supported.
   */
  /**
   * Check whether the DocPixie skill (`docpixie.query.document`) is configured
   * on the AI employee that initiated this request.
   *
   * Reads `ctx.action.params.values.aiEmployee` (the employee username set by the
   * `sendMessages` action handler), then looks up the employee's `skillSettings`
   * from DB. Result is cached on `ctx.state._docPixieActive` for the request lifetime.
   */
  private async hasDocPixieSkill(ctx: Context): Promise<boolean> {
    if (ctx.state._docPixieActive !== undefined) return ctx.state._docPixieActive as boolean;

    try {
      // Issue #6: Try multiple sources for the AI employee username.
      // The field may be placed differently depending on whether the request
      // comes from sendMessages action, workflow invoke, or direct API call.
      const employeeUsername =
        ctx.action?.params?.values?.aiEmployee ?? ctx.action?.params?.aiEmployee ?? ctx.state?.currentAiEmployee;

      if (!employeeUsername) {
        ctx.state._docPixieActive = false;
        return false;
      }

      const employee = await ctx.db.getRepository('aiEmployees').findOne({
        filter: { username: String(employeeUsername) },
        fields: ['skillSettings'],
      });

      const skills: Array<{ name: string }> = (employee?.get?.('skillSettings') as any)?.skills ?? [];
      const has = skills.some((s) => s.name === 'docpixie.query.document');
      ctx.state._docPixieActive = has;
      return has;
    } catch {
      ctx.state._docPixieActive = false;
      return false;
    }
  }

  /**
   * Run the full DocPixie ingestion pipeline (extract pages → generate summary → index).
   * Returns a formatted `<processed_document>` context block the LLM can use immediately,
   * plus a clear instruction to call the RAG tool with the returned documentId for details.
   *
   * Returns null if DocPixie is unavailable, not configured, or processing fails.
   */
  private async tryDocPixieFullProcess(fileData: Buffer, filename: string, ctx: Context): Promise<string | null> {
    try {
      const docpixie = this.app.pm.get('docpixie') as any;
      if (!docpixie?.service?.isReady?.()) return null;

      const userId: number | undefined = ctx.state?.currentUser?.id;
      const result: { documentId: number; summary: string; pageCount: number } =
        await docpixie.service.processDocumentFromBuffer(fileData, filename, { userId });

      const { documentId, summary, pageCount } = result;
      const summaryText = summary?.trim() || 'No summary available.';

      return (
        `<processed_document id="${documentId}" filename="${filename}" pages="${pageCount}">\n` +
        `<summary>\n${summaryText}\n</summary>\n` +
        `<rag_instruction>This document is fully indexed. ` +
        `Call docpixie.query.document with documentId=${documentId} to retrieve specific details.</rag_instruction>\n` +
        `</processed_document>`
      );
    } catch {
      return null;
    }
  }

  /**
   * Try to extract text from an attachment using DocPixie (transient — no DB indexing).
   * Returns null if DocPixie is unavailable, not ready, or file type unsupported.
   */
  private async tryDocPixieExtract(fileData: Buffer, filename: string): Promise<string | null> {
    try {
      const docpixie = this.app.pm.get('docpixie') as any;
      if (!docpixie?.service) return null;
      const text: string = await docpixie.service.extractTextFromBuffer(fileData, filename);
      return text || null;
    } catch {
      return null;
    }
  }

  async parseAttachment(ctx: Context, attachment: AttachmentModel) {
    const isExternalAttachment = Boolean(
      attachment?.source?.dataSourceKey && attachment.source.dataSourceKey !== 'main',
    );
    if ((!attachment?.storageId && !isExternalAttachment) || !attachment?.filename) {
      return super.parseAttachment(ctx, attachment);
    }
    const mimetype: string = attachment.mimetype || 'application/octet-stream';
    // basename only — raw filenames are interpolated into prompt XML below
    const filename = path.basename(attachment.filename);
    const fileData = await this.readFileData(ctx, attachment);
    const data = fileData.toString('base64');

    const { enableVision } = this.modelOptions || {};
    const isImage = mimetype.startsWith('image/');
    const isPdf = mimetype === 'application/pdf';
    const isDocPixieSupported = isPdf || isImage;

    // ── Early exit: images with vision disabled → skip all image processing ──
    // When enableVision is off, the model cannot process images at all,
    // so DocPixie OCR is also skipped (no point extracting text for a
    // model that can't contextualize it). PDFs remain unaffected.
    if (isImage && !enableVision) {
      return {
        placement: 'contentBlocks',
        content: {
          type: 'text',
          text: `<attachment filename="${filename}" type="${mimetype}">[Image: ${filename} — omitted because native Vision is disabled]</attachment>`,
        },
      };
    }

    // ── Path A: DocPixie skill active → full ingestion pipeline ──────────────
    // Runs processDocument (extract pages + generate summary + DB index) so the
    // LLM gets a rich summary + documentId it can pass to the RAG tool for specifics.
    if (isDocPixieSupported && (await this.hasDocPixieSkill(ctx))) {
      const contextBlock = await this.tryDocPixieFullProcess(fileData, filename, ctx);
      if (contextBlock) {
        return {
          placement: 'contentBlocks',
          content: { type: 'text', text: contextBlock },
        };
      }
      // DocPixie not configured / failed → fall through to Path B
    }

    // ── Path B: DocPixie skill absent → transient extraction (no DB) ─────────
    if (isPdf) {
      const extracted = await this.tryDocPixieExtract(fileData, filename);
      if (extracted) {
        return {
          placement: 'contentBlocks',
          content: {
            type: 'text',
            text: `<attachment filename="${filename}" type="${mimetype}">\n${extracted}\n</attachment>`,
          },
        };
      }
      // DocPixie unavailable — fall through to base64 data-URI
    }

    // ── Path C: Image with vision enabled ────────────────────────────────────
    if (isImage) {
      // Try DocPixie OCR first (e.g. scanned documents as images)
      const extracted = await this.tryDocPixieExtract(fileData, filename);
      if (extracted) {
        return {
          placement: 'contentBlocks',
          content: {
            type: 'text',
            text: `<attachment filename="${filename}" type="${mimetype}">\n${extracted}\n</attachment>`,
          },
        };
      }
      // Final fallback — send as image_url for vision-capable models
      return {
        placement: 'contentBlocks',
        content: {
          type: 'image_url',
          image_url: { url: `data:${mimetype};base64,${data}` },
        },
      };
    }

    let textContent: string;
    if (isTextMimetype(mimetype)) {
      // Decode to readable UTF-8 so the model can actually read the content
      const decoded = fileData.toString('utf-8');
      textContent = `<attachment filename="${filename}" type="${mimetype}">\n${decoded}\n</attachment>`;
    } else {
      // Binary non-image: embed as data-URI; multi-modal models may process it,
      // text-only models at minimum see the filename and type
      textContent = `<attachment filename="${filename}" type="${mimetype}">\ndata:${mimetype};base64,${data}\n</attachment>`;
    }

    return {
      placement: 'contentBlocks',
      content: { type: 'text', text: textContent },
    };
  }
}

export class CustomEmbeddingProvider extends EmbeddingProvider {
  protected getDefaultUrl(): string {
    return '';
  }

  createEmbedding(): EmbeddingsInterface {
    const { OpenAIEmbeddings } = requireFromApp('@langchain/openai');
    return new OpenAIEmbeddings({
      apiKey: this.apiKey,
      configuration: {
        baseURL: this.baseURL,
      },
      model: this.model,
    });
  }
}

export const customLLMProviderOptions: LLMProviderMeta = {
  title: 'Custom LLM (OpenAI Compatible)',
  provider: CustomLLMProvider,
  embedding: CustomEmbeddingProvider as any,
  supportedModel: [SupportedModel.LLM, SupportedModel.EMBEDDING] as any,
};
