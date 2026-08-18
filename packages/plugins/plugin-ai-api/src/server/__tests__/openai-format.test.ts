import { toOpenAIResponse, toOpenAIStreamChunk, toOpenAIUsageChunk } from '../utils/openai-format';
import { isStreamingRequested } from '../utils/streaming';
import { applyProviderRequestParameters, getProviderRequestParameters } from '../routes/chat-completions';

describe('AI API OpenAI tool-call formatting', () => {
  it('streams by default and only disables streaming for an explicit false value', () => {
    expect(isStreamingRequested(undefined)).toBe(true);
    expect(isStreamingRequested(true)).toBe(true);
    expect(isStreamingRequested(false)).toBe(false);
  });
  it('returns tool calls and the matching finish reason for a non-stream response', () => {
    const response = toOpenAIResponse({
      id: 'chatcmpl-1',
      model: 'service/model',
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' },
        },
      ],
    });

    expect(response.choices[0].finish_reason).toBe('tool_calls');
    expect(response.choices[0].message.tool_calls).toEqual([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' },
      },
    ]);
  });

  it('formats streaming tool-call deltas', () => {
    const chunk = toOpenAIStreamChunk({
      id: 'chatcmpl-1',
      model: 'service/model',
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city"' },
          },
        ],
      },
    });

    expect(chunk.choices[0].delta.tool_calls?.[0].function?.name).toBe('get_weather');
  });
});

describe('AI API OpenAI usage-only streaming chunks', () => {
  it('includes a null usage field for normal chunks', () => {
    const chunk = toOpenAIStreamChunk({
      id: 'chatcmpl-1',
      model: 'service/model',
      delta: { content: 'Hello' },
    });

    expect(chunk.choices).toHaveLength(1);
    expect(chunk).toHaveProperty('usage', null);
  });

  it('includes a null usage field for finish chunks', () => {
    const chunk = toOpenAIStreamChunk({
      id: 'chatcmpl-1',
      model: 'service/model',
      delta: {},
      finishReason: 'stop',
    });

    expect(chunk.choices[0].finish_reason).toBe('stop');
    expect(chunk).toHaveProperty('usage', null);
  });

  it('formats a usage-only chat completion chunk with an empty choices array', () => {
    const chunk = toOpenAIUsageChunk({
      id: 'chatcmpl-1',
      model: 'service/model',
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      object: 'chat.completion.chunk',
    });

    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices).toEqual([]);
    expect(chunk.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 3,
      total_tokens: 11,
      prompt_tokens_details: { cached_tokens: null },
    });
  });

  it('formats a usage-only legacy text completion chunk', () => {
    const chunk = toOpenAIUsageChunk({
      id: 'cmpl-1',
      model: 'service/model',
      usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 },
      object: 'text_completion',
    });

    expect(chunk.object).toBe('text_completion');
    expect(chunk.choices).toEqual([]);
    expect(chunk.usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 5,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: null },
    });
  });
});

describe('AI API provider parameter forwarding', () => {
  it('forwards model and tool-call parameters not managed by the gateway', () => {
    const parameters = getProviderRequestParameters({
      model: 'service/model',
      messages: [{ role: 'user', content: 'Use a tool' }],
      tools: [{ type: 'function', function: { name: 'search' } }],
      tool_choice: 'auto',
      stream: true,
      n: 1,
      parallel_tool_calls: false,
      reasoning_effort: 'medium',
      max_completion_tokens: 4096,
      seed: 7,
      service_tier: 'default',
    });

    expect(parameters).toEqual({
      parallel_tool_calls: false,
      reasoning_effort: 'medium',
      max_completion_tokens: 4096,
      seed: 7,
      service_tier: 'default',
    });
  });

  it('merges passthrough parameters into model kwargs and removes the synthetic text response format', () => {
    const model = {
      modelKwargs: {
        response_format: { type: 'text' },
        existing_provider_option: true,
      },
    };

    applyProviderRequestParameters(model, {
      parallel_tool_calls: false,
      reasoning_effort: 'high',
    });

    expect(model.modelKwargs).toEqual({
      existing_provider_option: true,
      parallel_tool_calls: false,
      reasoning_effort: 'high',
    });
  });

  it('preserves an explicitly requested response format', () => {
    const model = { modelKwargs: { response_format: { type: 'text' } } };
    const responseFormat = { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } };

    applyProviderRequestParameters(model, { response_format: responseFormat });

    expect(model.modelKwargs.response_format).toEqual(responseFormat);
  });
});
