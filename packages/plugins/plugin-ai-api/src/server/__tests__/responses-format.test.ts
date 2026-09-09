import { describe, expect, it } from 'vitest';
import type { OpenAIUsage } from '../utils/openai-format';
import {
  chatResultToResponse,
  extractReasoningText,
  extractResponseIncompleteReason,
  extractResponseOutputText,
  responsesBodyToChatBody,
  responsesInputToMessages,
} from '../utils/responses-format';
import {
  appendResponseStreamChunk,
  createResponseStartEvents,
  createResponseStreamState,
  finalizeResponseStream,
  setResponseStreamUsage,
} from '../utils/responses-stream';

describe('Responses API wire format', () => {
  it('converts text, image, file, and function output input items', () => {
    expect(
      responsesInputToMessages(
        [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe this' },
              { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'high' },
              { type: 'input_file', file_url: 'https://example.com/file.pdf' },
            ],
          },
          { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
        ],
        'Be concise',
      ),
    ).toEqual([
      { role: 'developer', content: 'Be concise' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } },
          { type: 'file_url', file_url: { url: 'https://example.com/file.pdf' } },
        ],
      },
      { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
    ]);
  });

  it('preserves reasoning and parallel function-call ordering for continuation', () => {
    expect(
      responsesInputToMessages([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather?' }] },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'Call both tools' }],
        },
        { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"Hanoi"}' },
        { type: 'function_call', call_id: 'call_2', name: 'time', arguments: '{"city":"Hanoi"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ]),
    ).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [expect.objectContaining({ id: 'call_1' }), expect.objectContaining({ id: 'call_2' })],
        additional_kwargs: expect.objectContaining({ reasoning_content: 'Call both tools' }),
      }),
      { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
    ]);
  });

  it('maps Responses function tools and advanced request parameters', () => {
    expect(
      responsesBodyToChatBody({
        model: 'service/model',
        input: 'Hello',
        max_output_tokens: 100,
        service_tier: 'flex',
        prompt_cache_key: 'cache-key',
        prompt_cache_retention: '24h',
        reasoning: { effort: 'medium' },
        text: {
          format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true },
          verbosity: 'low',
        },
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
        tool_choice: { type: 'function', name: 'lookup' },
      }),
    ).toMatchObject({
      max_completion_tokens: 100,
      service_tier: 'flex',
      promptCacheKey: 'cache-key',
      promptCacheRetention: '24h',
      reasoning: { effort: 'medium' },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
      verbosity: 'low',
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    });
  });

  it('returns the OpenAI Responses output message and usage schema', () => {
    const response = chatResultToResponse({
      id: 'resp_test',
      model: 'service/model',
      content: 'Hello',
      reasoningText: 'Reasoning summary',
      serviceTier: 'priority',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_cache_tokens: 2,
        reasoning_tokens: 3,
      },
      requestBody: { input: 'Hi', service_tier: 'flex' },
    });

    expect(response).toMatchObject({
      id: 'resp_test',
      object: 'response',
      created_at: expect.any(Number),
      output_text: 'Hello',
      service_tier: 'priority',
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 15,
      },
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Reasoning summary' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
        },
      ],
    });
  });

  it('extracts native LangChain Responses text and reasoning blocks', () => {
    const result = {
      content: [
        { type: 'reasoning', reasoning: 'step one' },
        { type: 'reasoning', reasoning: ' and two' },
        { type: 'text', text: 'visible ' },
        { type: 'output_text', text: 'answer' },
      ],
    };

    expect(extractReasoningText(result)).toBe('step one and two');
    expect(extractResponseOutputText(result)).toBe('visible answer');
    expect(
      extractReasoningText({
        additional_kwargs: {
          reasoning: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'summary' }],
          },
        },
      }),
    ).toBe('summary');
  });

  it('uses OpenAI terminal fields for incomplete responses', () => {
    const response = chatResultToResponse({
      id: 'resp_incomplete',
      model: 'service/model',
      content: 'Filtered',
      finishReason: 'content_filter',
      requestBody: { input: 'Hi' },
    });

    expect(response).toMatchObject({
      status: 'incomplete',
      completed_at: null,
      incomplete_details: { reason: 'content_filter' },
    });
  });

  it('reads incomplete details emitted by native Responses providers', () => {
    const response = chatResultToResponse({
      model: 'service/model',
      content: 'Partial',
      finishReason: extractResponseIncompleteReason({
        response_metadata: { incomplete_details: { reason: 'max_output_tokens' } },
      }),
      requestBody: { input: 'Hello' },
    });

    expect(response).toMatchObject({
      status: 'incomplete',
      completed_at: null,
      incomplete_details: { reason: 'max_output_tokens' },
    });
  });
});

describe('Responses API streaming wire format', () => {
  it('emits ordered lifecycle events with sequence numbers', () => {
    const state = createResponseStreamState('resp_stream', 'service/model', { input: 'Hello' });
    const events = [
      ...createResponseStartEvents(state),
      ...appendResponseStreamChunk(state, { content: 'Hel' }),
      ...appendResponseStreamChunk(state, { content: 'lo', response_metadata: { finish_reason: 'stop' } }),
    ];
    setResponseStreamUsage(state, {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    } as OpenAIUsage);
    events.push(...finalizeResponseStream(state));

    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: { output_text: 'Hello', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    });
  });

  it('emits function call argument events', () => {
    const state = createResponseStreamState('resp_tool', 'service/model', { input: 'Weather?' });
    createResponseStartEvents(state);
    const events = [
      ...appendResponseStreamChunk(state, {
        tool_call_chunks: [{ index: 0, id: 'call_1', name: 'weather', args: '{"city"' }],
      }),
      ...appendResponseStreamChunk(state, {
        tool_call_chunks: [{ index: 0, args: ':"Hanoi"}' }],
      }),
      ...finalizeResponseStream(state),
    ];

    expect(events.map((event) => event.type)).toContain('response.function_call_arguments.delta');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.function_call_arguments.done',
        name: 'weather',
        arguments: '{"city":"Hanoi"}',
      }),
    );
  });

  it('reads an alternate finish-reason location and leaves incomplete responses without completed_at', () => {
    const state = createResponseStreamState('resp_incomplete', 'service/model', { input: 'Hello' });
    createResponseStartEvents(state);
    appendResponseStreamChunk(state, {
      content: [{ type: 'output_text', text: 'Partial' }],
      additional_kwargs: { finish_reason: 'max_tokens' },
    });
    const events = finalizeResponseStream(state);

    expect(events.at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        completed_at: null,
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: 'Partial',
      },
    });
  });

  it('reads native Responses incomplete details while streaming', () => {
    const state = createResponseStreamState('resp_native_incomplete', 'service/model', { input: 'Hello' });
    createResponseStartEvents(state);
    appendResponseStreamChunk(state, {
      content: 'Partial',
      response_metadata: { incomplete_details: { reason: 'content_filter' } },
    });
    const events = finalizeResponseStream(state);

    expect(events.at(-1)).toMatchObject({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'content_filter' } },
    });
  });
});
