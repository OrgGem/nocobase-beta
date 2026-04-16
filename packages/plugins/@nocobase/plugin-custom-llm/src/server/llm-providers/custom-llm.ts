/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { LLMProvider, LLMProviderMeta } from '@nocobase/plugin-ai';
import { Model } from '@nocobase/database';
import path from 'node:path';
import fs from 'node:fs/promises';
import axios from 'axios';
import { Context } from '@nocobase/actions';
import type { ParsedAttachmentResult } from '@nocobase/plugin-ai';

// Keepalive marker — zero-width space prefix to distinguish from real content
const KEEPALIVE_PREFIX = '\u200B\u200B\u200B';

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
 * Sanitize a tool call ID by stripping the `__thought__<base64>` suffix
 * that Gemini models append during streaming. The suffix is excessively
 * long and causes errors when langgraph reads messages back from history.
 */
function sanitizeToolCallId(id: string | undefined): string | undefined {
  if (!id || typeof id !== 'string') return id;
  const idx = id.indexOf('__thought__');
  return idx !== -1 ? id.substring(0, idx) : id;
}

/**
 * Build tool_calls key for reasoning content map lookup.
 */
function getToolCallsKey(toolCalls: Array<{ id?: string; name?: string; function?: { name?: string } }> = []): string {
  return toolCalls
    .map((tc) => {
      const id = tc?.id ?? '';
      const name = tc?.name ?? tc?.function?.name ?? '';
      return `${id}:${name}`;
    })
    .join('|');
}

/**
 * Collect reasoning_content from history messages keyed by their tool_calls.
 * This is needed because some APIs (DeepSeek) require reasoning_content to
 * be present in assistant messages that precede tool results.
 */
function collectReasoningMap(messages: any[]): Map<string, string> {
  const reasoningMap = new Map<string, string>();
  for (const message of messages ?? []) {
    if (message?.getType?.() !== 'ai' && message?._getType?.() !== 'ai') continue;
    if (!message?.tool_calls?.length) continue;
    const reasoningContent = message?.additional_kwargs?.reasoning_content;
    if (typeof reasoningContent !== 'string' || !reasoningContent) continue;
    const key = getToolCallsKey(message.tool_calls);
    if (key) reasoningMap.set(key, reasoningContent);
  }
  return reasoningMap;
}

/**
 * Patch request messages to restore reasoning_content on assistant messages
 * that have tool_calls — needed for APIs that require it on round-trip.
 */
function patchRequestMessagesReasoning(request: any, reasoningMap?: Map<string, string>): void {
  if (!reasoningMap?.size || !Array.isArray(request?.messages)) return;
  const lastMsg = request.messages.at(-1);
  if (lastMsg?.role !== 'tool') return;
  for (const msg of request.messages) {
    if (msg?.role !== 'assistant') continue;
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
    if (msg.reasoning_content) continue;
    const key = getToolCallsKey(msg.tool_calls);
    const rc = key ? reasoningMap.get(key) : undefined;
    if (rc) msg.reasoning_content = rc;
  }
}

const REASONING_MAP_KEY = '__nb_reasoning_map';

/**
 * Create a ReasoningChatOpenAI class that extends ChatOpenAICompletions.
 * This patches reasoning_content into the request messages before sending
 * to the API, which is required for models like DeepSeek-R1 that need
 * reasoning_content present in assistant messages during tool call cycles.
 */
