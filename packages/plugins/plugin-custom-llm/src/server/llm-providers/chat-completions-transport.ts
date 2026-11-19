// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';

type JsonObject = Record<string, unknown>;
type RetryOptions = { maxRetries?: number; delayMs?: number };
type FailureCode =
  | 'STREAM_INCOMPLETE'
  | 'UPSTREAM_STREAM_ERROR'
  | 'OUTPUT_LIMIT'
  | 'CONTENT_FILTER'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'MALFORMED_STREAM'
  | 'INVALID_TOOL_CALL'
  | 'GEMINI_SIGNATURE_MISSING'
  | 'GEMINI_SIGNATURE_INVALID'
  | 'CLAUDE_THINKING_BLOCKS'
  | 'TOOL_RESULT_MISMATCH';

export type TransportOptions = {
  mapping?: Record<string, string>;
  retry?: RetryOptions;
  sessionId?: string;
  model?: string;
  logger?: { error(message: string, meta: Record<string, unknown>): void };
  sdkErrorEnvelope?: boolean;
};

type FailureDetails = {
  stage: 'request' | 'response' | 'stream';
  status?: number;
  requestId?: string;
  upstreamCode?: string;
  finishReason?: string;
};

const FAILURE_MESSAGES: Record<FailureCode, string> = {
  STREAM_INCOMPLETE: 'The model stream ended before completion.',
  UPSTREAM_STREAM_ERROR: 'The model service reported a streaming error.',
  OUTPUT_LIMIT: 'The model stopped because the output token limit was reached.',
  CONTENT_FILTER: 'The model stopped because the response was filtered.',
  NETWORK_ERROR: 'The model service connection failed.',
  TIMEOUT: 'The model service request timed out.',
  HTTP_ERROR: 'The model service rejected the request.',
  MALFORMED_STREAM: 'The model service returned an invalid stream event.',
  INVALID_TOOL_CALL: 'The model returned an invalid tool call.',
  GEMINI_SIGNATURE_MISSING: 'The Gemini tool call is missing its thought signature.',
  GEMINI_SIGNATURE_INVALID: 'The Gemini tool call has an invalid thought signature.',
  CLAUDE_THINKING_BLOCKS: 'Claude rejected the thinking blocks associated with a tool call.',
  TOOL_RESULT_MISMATCH: 'The model service rejected a tool result that does not match its tool call.',
};

export class ChatCompletionFailure extends Error {
  readonly code: FailureCode;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly status?: number;
  readonly finishReason?: string;

  constructor(code: FailureCode, details: FailureDetails, correlationId: string = randomUUID()) {
    super(`${FAILURE_MESSAGES[code]} Reference: ${correlationId}`);
    this.name = 'ChatCompletionFailure';
    this.code = code;
    this.correlationId = correlationId;
    this.requestId = details.requestId;
    this.status = details.status;
    this.finishReason = details.finishReason;
  }
}

