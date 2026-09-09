/**
 * Golden contract tests for the Responses API wire format.
 *
 * These tests validate that the gateway's Response objects and SSE events conform to the
 * OpenAI SDK type definitions. They do NOT call a live provider — they exercise the
 * gateway's own formatting code against the installed openai package's TypeScript types.
 */

import { describe, expect, it } from 'vitest';
import type {
  Response as OpenAIResponse,
  ResponseCompletedEvent,
  ResponseCreatedEvent,
  ResponseFailedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseInProgressEvent,
  ResponseIncompleteEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseContentPartAddedEvent,
  ResponseContentPartDoneEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
  ResponseReasoningTextDeltaEvent,
  ResponseReasoningTextDoneEvent,
  ResponseErrorEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import { formatSSEDone, type OpenAIUsage } from '../utils/openai-format';
import {
  chatResultToResponse,
  createResponseOutputMessage,
  createResponseReasoningItem,
  generateResponseId,
  generateResponseItemId,
  responseUsageFromOpenAIUsage,
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
  type ResponseStreamEvent,
} from '../utils/responses-stream';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Assert that a value satisfies the OpenAI SDK Response type at compile time. */
function assertOpenAIResponse(value: unknown): asserts value is OpenAIResponse {
  // Runtime shape checks mirror the SDK's required fields.
  const r = value as Record<string, unknown>;
  expect(typeof r.id).toBe('string');
  expect(r.object).toBe('response');
  expect(typeof r.created_at).toBe('number');
  expect(['completed', 'failed', 'in_progress', 'cancelled', 'queued', 'incomplete']).toContain(r.status);
  expect(Array.isArray(r.output)).toBe(true);
  expect(typeof r.output_text).toBe('string');
  expect(typeof r.model).toBe('string');
  expect(r.error === null || typeof r.error === 'object').toBe(true);
  expect(r.incomplete_details === null || typeof r.incomplete_details === 'object').toBe(true);
  expect(typeof r.parallel_tool_calls).toBe('boolean');
  expect(['auto', 'default', 'flex', 'scale', 'priority']).toContain(r.service_tier);
  expect(r.truncation === 'auto' || r.truncation === 'disabled').toBe(true);
}

function assertOpenAIUsage(value: unknown): asserts value is ResponseUsage {
  const u = value as Record<string, unknown>;
  expect(typeof u.input_tokens).toBe('number');
  expect(typeof u.output_tokens).toBe('number');
  expect(typeof u.total_tokens).toBe('number');
  expect(typeof (u.input_tokens_details as Record<string, unknown>)?.cached_tokens).toBe('number');
  expect(typeof (u.output_tokens_details as Record<string, unknown>)?.reasoning_tokens).toBe('number');
}

function assertStreamEvent<T>(event: unknown, expectedType: string): T {
  const e = event as Record<string, unknown>;
  expect(e.type).toBe(expectedType);
  expect(typeof e.sequence_number).toBe('number');
  return event as T;
}

// ─── Non-streaming Response object contract ─────────────────────────────────

describe('Responses API contract: non-streaming Response object', () => {
  it('produces a Response that satisfies the OpenAI SDK type', () => {
    const response = chatResultToResponse({
      id: 'resp_contract_1',
      model: 'test-service/gpt-4o',
      content: 'Hello world',
      reasoningText: 'Let me think about this',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_cache_tokens: 2,
        reasoning_tokens: 3,
      },
      toolCalls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' },
        },
      ],
      finishReason: 'stop',
      serviceTier: 'default',
      requestBody: {
        input: 'What is the weather?',
        model: 'test-service/gpt-4o',
        tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        truncation: 'disabled',
        service_tier: 'default',
        metadata: { env: 'test' },
      },
    });

    assertOpenAIResponse(response);
    assertOpenAIUsage(response.usage);

    // Verify output structure: reasoning item + message item + function_call item
    expect(response.output).toHaveLength(3);
    expect(response.output[0].type).toBe('reasoning');
    expect(response.output[1].type).toBe('message');
    expect(response.output[2].type).toBe('function_call');

    // Reasoning item shape
    const reasoning = response.output[0] as { type: string; summary: unknown[]; content?: unknown[] };
    expect(reasoning.summary).toEqual([]);
    expect(Array.isArray(reasoning.content)).toBe(true);

    // Message item shape
    const message = response.output[1] as { type: string; role: string; content: unknown[]; status: string };
    expect(message.role).toBe('assistant');
    expect(message.status).toBe('completed');
    expect((message.content[0] as Record<string, unknown>).type).toBe('output_text');

    // Function call item shape
    const fc = response.output[2] as { type: string; call_id: string; name: string; arguments: string; status: string };
    expect(fc.call_id).toBe('call_abc');
    expect(fc.name).toBe('get_weather');
    expect(fc.arguments).toBe('{"city":"Hanoi"}');
    expect(fc.status).toBe('completed');

    // Metadata passthrough
    expect(response.metadata).toEqual({ env: 'test' });
  });

  it('produces an incomplete Response when finish reason indicates truncation', () => {
    const response = chatResultToResponse({
      model: 'test-service/gpt-4o',
      content: 'Partial answer',
      finishReason: 'length',
      requestBody: { input: 'Explain everything', max_output_tokens: 10 },
    });

    assertOpenAIResponse(response);
    expect(response.status).toBe('incomplete');
    expect(response.completed_at).toBeNull();
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('produces an incomplete Response for content_filter finish reason', () => {
    const response = chatResultToResponse({
      model: 'test-service/gpt-4o',
      content: 'Filtered',
      finishReason: 'content_filter',
      requestBody: { input: 'Something sensitive' },
    });

    assertOpenAIResponse(response);
    expect(response.status).toBe('incomplete');
    expect(response.incomplete_details).toEqual({ reason: 'content_filter' });
  });

  it('maps usage with all detail fields', () => {
    const usage = responseUsageFromOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_cache_tokens: 80,
      reasoning_tokens: 10,
    } as OpenAIUsage);

    assertOpenAIUsage(usage);
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usage.total_tokens).toBe(150);
    expect(usage.input_tokens_details.cached_tokens).toBe(80);
    expect(usage.output_tokens_details.reasoning_tokens).toBe(10);
  });

  it('defaults missing usage fields to zero', () => {
    const usage = responseUsageFromOpenAIUsage(undefined);
    assertOpenAIUsage(usage);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
    expect(usage.input_tokens_details.cached_tokens).toBe(0);
    expect(usage.output_tokens_details.reasoning_tokens).toBe(0);
  });
});