function createReasoningChatClass() {
  const ChatOpenAICompletions = getChatOpenAICompletions();
  if (!ChatOpenAICompletions) {
    // Fallback — completions class not available, use plain ChatOpenAI
    return getChatOpenAI();
  }

  return class ReasoningChatOpenAI extends ChatOpenAICompletions {
    async _generate(messages: any[], options: any, runManager?: any) {
      const reasoningMap = collectReasoningMap(messages);
      return super._generate(messages, { ...(options || {}), [REASONING_MAP_KEY]: reasoningMap }, runManager);
    }

    async *_streamResponseChunks(messages: any[], options: any, runManager?: any) {
      const reasoningMap =
        options?.[REASONING_MAP_KEY] instanceof Map
          ? (options[REASONING_MAP_KEY] as Map<string, string>)
          : collectReasoningMap(messages);
      yield* super._streamResponseChunks(messages, { ...(options || {}), [REASONING_MAP_KEY]: reasoningMap }, runManager);
    }

    _convertCompletionsDeltaToBaseMessageChunk(delta: any, rawResponse: any, defaultRole?: any) {
      const messageChunk = super._convertCompletionsDeltaToBaseMessageChunk(delta, rawResponse, defaultRole);
      if (delta?.reasoning_content) {
        messageChunk.additional_kwargs = {
          ...(messageChunk.additional_kwargs || {}),
          reasoning_content: delta.reasoning_content,
        };
      }
      return messageChunk;
    }

    _convertCompletionsMessageToBaseMessage(message: any, rawResponse: any) {
      const langChainMessage = super._convertCompletionsMessageToBaseMessage(message, rawResponse);
      if (message?.reasoning_content) {
        langChainMessage.additional_kwargs = {
          ...(langChainMessage.additional_kwargs || {}),
          reasoning_content: message.reasoning_content,
        };
      }
      return langChainMessage;
    }

    async completionWithRetry(request: any, requestOptions?: any): Promise<any> {
      const reasoningMap = requestOptions?.[REASONING_MAP_KEY] as Map<string, string> | undefined;
      patchRequestMessagesReasoning(request, reasoningMap);
      return super.completionWithRetry(request, requestOptions) as any;
    }
  };
}

let _ChatGenerationChunk: any = null;
function getChatGenerationChunk() {
  if (!_ChatGenerationChunk) {
    const mod = requireFromApp('@langchain/core/outputs');
    _ChatGenerationChunk = mod.ChatGenerationChunk;
  }
  return _ChatGenerationChunk;
}