export function isChatCompletionFailure(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof ChatCompletionFailure || (current as { name?: unknown }).name === 'ChatCompletionFailure') {
      return true;
    }
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// OpenAI wraps failures thrown by fetch and some runtimes clone Error objects,
// discarding custom fields. Recover only our typed error or an envelope that
// contains one of our codes and the correlation header added by this transport.
export function recoverChatCompletionFailure(error: unknown): ChatCompletionFailure | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof ChatCompletionFailure) return current;
    seen.add(current);
    const candidate = current as {
      name?: unknown;
      code?: unknown;
      correlationId?: unknown;
      status?: unknown;
      requestId?: unknown;
      finishReason?: unknown;
      error?: { code?: unknown; original_status?: unknown; finish_reason?: unknown; request_id?: unknown };
      headers?: { get?: (name: string) => string | null };
      cause?: unknown;
    };
    const code = candidate.name === 'ChatCompletionFailure' ? candidate.code : candidate.error?.code;
    const reference =
      candidate.name === 'ChatCompletionFailure'
        ? candidate.correlationId
        : candidate.headers?.get?.('x-nocobase-correlation-id');
    if (
      typeof code === 'string' &&
      Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, code) &&
      typeof reference === 'string' &&
      /^[0-9a-f-]{36}$/i.test(reference)
    ) {
      const originalStatus = candidate.error?.original_status ?? candidate.status;
      const originalRequestId = candidate.error?.request_id ?? candidate.requestId;
      const finishReason = candidate.error?.finish_reason ?? candidate.finishReason;
      return new ChatCompletionFailure(
        code as FailureCode,
        {
          stage: 'response',
          ...(typeof originalStatus === 'number' ? { status: originalStatus } : {}),
          ...(typeof originalRequestId === 'string' ? { requestId: originalRequestId } : {}),
          ...(typeof finishReason === 'string' ? { finishReason } : {}),
        },
        reference,
      );
    }
    current = candidate.cause;
  }
  return undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function getByPath(value: unknown, path?: string): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((current, key) => {
    if (Array.isArray(current)) return current[Number(key)];
    return asObject(current)?.[key];
  }, value);
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9._:/@-]{1,256}$/.test(value) ? value : undefined;
}

function getRequestId(headers: Headers): string | undefined {
  return safeIdentifier(headers.get('x-litellm-call-id') || headers.get('x-request-id') || headers.get('request-id'));
}

function upstreamCode(value: unknown): string | undefined {
  const object = asObject(value);
  const error = asObject(object?.error) ?? object;
  return safeIdentifier(error?.code) ?? safeIdentifier(error?.type);
}

function classifyUpstreamError(value: unknown): FailureCode | undefined {
  const object = asObject(value);
  const error = asObject(object?.error);
  const message =
    typeof error?.message === 'string'
      ? error.message
      : typeof object?.error === 'string'
        ? object.error
        : typeof object?.message === 'string'
          ? object.message
          : typeof value === 'string'
            ? value
            : '';
  if (/thought[._\s-]*signature/i.test(message)) {
    if (/invalid|not valid|mismatch/i.test(message)) return 'GEMINI_SIGNATURE_INVALID';
    if (/missing|required|must|not found/i.test(message)) return 'GEMINI_SIGNATURE_MISSING';
  }
  if (
    /thinking[_\s-]*blocks?|redacted[_\s-]*thinking|\bthinking\b/i.test(message) &&
    /missing|required|must|expected|first|signature|invalid/i.test(message)
  ) {
    return 'CLAUDE_THINKING_BLOCKS';
  }
  if (
    /tool[_\s-]*(?:use|call|result)(?:[_\s-]*id)?/i.test(message) &&
    /match|without|must|missing|follow|correspond|expected/i.test(message)
  ) {
    return 'TOOL_RESULT_MISMATCH';
  }
  return undefined;
}

async function readErrorResponse(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const deadline = Date.now() + 2000;
  try {
    while (bytes < 16_384) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), remaining);
        }),
      ]).finally(() => clearTimeout(timeout));
      if (!part) break;
      if (part.done) break;
      bytes += part.value.length;
      text += decoder.decode(part.value.subarray(0, Math.max(0, 16_384 - (bytes - part.value.length))), {
        stream: true,
      });
    }
    text += decoder.decode();
  } catch {
    return undefined;
  } finally {
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function makeFailure(code: FailureCode, details: FailureDetails, options: TransportOptions): ChatCompletionFailure {
  const failure = new ChatCompletionFailure(code, details);
  const metadata: Record<string, unknown> = {
    code,
    correlationId: failure.correlationId,
    stage: details.stage,
  };
  const fields = {
    sessionId: safeIdentifier(options.sessionId),
    model: safeIdentifier(options.model),
    status: details.status,
    requestId: details.requestId,
    upstreamCode: details.upstreamCode,
    finishReason: details.finishReason,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) metadata[key] = value;
  }
  try {
    options.logger?.error('[CustomLLM] Chat completion failed', metadata);
  } catch {
    // A logging failure must not hide the original completion failure.
  }
  return failure;
}