// ─── Streaming SSE event contract ───────────────────────────────────────────

describe('Responses API contract: streaming SSE events', () => {
  it('emits response.created and response.in_progress with valid Response snapshots', () => {
    const state = createResponseStreamState('resp_stream_1', 'test-service/gpt-4o', { input: 'Hello' });
    const startEvents = createResponseStartEvents(state);

    expect(startEvents).toHaveLength(2);

    const created = assertStreamEvent<ResponseCreatedEvent>(startEvents[0], 'response.created');
    assertOpenAIResponse(created.response);
    expect(created.response.status).toBe('in_progress');

    const inProgress = assertStreamEvent<ResponseInProgressEvent>(startEvents[1], 'response.in_progress');
    assertOpenAIResponse(inProgress.response);
    expect(inProgress.response.status).toBe('in_progress');
  });

  it('emits text delta events with correct shape and monotonic sequence numbers', () => {
    const state = createResponseStreamState('resp_stream_2', 'test-service/gpt-4o', { input: 'Hello' });
    createResponseStartEvents(state);

    const chunk1 = appendResponseStreamChunk(state, { content: 'Hel' });
    const chunk2 = appendResponseStreamChunk(state, { content: 'lo' });

    // First chunk should add item + part + delta
    expect(chunk1.length).toBeGreaterThanOrEqual(3);
    assertStreamEvent<ResponseOutputItemAddedEvent>(chunk1[0], 'response.output_item.added');
    assertStreamEvent<ResponseContentPartAddedEvent>(chunk1[1], 'response.content_part.added');
    assertStreamEvent<ResponseTextDeltaEvent>(chunk1[2], 'response.output_text.delta');

    // Second chunk should be just a delta
    expect(chunk2).toHaveLength(1);
    const delta = assertStreamEvent<ResponseTextDeltaEvent>(chunk2[0], 'response.output_text.delta');
    expect(delta.delta).toBe('lo');
    expect(typeof delta.item_id).toBe('string');
    expect(typeof delta.output_index).toBe('number');
    expect(typeof delta.content_index).toBe('number');
    expect(Array.isArray(delta.logprobs)).toBe(true);

    // Sequence numbers must be strictly increasing across all events
    const allEvents = [...chunk1, ...chunk2];
    for (let i = 1; i < allEvents.length; i++) {
      expect((allEvents[i] as ResponseStreamEvent).sequence_number).toBeGreaterThan(
        (allEvents[i - 1] as ResponseStreamEvent).sequence_number,
      );
    }
  });

  it('emits reasoning text delta events with correct shape', () => {
    const state = createResponseStreamState('resp_stream_reasoning', 'test-service/o3', { input: 'Think' });
    createResponseStartEvents(state);

    const chunks = appendResponseStreamChunk(state, {
      reasoning_content: 'Step one: analyze the problem',
    });

    // Should add reasoning item + part + delta
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    assertStreamEvent<ResponseOutputItemAddedEvent>(chunks[0], 'response.output_item.added');
    assertStreamEvent<ResponseContentPartAddedEvent>(chunks[1], 'response.content_part.added');
    const delta = assertStreamEvent<ResponseReasoningTextDeltaEvent>(chunks[2], 'response.reasoning_text.delta');
    expect(delta.delta).toBe('Step one: analyze the problem');
    expect(typeof delta.item_id).toBe('string');
    expect(typeof delta.output_index).toBe('number');
    expect(typeof delta.content_index).toBe('number');
  });

  it('emits function call argument events with correct shape', () => {
    const state = createResponseStreamState('resp_stream_fc', 'test-service/gpt-4o', { input: 'Weather?' });
    createResponseStartEvents(state);

    const chunk1 = appendResponseStreamChunk(state, {
      tool_call_chunks: [{ index: 0, id: 'call_xyz', name: 'get_weather', args: '{"city"' }],
    });
    const chunk2 = appendResponseStreamChunk(state, {
      tool_call_chunks: [{ index: 0, args: ':"Hanoi"}' }],
    });

    // First chunk: item added + arguments delta
    const addedEvent = chunk1.find((e) => (e as ResponseStreamEvent).type === 'response.output_item.added');
    expect(addedEvent).toBeDefined();
    const added = addedEvent as ResponseOutputItemAddedEvent;
    expect((added.item as Record<string, unknown>).type).toBe('function_call');

    const delta1 = chunk1.find((e) => (e as ResponseStreamEvent).type === 'response.function_call_arguments.delta');
    expect(delta1).toBeDefined();
    const d1 = delta1 as ResponseFunctionCallArgumentsDeltaEvent;
    expect(d1.delta).toBe('{"city"');
    expect(typeof d1.item_id).toBe('string');
    expect(typeof d1.output_index).toBe('number');

    // Second chunk: just arguments delta
    expect(chunk2).toHaveLength(1);
    const d2 = assertStreamEvent<ResponseFunctionCallArgumentsDeltaEvent>(
      chunk2[0],
      'response.function_call_arguments.delta',
    );
    expect(d2.delta).toBe(':"Hanoi"}');
  });

  it('emits terminal events with completed Response and [DONE] marker', () => {
    const state = createResponseStreamState('resp_stream_done', 'test-service/gpt-4o', { input: 'Hello' });
    createResponseStartEvents(state);
    appendResponseStreamChunk(state, { content: 'Hi there' });
    setResponseStreamUsage(state, {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    } as OpenAIUsage);

    const finalEvents = finalizeResponseStream(state);

    // Should contain: text.done, content_part.done, output_item.done, response.completed
    const types = finalEvents.map((e) => (e as ResponseStreamEvent).type);
    expect(types).toContain('response.output_text.done');
    expect(types).toContain('response.content_part.done');
    expect(types).toContain('response.output_item.done');
    expect(types).toContain('response.completed');
    // [DONE] sentinel is written by the route layer after all terminal events.
    expect(formatSSEDone()).toBe('data: [DONE]\n\n');

    const completed = finalEvents.find(
      (e) => (e as ResponseStreamEvent).type === 'response.completed',
    ) as ResponseCompletedEvent;
    assertOpenAIResponse(completed.response);
    expect(completed.response.status).toBe('completed');
    expect(completed.response.output_text).toBe('Hi there');
    assertOpenAIUsage(completed.response.usage);
  });

  it('emits response.incomplete when stream ends with length finish reason', () => {
    const state = createResponseStreamState('resp_stream_incomplete', 'test-service/gpt-4o', { input: 'Long' });
    createResponseStartEvents(state);
    appendResponseStreamChunk(state, {
      content: 'Partial',
      response_metadata: { finish_reason: 'length' },
    });

    const finalEvents = finalizeResponseStream(state);
    const types = finalEvents.map((e) => (e as ResponseStreamEvent).type);
    expect(types).toContain('response.incomplete');
    expect(types).not.toContain('response.completed');

    const incomplete = finalEvents.find(
      (e) => (e as ResponseStreamEvent).type === 'response.incomplete',
    ) as ResponseIncompleteEvent;
    assertOpenAIResponse(incomplete.response);
    expect(incomplete.response.status).toBe('incomplete');
    expect(incomplete.response.completed_at).toBeNull();
    expect(incomplete.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('emits error and response.failed events on stream failure', () => {
    const state = createResponseStreamState('resp_stream_fail', 'test-service/gpt-4o', { input: 'Fail' });
    createResponseStartEvents(state);
    appendResponseStreamChunk(state, { content: 'Partial before error' });

    const errorEvent = createResponseErrorEvent(state, { message: 'Provider timeout', code: 'server_error' });
    const failedEvent = createResponseFailedEvent(state, { message: 'Provider timeout', code: 'server_error' });

    const err = assertStreamEvent<ResponseErrorEvent>(errorEvent, 'error');
    expect(err.code).toBe('server_error');
    expect(err.message).toBe('Provider timeout');

    const failed = assertStreamEvent<ResponseFailedEvent>(failedEvent, 'response.failed');
    assertOpenAIResponse(failed.response);
    expect(failed.response.status).toBe('failed');
    expect(failed.response.error).toEqual({ code: 'server_error', message: 'Provider timeout' });
    expect(failed.response.completed_at).toBeNull();
  });

  it('preserves stable item IDs across the entire stream lifecycle', () => {
    const state = createResponseStreamState('resp_stream_ids', 'test-service/gpt-4o', { input: 'IDs' });
    const startEvents = createResponseStartEvents(state);

    const textChunks = appendResponseStreamChunk(state, { content: 'Hello' });
    const fcChunks = appendResponseStreamChunk(state, {
      tool_call_chunks: [{ index: 0, id: 'call_stable', name: 'fn', args: '{}' }],
    });
    const finalEvents = finalizeResponseStream(state);

    const allEvents = [...startEvents, ...textChunks, ...fcChunks, ...finalEvents];

    // Collect all item_id references from output_item.added events
    const addedItems = allEvents
      .filter((e) => (e as ResponseStreamEvent).type === 'response.output_item.added')
      .map((e) => {
        const item = (e as ResponseOutputItemAddedEvent).item as Record<string, unknown>;
        return { id: item.id, type: item.type };
      });

    // Each item ID should appear consistently in its delta/done events
    for (const added of addedItems) {
      const relatedEvents = allEvents.filter((e) => {
        const ev = e as Record<string, unknown>;
        return ev.item_id === added.id;
      });
      expect(relatedEvents.length).toBeGreaterThan(0);
    }
  });

  it('emits function_call_arguments.done with complete arguments string', () => {
    const state = createResponseStreamState('resp_stream_fc_done', 'test-service/gpt-4o', { input: 'FC' });
    createResponseStartEvents(state);
    appendResponseStreamChunk(state, {
      tool_call_chunks: [{ index: 0, id: 'call_done', name: 'lookup', args: '{"q":"' }],
    });
    appendResponseStreamChunk(state, {
      tool_call_chunks: [{ index: 0, args: 'test"}' }],
    });

    const finalEvents = finalizeResponseStream(state);
    const doneEvent = finalEvents.find(
      (e) => (e as ResponseStreamEvent).type === 'response.function_call_arguments.done',
    ) as ResponseFunctionCallArgumentsDoneEvent;

    expect(doneEvent).toBeDefined();
    expect(doneEvent.name).toBe('lookup');
    expect(doneEvent.arguments).toBe('{"q":"test"}');
    expect(typeof doneEvent.item_id).toBe('string');
    expect(typeof doneEvent.output_index).toBe('number');
  });
});

// ─── Output item constructors ───────────────────────────────────────────────

describe('Responses API contract: output item constructors', () => {
  it('creates output messages with the correct shape', () => {
    const msg = createResponseOutputMessage('Hello', 'completed', 'msg_test_1');
    expect(msg.id).toBe('msg_test_1');
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.status).toBe('completed');
    expect(msg.content).toEqual([{ type: 'output_text', text: 'Hello', annotations: [] }]);
  });

  it('creates reasoning items with the correct shape', () => {
    const item = createResponseReasoningItem('Thinking step 1');
    expect(item.id).toMatch(/^rs_/);
    expect(item.type).toBe('reasoning');
    expect(item.status).toBe('completed');
    expect(item.summary).toEqual([]);
    expect(item.content).toEqual([{ type: 'reasoning_text', text: 'Thinking step 1' }]);
  });

  it('generates unique response IDs with resp_ prefix', () => {
    const id1 = generateResponseId();
    const id2 = generateResponseId();
    expect(id1).toMatch(/^resp_[0-9a-f]{32}$/);
    expect(id2).toMatch(/^resp_[0-9a-f]{32}$/);
    expect(id1).not.toBe(id2);
  });

  it('generates unique item IDs with correct prefixes', () => {
    expect(generateResponseItemId('msg')).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(generateResponseItemId('fc')).toMatch(/^fc_[0-9a-f]{32}$/);
    expect(generateResponseItemId('rs')).toMatch(/^rs_[0-9a-f]{32}$/);
  });
});