let _AIMessageChunk: any = null;
function getAIMessageChunk() {
  if (!_AIMessageChunk) {
    const mod = requireFromApp('@langchain/core/messages');
    _AIMessageChunk = mod.AIMessageChunk;
  }
  return _AIMessageChunk;
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
 * Create a custom fetch that intercepts LLM responses and maps them
 * from a non-standard format to OpenAI-compatible format.
 *
 * responseMapping config example:
 * {
 *   "content": "message.response"       // dot-path to the content field
 *   "role": "message.role"              // optional, dot-path to role (default: "assistant")
 *   "id": "id"                          // optional, dot-path to response id
 *   "tool_calls": "message.tool_calls"  // optional, dot-path to tool_calls array
 *   "finish_reason": "finish_reason"    // optional, dot-path to finish_reason
 * }
 */
function createMappingFetch(responseMapping: Record<string, string>, timeoutMs?: number) {
  const contentPath = responseMapping.content;
  if (!contentPath) return undefined; // No mapping needed

  // Resolve path for tool_calls — if not set, try the standard OpenAI paths as fallback
  const toolCallsPath = responseMapping.tool_calls;
  const finishReasonPath = responseMapping.finish_reason;

  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Apply timeout via AbortController if configured (Issue #7)
    let response: Response;
    if (timeoutMs && timeoutMs > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } else {
      response = await fetch(url, init);
    }

    // Only intercept successful JSON responses
    if (!response.ok) return response;

    const contentType = response.headers.get('content-type') || '';

    // Handle streaming responses (SSE) — transform each chunk
    if (contentType.includes('text/event-stream') || init?.headers?.['Accept'] === 'text/event-stream') {
      const reader = response.body?.getReader();
      if (!reader) return response;

      const stream = new ReadableStream({
        async start(controller) {
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let buffer = '';

          try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6).trim();
                  if (data === '[DONE]') {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    continue;
                  }
                  try {
                    const parsed = JSON.parse(data);
                    const mappedContent = getByPath(parsed, contentPath);

                    // Extract tool_calls from the response (Issue #1)
                    // Try custom path first, then fall back to standard OpenAI chunk paths
                    const mappedToolCalls = toolCallsPath
                      ? getByPath(parsed, toolCallsPath)
                      : getByPath(parsed, 'choices.0.delta.tool_calls') ?? getByPath(parsed, 'delta.tool_calls');

                    const mappedFinishReason = finishReasonPath
                      ? getByPath(parsed, finishReasonPath)
                      : getByPath(parsed, 'choices.0.finish_reason') ?? getByPath(parsed, 'finish_reason');

                    if (mappedContent !== undefined || mappedToolCalls) {
                      // Build the delta — include both content and tool_calls
                      const delta: Record<string, any> = { role: 'assistant' };
                      if (mappedContent !== undefined) {
                        delta.content = String(mappedContent);
                      }
                      if (mappedToolCalls) {
                        delta.tool_calls = mappedToolCalls;
                      }

                      const mapped = {
                        id: getByPath(parsed, responseMapping.id || 'id') || 'chatcmpl-custom',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: 'custom',
                        choices: [
                          {
                            index: 0,
                            delta,
                            finish_reason: mappedFinishReason ?? null,
                          },
                        ],
                      };
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(mapped)}\n\n`));
                    } else {
                      // Pass through unmapped — SSE events must be terminated with \n\n
                      controller.enqueue(encoder.encode(line + '\n\n'));
                    }
                  } catch {
                    // Preserve SSE framing: each event line needs \n\n terminator
                    controller.enqueue(encoder.encode(line + '\n\n'));
                  }
                } else {
                  controller.enqueue(encoder.encode(line + '\n\n'));
                }
              }
            }
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers({
          'content-type': 'text/event-stream',
        }),
      });
    }

    // Handle non-streaming JSON responses
    if (contentType.includes('application/json')) {
      const body = await response.json();
      const mappedContent = getByPath(body, contentPath);

      // Extract tool_calls for non-streaming (Issue #1)
      const mappedToolCalls = toolCallsPath
        ? getByPath(body, toolCallsPath)
        : getByPath(body, 'choices.0.message.tool_calls') ?? getByPath(body, 'message.tool_calls');

      const mappedFinishReason = finishReasonPath
        ? getByPath(body, finishReasonPath)
        : getByPath(body, 'choices.0.finish_reason') ?? getByPath(body, 'finish_reason');

      if (mappedContent !== undefined || mappedToolCalls) {
        const message: Record<string, any> = {
          role: getByPath(body, responseMapping.role || '') || 'assistant',
        };
        if (mappedContent !== undefined) {
          message.content = String(mappedContent);
        } else {
          // When only tool_calls, content should be null (OpenAI convention)
          message.content = null;
        }
        if (mappedToolCalls) {
          message.tool_calls = mappedToolCalls;
        }

        const mapped = {
          id: getByPath(body, responseMapping.id || 'id') || 'chatcmpl-custom',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'custom',
          choices: [
            {
              index: 0,
              message,
              finish_reason: mappedFinishReason ?? (mappedToolCalls ? 'tool_calls' : 'stop'),
            },
          ],
          usage: body.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        return new Response(JSON.stringify(mapped), {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers({
            'content-type': 'application/json',
          }),
        });
      }
    }

    return response;
  };
}

/**
 * Wrap a ChatOpenAI model's _stream method to inject keepalive chunks
 * during long idle periods (e.g., model thinking/reasoning phase).
 *
 * This runs the base stream in a background task and uses Promise.race
 * to send keepalive chunks when no real data arrives within the interval.
 */
function wrapWithStreamKeepAlive(model: any, options: { intervalMs: number; keepAliveContent: string }) {
  const streamMethodName = typeof model._streamResponseChunks === 'function' ? '_streamResponseChunks' : '_stream';
  const originalStream = model[streamMethodName].bind(model);
  const { intervalMs, keepAliveContent } = options;

  model[streamMethodName] = async function* (messages: any[], opts: any, runManager?: any) {
    const ChatGenerationChunk = getChatGenerationChunk();
    const AIMessageChunk = getAIMessageChunk();

    const baseIterator = originalStream(messages, opts, runManager);

    // Queue for chunks from the base stream
    const buffer: any[] = [];
    let streamDone = false;
    let streamError: Error | null = null;
    let notifyReady: (() => void) | null = null;
    // Track whether tool call chunks are present in the current batch
    // to avoid injecting keepalive during tool calling sequences
    let hasToolCallChunks = false;
    // Phase 6: Track error state to prevent further keepalive after errors
    let hasErrored = false;

    // Consume the base stream in a background task
    const consumer = (async () => {
      try {
        for await (const chunk of baseIterator) {
          // Detect tool call activity — keepalive must not be injected
          // while tool call chunks are streaming in
          const msg = chunk?.message;
          if (msg?.tool_call_chunks?.length || msg?.tool_calls?.length) {
            hasToolCallChunks = true;
          }
          buffer.push(chunk);
          // Wake up the main loop
          if (notifyReady) {
            notifyReady();
            notifyReady = null;
          }
        }
      } catch (err) {
        streamError = err as Error;
        hasErrored = true;
        // Wake up main loop immediately for prompt error propagation
        if (notifyReady) {
          notifyReady();
          notifyReady = null;
        }
      } finally {
        streamDone = true;
        if (notifyReady) {
          notifyReady();
          notifyReady = null;
        }
      }
    })();

    try {
      while (!streamDone || buffer.length > 0) {
        // Flush buffered chunks first
        while (buffer.length > 0) {
          yield buffer.shift();
        }
        // Reset tool call flag after flushing — if tool calling has
        // completed, keepalive may resume on the next idle interval
        hasToolCallChunks = false;

        if (streamDone) break;

        // Wait for either: new chunk arrives OR keepalive interval expires
        const waitForChunk = new Promise<void>((resolve) => {
          notifyReady = resolve;
        });

        let timer: ReturnType<typeof setTimeout> | null = null;
        const result = await Promise.race([
          waitForChunk.then(() => 'chunk' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), intervalMs);
          }),
        ]);

        // Clear the timer to prevent leaks
        if (timer) clearTimeout(timer);

        if (result === 'timeout' && !streamDone && buffer.length === 0) {
          // Don't emit keepalive if stream has errored — propagate immediately
          if (streamError || hasErrored) break;
          // Don't emit keepalive during active tool call sequences
          if (hasToolCallChunks) continue;
          // Send keepalive with KEEPALIVE_PREFIX as content.
          // Must be truthy so plugin-ai's `if (chunk.content)` check passes
          // and protocol.content() writes an SSE event to prevent proxy timeouts.
          // KEEPALIVE_PREFIX is zero-width spaces — invisible in client UI.
          // parseResponseChunk returns it, protocol.content() emits it.
          // gathered.content accumulates ZWS but parseResponseMessage strips them.
          const keepAliveChunk = new ChatGenerationChunk({
            message: new AIMessageChunk({
              content: KEEPALIVE_PREFIX,
              additional_kwargs: { __keepalive: true },
            }),
            text: KEEPALIVE_PREFIX,
          });
          yield keepAliveChunk;
        }
        // If result === 'chunk', flush happens at top of loop
      }

      // Re-throw any stream error
      if (streamError) {
        throw streamError;
      }
    } finally {
      // Ensure the consumer finishes
      await consumer;
    }
  };

  return model;
}

/**
 * Check if a text string is a keepalive marker.
 */
function isKeepAlive(text: string): boolean {
  return typeof text === 'string' && text.startsWith(KEEPALIVE_PREFIX);
}

/**
 * Wrap bindTools on the model to fix empty tool properties.
 * Gemini and some providers reject tools with `properties: {}`.
 * This ensures empty properties objects get a placeholder property.
 *
 * The fix works at TWO levels:
 * 1. Pre-conversion: Fix raw tool definitions before LangChain converts them
 * 2. Post-conversion: Fix the converted OpenAI-format tools after bindTools
 *    returns, catching cases where Zod `z.object({})` schemas get converted
 *    to `{ properties: {} }` by LangChain's _convertToOpenAITool
 */
function fixEmptyToolProperties(model: any) {
  const originalBind = model.bindTools?.bind(model);
  if (!originalBind) return model;

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

    // Fix direct properties
    if (schema.properties && typeof schema.properties === 'object' && Object.keys(schema.properties).length === 0) {
      schema.properties = { ...PLACEHOLDER_PROP };
    }

    // Recurse into nested schemas
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(schema[key])) {
        schema[key].forEach((sub: any) => fixPropertiesInSchema(sub));
      }
    }
  }

  model.bindTools = function (tools: any[], kwargs?: any) {
    // Phase 1: Pre-conversion fix for raw JSON Schema tool definitions
    const fixedTools = tools.map((tool: any) => {
      if (!tool || typeof tool !== 'object') return tool;

      // Skip Zod schema tools — they'll be handled post-conversion
      if (typeof tool.schema?.safeParse === 'function') {
        return tool;
      }

      // Handle raw schema objects (already JSON Schema)
      const schema = tool.schema;
      if (schema && typeof schema === 'object' && !schema.safeParse) {
        const props = schema.properties;
        if (props && typeof props === 'object' && Object.keys(props).length === 0) {
          return {
            ...tool,
            schema: {
              ...schema,
              properties: { ...PLACEHOLDER_PROP },
            },
          };
        }
      }

      // Handle function-calling style definitions  (OpenAI format)
      const funcParams = tool.function?.parameters;
      if (funcParams?.properties) {
        if (typeof funcParams.properties === 'object' && Object.keys(funcParams.properties).length === 0) {
          return {
            ...tool,
            function: {
              ...tool.function,
              parameters: {
                ...funcParams,
                properties: { ...PLACEHOLDER_PROP },
              },
            },
          };
        }
      }

      return tool;
    });

    // Call the original bindTools — this converts Zod → JSON Schema internally
    const result = originalBind(fixedTools, kwargs);

    // Phase 2: Post-conversion fix — patch the converted tools in the result
    // LangChain's bindTools returns a RunnableBinding or the model itself with
    // tools stored in defaultOptions or bound config
    try {
      const config = result?.kwargs ?? result?.defaultOptions;
      if (config?.tools && Array.isArray(config.tools)) {
        for (const tool of config.tools) {
          // OpenAI format: { type: 'function', function: { parameters: { properties: {} } } }
          if (tool?.function?.parameters) {
            fixPropertiesInSchema(tool.function.parameters);
          }
          // Direct parameter format (some providers)
          if (tool?.parameters) {
            fixPropertiesInSchema(tool.parameters);
          }
        }
      }
    } catch {
      // Don't break tool binding if post-fix inspection fails
    }

    return result;
  };

  return model;
}

/**
 * Sanitize tool_calls on an AIMessage (mutates in place).
 */
function sanitizeAIMessageToolCalls(msg: any): void {
  if (!msg) return;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tc.id = sanitizeToolCallId(tc.id);
    }
  }
  if (msg.tool_call_chunks) {
    for (const tc of msg.tool_call_chunks) {
      tc.id = sanitizeToolCallId(tc.id);
    }
  }
}

/**
 * Patch a runnable (model or bound model) so that `invoke` and `stream`
 * sanitize tool call IDs on every AIMessage output.
 * Also patches `bindTools` and `bind` so that derived runnables inherit
 * the sanitization — this is critical because langgraph calls
 * `model.bindTools(tools)` and then uses the BOUND model.
 */
function patchRunnableForSanitization(runnable: any): any {
  if (!runnable || runnable.__toolCallSanitized) return runnable;
  runnable.__toolCallSanitized = true;

  // Patch invoke — covers non-streaming and internal streaming-via-invoke
  const origInvoke = runnable.invoke?.bind(runnable);
  if (origInvoke) {
    runnable.invoke = async function (...args: any[]) {
      const result = await origInvoke(...args);
      sanitizeAIMessageToolCalls(result);
      return result;
    };
  }

  // Patch stream — covers streaming path
  const origStream = runnable.stream?.bind(runnable);
  if (origStream) {
    runnable.stream = async function (...args: any[]) {
      const iter = await origStream(...args);
      // Wrap the async iterable to sanitize each chunk
      const origIterator = iter[Symbol.asyncIterator]?.bind(iter);
      if (origIterator) {
        iter[Symbol.asyncIterator] = function () {
          const it = origIterator();
          return {
            async next() {
              const { value, done } = await it.next();
              if (!done && value) {
                sanitizeAIMessageToolCalls(value);
              }
              return { value, done };
            },
            return: it.return?.bind(it),
            throw: it.throw?.bind(it),
          };
        };
      }
      return iter;
    };
  }

  // Patch bindTools — the result is a RunnableBinding used by langgraph
  const origBindTools = runnable.bindTools?.bind(runnable);
  if (origBindTools) {
    runnable.bindTools = function (...args: any[]) {
      const bound = origBindTools(...args);
      return patchRunnableForSanitization(bound);
    };
  }

  // Patch bind — bindTools internally calls bind(), some runnables use it directly
  const origBind = runnable.bind?.bind(runnable);
  if (origBind) {
    runnable.bind = function (...args: any[]) {
      const bound = origBind(...args);
      return patchRunnableForSanitization(bound);
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

  createModel() {
    const {
      apiKey, disableStream, timeout, streamKeepAlive,
      keepAliveIntervalMs, keepAliveContent, enableReasoning,
    } = this.serviceOptions || {};
    // baseURL comes from core's options.baseURL field
    const baseURL = this.serviceOptions?.baseURL;
    const { responseFormat } = this.modelOptions || {};
    const reqConfig = this.requestConfig;
    const resConfig = this.responseConfig;

    const responseFormatOptions: Record<string, any> = {
      type: responseFormat ?? 'text',
    };

    const modelKwargs: Record<string, any> = {
      response_format: responseFormatOptions,
      ...(reqConfig.modelKwargs || {}),
    };

    if (reqConfig.extraBody && typeof reqConfig.extraBody === 'object') {
      Object.assign(modelKwargs, reqConfig.extraBody);
    }

    // Issue #4: Use ReasoningChatOpenAI when enableReasoning is set.
    // This ensures reasoning_content is preserved and patched back into
    // assistant messages during tool call round-trips (required by DeepSeek-R1, etc.)
    const ChatClass = enableReasoning ? createReasoningChatClass() : getChatOpenAI();
    const config: Record<string, any> = {
      apiKey,
      ...this.modelOptions,
      modelKwargs,
      configuration: {
        baseURL,
      },
      verbose: false,
    };

    // Disable streaming for models with long thinking phases
    // that return empty stream values causing processing to terminate
    if (disableStream) {
      config.streaming = false;
    }

    // Apply custom timeout (in milliseconds) for slow-responding models
    const timeoutMs = timeout && Number(timeout) > 0 ? Number(timeout) : 0;
    if (timeoutMs) {
      config.timeout = timeoutMs;
      config.configuration.timeout = timeoutMs;
    }

    // Apply extra headers
    if (reqConfig.extraHeaders && typeof reqConfig.extraHeaders === 'object') {
      config.configuration.defaultHeaders = reqConfig.extraHeaders;
    }

    // Apply response mapping via custom fetch — pass timeout for fetch-level protection (Issue #7)
    if (resConfig.responseMapping) {
      config.configuration.fetch = createMappingFetch(resConfig.responseMapping, timeoutMs || 120_000);
    }

    let model = new ChatClass(config);

    // Fix empty tool properties for strict providers (Gemini, etc.)
    model = fixEmptyToolProperties(model);

    // Wrap with keepalive proxy if enabled (and streaming is not disabled)
    if (streamKeepAlive && !disableStream) {
      model = wrapWithStreamKeepAlive(model, {
        intervalMs: Number(keepAliveIntervalMs) || 5000,
        keepAliveContent: keepAliveContent || '...',
      });
    }

    // Sanitize Gemini's __thought__<base64> suffixes in tool call IDs.
    // Patches invoke/stream/bindTools/bind at the public API level so that
    // ALL code paths (including langgraph's internal model calls via
    // RunnableBinding after bindTools) return clean IDs.
    model = patchRunnableForSanitization(model);

    return model;
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
    const { content: rawContent, messageId, metadata, role, toolCalls, attachments, workContext } = message;
    const content: Record<string, any> = {
      ...(rawContent ?? {}),
      messageId,
      metadata,
      attachments,
      workContext,
    };

    if (toolCalls) {
      content.tool_calls = Array.isArray(toolCalls)
        ? toolCalls.map((tc: any) => ({ ...tc, id: sanitizeToolCallId(tc.id) }))
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

    // Clean internal keepalive flag from persisted additional_kwargs
    if (content.metadata?.additional_kwargs?.__keepalive !== undefined) {
      const { __keepalive, ...cleanKwargs } = content.metadata.additional_kwargs;
      content.metadata = { ...content.metadata, additional_kwargs: cleanKwargs };
    }

    return {
      key: messageId,
      content,
      role,
    };
  }

  parseReasoningContent(chunk: any): { status: string; content: string } | null {
    const resConfig = this.responseConfig;
    const reasoningKey = resConfig.reasoningKey || 'reasoning_content';

    // Check multiple paths — different providers/chunk formats nest reasoning differently
    const reasoning = chunk?.additional_kwargs?.[reasoningKey] ?? chunk?.kwargs?.additional_kwargs?.[reasoningKey];

    if (reasoning && typeof reasoning === 'string') {
      return { status: 'streaming', content: reasoning };
    }
    return null;
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

  parseResponseError(err: any) {
    return err?.message ?? 'Unexpected LLM service error';
  }

  /**
   * Self-contained file reading that correctly handles the APP_PUBLIC_PATH prefix.
   *
   * plugin-ai's encodeLocalFile does path.join(cwd, url) without stripping
   * APP_PUBLIC_PATH, so when the app is deployed under a sub-path (e.g. /my-app)
   * the resolved path becomes '{cwd}/my-app/storage/uploads/…' which does not exist.
   * We cannot fix that in plugin-ai (core), so we re-implement file reading here
   * with the prefix stripped before the cwd join.
   */
  /**
   * Reads the attachment and returns its base64-encoded content plus, when the
   * file lives on the local filesystem, the resolved absolute path so callers
   * can hand that path directly to tools like DocPixie and avoid a second
   * write-to-disk round-trip.
   */
  private async readFileData(ctx: Context, attachment: any): Promise<{ base64: string; absPath?: string }> {
    const fileManager = this.app.pm.get('file-manager') as any;
    const rawUrl: string = await fileManager.getFileURL(attachment);
    const url = decodeURIComponent(rawUrl);

    if (url.startsWith('http://') || url.startsWith('https://')) {
      const referer = ctx.get('referer') || '';
      const ua = ctx.get('user-agent') || '';
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30_000,
        headers: { referer, 'User-Agent': ua },
      });
      return { base64: Buffer.from(response.data).toString('base64') };
    }

    // Internal API stream URL (e.g. s3-private-storage proxy) — read directly via fileManager
    if (url.includes('/api/attachments:stream')) {
      const { stream } = await fileManager.getFileStream(attachment);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      return { base64: Buffer.concat(chunks).toString('base64') };
    }

    // Local file — strip APP_PUBLIC_PATH prefix before joining with cwd
    let localPath = url;
    const appPublicPath = (process.env.APP_PUBLIC_PATH || '/').replace(/\/+$/, '');
    if (appPublicPath && localPath.startsWith(appPublicPath + '/')) {
      localPath = localPath.slice(appPublicPath.length);
    }

    // Resolve and guard against path traversal
    const storageRoot = path.resolve(process.cwd());
    const absPath = path.resolve(storageRoot, localPath.replace(/^\//, ''));
    if (!absPath.startsWith(storageRoot + path.sep) && absPath !== storageRoot) {
      throw new Error(`Attachment path escapes storage root: ${localPath}`);
    }

    const data = await fs.readFile(absPath);
    // Return absPath so parseAttachment can pass it directly to DocPixie
    return { base64: Buffer.from(data).toString('base64'), absPath };
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
        ctx.action?.params?.values?.aiEmployee ??
        ctx.action?.params?.aiEmployee ??
        ctx.state?.currentAiEmployee;

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
   * Prefers passing `absPath` directly for local-storage files to avoid a second
   * write-to-disk round-trip. Falls back to Buffer for remote / S3 files.
   *
   * Returns null if DocPixie is unavailable, not configured, or processing fails.
   */
  private async tryDocPixieFullProcess(
    fileData: { base64: string; absPath?: string },
    filename: string,
    ctx: Context,
  ): Promise<string | null> {
    try {
      const docpixie = this.app.pm.get('docpixie') as any;
      if (!docpixie?.service?.isReady?.()) return null;

      const userId: number | undefined = ctx.state?.currentUser?.id;
      let result: { documentId: number; summary: string; pageCount: number };

      if (fileData.absPath) {
        result = await docpixie.service.processDocumentFromPath(fileData.absPath, filename, { userId });
      } else {
        const buffer = Buffer.from(fileData.base64, 'base64');
        result = await docpixie.service.processDocumentFromBuffer(buffer, filename, { userId });
      }

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
   * When `absPath` is provided (local-storage file), DocPixie reads the file
   * directly — no Buffer decode/re-encode or extra temp-file write.
   * Falls back to `extractTextFromBuffer` for remote/S3 files.
   * Returns null if DocPixie is unavailable, not ready, or file type unsupported.
   */
  private async tryDocPixieExtract(
    fileData: { base64: string; absPath?: string },
    filename: string,
  ): Promise<string | null> {
    try {
      const docpixie = this.app.pm.get('docpixie') as any;
      if (!docpixie?.service) return null;
      let text: string;
      if (fileData.absPath) {
        text = await docpixie.service.extractTextFromPath(fileData.absPath, filename);
      } else {
        const buffer = Buffer.from(fileData.base64, 'base64');
        text = await docpixie.service.extractTextFromBuffer(buffer, filename);
      }
      return text || null;
    } catch {
      return null;
    }
  }

  async parseAttachment(ctx: Context, attachment: any): Promise<ParsedAttachmentResult> {
    const mimetype: string = attachment.mimetype || 'application/octet-stream';
    const filename: string = attachment.filename || attachment.name || 'file';
    const fileData = await this.readFileData(ctx, attachment);
    const { base64: data } = fileData;

    const isDocPixieSupported = mimetype === 'application/pdf' || mimetype.startsWith('image/');

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
    if (mimetype === 'application/pdf') {
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

    if (mimetype.startsWith('image/')) {
      // Transient DocPixie extraction (e.g. OCR); fallback to image_url for vision models
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
      // Final fallback — vision-capable models handle image_url natively
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
      const decoded = Buffer.from(data, 'base64').toString('utf-8');
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

export const customLLMProviderOptions: LLMProviderMeta = {
  title: 'Custom LLM (OpenAI Compatible)',
  provider: CustomLLMProvider,
};