export function createTimeoutFailure(options: TransportOptions): ChatCompletionFailure {
  return makeFailure('TIMEOUT', { stage: 'request' }, options);
}

export function createInvalidToolCallFailure(
  options: TransportOptions,
  stage: 'stream' | 'response' = 'response',
): ChatCompletionFailure {
  return makeFailure('INVALID_TOOL_CALL', { stage }, options);
}

function reportBeforeHeaders(failure: ChatCompletionFailure, options: TransportOptions): Response {
  if (!options.sdkErrorEnvelope) throw failure;
  const headers = new Headers({
    'content-type': 'application/json',
    'x-nocobase-correlation-id': failure.correlationId,
  });
  if (failure.requestId) headers.set('x-request-id', failure.requestId);
  return new Response(
    JSON.stringify({
      error: {
        message: failure.message,
        code: failure.code,
        original_status: failure.status,
        request_id: failure.requestId,
        finish_reason: failure.finishReason,
      },
    }),
    { status: 422, headers },
  );
}

function isChatCompletionsURL(url: RequestInfo | URL): boolean {
  const value = url instanceof Request ? url.url : String(url);
  try {
    return new URL(value).pathname.replace(/\/$/, '').endsWith('/chat/completions');
  } catch {
    return false;
  }
}

function requestIsStreaming(init?: RequestInit): boolean {
  const accept = new Headers(init?.headers).get('accept') || '';
  if (accept.includes('text/event-stream')) return true;
  if (typeof init?.body !== 'string') return false;
  try {
    return asObject(JSON.parse(init.body))?.stream === true;
  } catch {
    return false;
  }
}

function requestExplicitlyNonStreaming(init?: RequestInit): boolean {
  if (typeof init?.body !== 'string') return false;
  try {
    return asObject(JSON.parse(init.body))?.stream === false;
  } catch {
    return false;
  }
}

function responseHeaders(headers: Headers, contentType: string): Headers {
  const result = new Headers(headers);
  result.delete('content-length');
  result.delete('content-encoding');
  result.set('content-type', contentType);
  return result;
}

function getFinishReason(data: unknown, mapping?: Record<string, string>): unknown {
  return (
    getByPath(data, mapping?.finish_reason) ??
    getByPath(data, 'choices.0.finish_reason') ??
    getByPath(data, 'finish_reason')
  );
}

function failForFinishReason(
  reason: unknown,
  details: FailureDetails,
  options: TransportOptions,
): ChatCompletionFailure | undefined {
  if (reason === 'length') return makeFailure('OUTPUT_LIMIT', { ...details, finishReason: reason }, options);
  if (reason === 'content_filter') return makeFailure('CONTENT_FILTER', { ...details, finishReason: reason }, options);
  if (reason === 'abort' || reason === 'error') {
    return makeFailure('UPSTREAM_STREAM_ERROR', { ...details, finishReason: reason }, options);
  }
  return undefined;
}

function mapCompletion(data: JsonObject, mapping: Record<string, string>, streaming: boolean): JsonObject {
  const content = getByPath(data, mapping.content);
  const toolCalls =
    getByPath(data, mapping.tool_calls) ??
    getByPath(data, streaming ? 'choices.0.delta.tool_calls' : 'choices.0.message.tool_calls') ??
    getByPath(data, streaming ? 'delta.tool_calls' : 'message.tool_calls');
  const reason = getFinishReason(data, mapping);
  const choice = asObject(getByPath(data, 'choices.0')) ?? {};
  const contentParentPath = mapping.content.split('.').slice(0, -1).join('.');
  const sourceMessage = asObject(getByPath(data, contentParentPath));
  const existingMessage = asObject(choice[streaming ? 'delta' : 'message']) ?? sourceMessage ?? {};
  if (content === undefined && toolCalls === undefined && reason === undefined) return data;

  const message: JsonObject = { ...existingMessage };
  if (content !== undefined) message.content = content === null ? null : String(content);
  if (toolCalls !== undefined) message.tool_calls = toolCalls;
  if (!streaming && message.content === undefined) message.content = null;
  if (!message.role && (!streaming || Object.keys(existingMessage).length === 0)) {
    message.role = getByPath(data, mapping.role) ?? 'assistant';
  }

  const mappedChoice: JsonObject = {
    ...choice,
    index: choice.index ?? 0,
    [streaming ? 'delta' : 'message']: message,
    finish_reason: reason ?? (streaming ? null : toolCalls ? 'tool_calls' : 'stop'),
  };
  return {
    ...data,
    id: getByPath(data, mapping.id) ?? data.id ?? 'chatcmpl-custom',
    object: streaming ? 'chat.completion.chunk' : 'chat.completion',
    created: data.created ?? Math.floor(Date.now() / 1000),
    model: data.model ?? 'custom',
    choices: [mappedChoice],
  };
}

function mappedEventParts(data: JsonObject): JsonObject[] {
  const choice = asObject(getByPath(data, 'choices.0'));
  const delta = asObject(choice?.delta);
  if (!choice || !delta) return [data];
  const content = delta.content;
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  const maxToolLength = Math.max(
    0,
    ...toolCalls.map((tool) => {
      const args = asObject(asObject(tool)?.function)?.arguments;
      return typeof args === 'string' ? args.length : 0;
    }),
  );
  const chunkSize = 128;
  if (!(typeof content === 'string' && content.length > chunkSize) && maxToolLength <= chunkSize) return [data];

  const chunks: JsonObject[] = [];
  if (typeof content === 'string' && content.length) {
    for (let index = 0; index < content.length; index += chunkSize) {
      chunks.push({ content: content.slice(index, index + chunkSize) });
    }
  }
  if (toolCalls.length) {
    for (let index = 0; index < Math.max(maxToolLength, 1); index += chunkSize) {
      const partialCalls = toolCalls.flatMap((tool) => {
        const call = asObject(tool);
        if (!call) return [];
        const fn = asObject(call.function);
        const args = fn?.arguments;
        if (index > 0 && (typeof args !== 'string' || index >= args.length)) return [];
        const part: JsonObject = { ...call };
        if (fn) {
          const partialFunction: JsonObject = { ...fn };
          if (typeof args === 'string') partialFunction.arguments = args.slice(index, index + chunkSize);
          if (index > 0) delete partialFunction.name;
          part.function = partialFunction;
        }
        if (index > 0) {
          delete part.id;
          delete part.type;
          delete part.provider_specific_fields;
          delete part.extra_content;
        }
        return [part];
      });
      chunks.push({ tool_calls: partialCalls });
    }
  }
  const extra = { ...delta };
  delete extra.content;
  delete extra.tool_calls;
  return chunks.map((chunk, index) => {
    const result: JsonObject = {
      ...data,
      choices: [{ ...choice, delta: { ...(index === 0 ? extra : {}), ...chunk } }],
    };
    const resultChoice = asObject((result.choices as unknown[])[0]);
    if (index < chunks.length - 1 && resultChoice) resultChoice.finish_reason = null;
    if (index < chunks.length - 1) delete result.usage;
    return result;
  });
}

type SSEEvent = { data: string; event?: string };

async function* readEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let event: string | undefined;
  let ended = false;
  const consumeLine = (rawLine: string): SSEEvent | undefined => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      if (!data.length && event !== 'error') {
        event = undefined;
        return undefined;
      }
      const result = { data: data.join('\n'), event };
      data = [];
      event = undefined;
      return result;
    }
    if (line.startsWith(':')) return undefined;
    const dataMatch = line.trim().match(/^data\s*:\s?(.*)$/);
    if (dataMatch) data.push(dataMatch[1]);
    const eventMatch = line.trim().match(/^event\s*:\s?(.*)$/);
    if (eventMatch) event = eventMatch[1].trim();
    return undefined;
  };

  try {
    while (true) {
      const result = await reader.read();
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const parsed = consumeLine(line);
        if (parsed) yield parsed;
        newline = buffer.indexOf('\n');
      }
      if (result.done) {
        ended = true;
        if (buffer) {
          const parsed = consumeLine(buffer);
          if (parsed) yield parsed;
        }
        const parsed = consumeLine('');
        if (parsed) yield parsed;
        return;
      }
    }
  } finally {
    if (!ended) {
      reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function createCheckedStream(
  response: Response,
  options: TransportOptions,
  signal?: AbortSignal | null,
): ReadableStream<Uint8Array> | undefined {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const details: FailureDetails = {
    stage: 'stream',
    status: response.status,
    requestId: getRequestId(response.headers),
  };
  let cancelled = false;

  async function* checked(): AsyncGenerator<Uint8Array> {
    let complete = false;
    try {
      for await (const event of readEvents(reader)) {
        const raw = event.data.trim();
        if (event.event === 'error' && raw === '[DONE]') throw makeFailure('UPSTREAM_STREAM_ERROR', details, options);
        if (raw === '[DONE]') {
          complete = true;
          yield encoder.encode('data: [DONE]\n\n');
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          if (event.event === 'error') throw makeFailure('UPSTREAM_STREAM_ERROR', details, options);
          throw makeFailure('MALFORMED_STREAM', details, options);
        }
        if (event.event === 'error' || asObject(parsed)?.error) {
          throw makeFailure(
            classifyUpstreamError(parsed) ?? 'UPSTREAM_STREAM_ERROR',
            {
              ...details,
              upstreamCode: upstreamCode(parsed),
            },
            options,
          );
        }
        const reason = getFinishReason(parsed, options.mapping);
        const failure = failForFinishReason(reason, details, options);
        if (failure) throw failure;
        if (reason === 'stop' || reason === 'tool_calls' || reason === 'function_call') complete = true;
        const object = asObject(parsed);
        if (!object) throw makeFailure('MALFORMED_STREAM', details, options);
        const mapped = options.mapping?.content ? mapCompletion(object, options.mapping, true) : object;
        const parts = options.mapping?.content ? mappedEventParts(mapped) : [mapped];
        for (const part of parts) {
          yield encoder.encode(`data: ${JSON.stringify(part)}\n\n`);
        }
      }
    } catch (error) {
      if (cancelled) return;
      if (signal?.aborted || isChatCompletionFailure(error)) throw error;
      throw makeFailure('NETWORK_ERROR', details, options);
    }
    if (!complete && !cancelled && !signal?.aborted) throw makeFailure('STREAM_INCOMPLETE', details, options);
  }

  const iterator = checked();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      reader.cancel(reason).catch(() => undefined);
      await iterator.return(undefined);
      reader.releaseLock();
    },
  });
}

function retryDelay(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : fallback;
}

function waitForRetry(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function createTransportFetch(options: TransportOptions, matchAnyURL: boolean) {
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!matchAnyURL && !isChatCompletionsURL(url)) return fetch(url, init);

    const streaming = requestIsStreaming(init);
    const configuredRetries = options.retry?.maxRetries;
    const maxRetries = options.retry
      ? typeof configuredRetries === 'number' && configuredRetries >= 0
        ? configuredRetries
        : 2
      : 0;
    const delayMs =
      typeof options.retry?.delayMs === 'number' && options.retry.delayMs > 0 ? options.retry.delayMs : 1000;
    let response: Response;
    try {
      response = await fetch(url, init);
      for (
        let attempt = 0;
        !streaming && attempt < maxRetries && (response.status === 429 || response.status >= 500);
        attempt++
      ) {
        const wait = retryDelay(response.headers.get('retry-after'), delayMs * (attempt + 1));
        response.body?.cancel().catch(() => undefined);
        await waitForRetry(wait, init?.signal);
        response = await fetch(url, init);
      }
    } catch (error) {
      const errorName = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
      const errorCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (init?.signal?.aborted || errorName === 'AbortError') throw error;
      const code = errorName === 'TimeoutError' || errorCode === 'ETIMEDOUT' ? 'TIMEOUT' : 'NETWORK_ERROR';
      return reportBeforeHeaders(makeFailure(code, { stage: 'request' }, options), options);
    }

    const requestId = getRequestId(response.headers);
    if (!response.ok) {
      const upstreamError = await readErrorResponse(response);
      if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const failure = makeFailure(
        classifyUpstreamError(upstreamError) ?? 'HTTP_ERROR',
        {
          stage: 'response',
          status: response.status,
          requestId,
          upstreamCode: upstreamCode(upstreamError),
        },
        options,
      );
      const headers = new Headers({ 'content-type': 'application/json' });
      for (const name of ['x-litellm-call-id', 'x-request-id', 'request-id']) {
        const value = safeIdentifier(response.headers.get(name));
        if (value) headers.set(name, value);
      }
      headers.set('x-nocobase-correlation-id', failure.correlationId);
      return new Response(JSON.stringify({ error: { message: failure.message, code: failure.code } }), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') || (streaming && !contentType.includes('application/json'))) {
      if (contentType.includes('text/event-stream') && requestExplicitlyNonStreaming(init)) {
        response.body?.cancel().catch(() => undefined);
        return reportBeforeHeaders(
          makeFailure('MALFORMED_STREAM', { stage: 'response', status: response.status, requestId }, options),
          options,
        );
      }
      const body = createCheckedStream(response, options, init?.signal);
      if (!body)
        return reportBeforeHeaders(
          makeFailure('STREAM_INCOMPLETE', { stage: 'stream', status: response.status, requestId }, options),
          options,
        );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.headers, 'text/event-stream'),
      });
    }
    if (!contentType.includes('application/json')) return response;

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      const errorName = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
      if (init?.signal?.aborted || errorName === 'AbortError') throw error;
      return reportBeforeHeaders(
        makeFailure('NETWORK_ERROR', { stage: 'response', status: response.status, requestId }, options),
        options,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      if (streaming) {
        return reportBeforeHeaders(
          makeFailure('MALFORMED_STREAM', { stage: 'response', status: response.status, requestId }, options),
          options,
        );
      }
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.headers, contentType),
      });
    }
    if (asObject(body)?.error) {
      return reportBeforeHeaders(
        makeFailure(
          classifyUpstreamError(body) ?? 'UPSTREAM_STREAM_ERROR',
          {
            stage: 'response',
            status: response.status,
            requestId,
            upstreamCode: upstreamCode(body),
          },
          options,
        ),
        options,
      );
    }
    if (streaming) {
      return reportBeforeHeaders(
        makeFailure('MALFORMED_STREAM', { stage: 'response', status: response.status, requestId }, options),
        options,
      );
    }
    const failure = failForFinishReason(
      getFinishReason(body, options.mapping),
      { stage: 'response', status: response.status, requestId },
      options,
    );
    if (failure) return reportBeforeHeaders(failure, options);
    const object = asObject(body);
    const mapped = object && options.mapping?.content ? mapCompletion(object, options.mapping, false) : body;
    return new Response(JSON.stringify(mapped), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers, contentType),
    });
  };
}

export function createChatCompletionsFetch(options: TransportOptions = {}) {
  return createTransportFetch(options, false);
}

export function createMappingFetch(responseMapping: Record<string, string>, retry?: RetryOptions) {
  if (!responseMapping.content) return undefined;
  return createTransportFetch({ mapping: responseMapping, retry }, true);
}
