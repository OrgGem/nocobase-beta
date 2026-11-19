// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  collectRequestMessageContexts,
  prepareSignedMessage,
  restoreRequestMessageContexts,
  SIGNED_CONTEXT_KEY,
  SignedStreamAccumulator,
} from '../llm-providers/signed-context';

const scope = { service: 'shared-litellm', model: 'gemini-alias', sessionId: 'session-1' };
const geminiSignature = 'encoded-gemini-thought-signature';

describe('signed provider context', () => {
  it('merges streamed Gemini id fragments while retaining signature metadata and keeping the tool id short', () => {
    const accumulator = new SignedStreamAccumulator();
    accumulator.addToolCalls([
      {
        index: 0,
        id: 'call-1__thought__encoded-',
        type: 'function',
        function: { name: 'look', arguments: '{"q":' },
        provider_specific_fields: { google: { thought_signature: 'encoded-' } },
      },
    ]);
    accumulator.addToolCalls([
      {
        index: 0,
        id: 'gemini-thought-signature',
        function: { arguments: '"weather"}' },
        provider_specific_fields: { google: { thought_signature: 'signature' } },
      },
    ]);
    const result = accumulator.result(scope);

    expect(result.toolCallChunks).toMatchObject([{ id: 'call-1', name: 'look', args: '{"q":"weather"}' }]);
    expect(result.signedContext?.toolCalls).toEqual([
      {
        id: 'call-1',
        originalId: `call-1__thought__encoded-gemini-thought-signature`,
        providerSpecificFields: { google: { thought_signature: 'encoded-signature' } },
      },
    ]);
  });

  it('restores signed Gemini call ids and matching tool result ids after JSON history serialization', () => {
    const originalId = `call-gemini__thought__${geminiSignature}`;
    const prepared = prepareSignedMessage(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: originalId,
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"weather"}' },
          },
        ],
      },
      scope,
    );
    const persisted = JSON.parse(JSON.stringify(prepared.signedContext));
    const messages = [
      {
        role: 'assistant',
        tool_calls: prepared.message.tool_calls,
        additional_kwargs: { [SIGNED_CONTEXT_KEY]: persisted },
      },
      { role: 'tool', tool_call_id: 'call-gemini', content: 'sunny' },
    ];
    const contexts = collectRequestMessageContexts(messages, scope, false);
    const request = {
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-gemini', type: 'function' }] },
        { role: 'tool', tool_call_id: 'call-gemini', content: 'sunny' },
      ],
    };

    restoreRequestMessageContexts(request, contexts);

    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: originalId, type: 'function' }],
      },
      { role: 'tool', tool_call_id: originalId, content: 'sunny' },
    ]);
  });

  it('retains ordered Claude signed and redacted thinking blocks through history serialization', () => {
    const thinkingBlocks = [
      { type: 'thinking', thinking: 'plan', signature: 'claude-signature' },
      { type: 'redacted_thinking', data: 'opaque-redacted-data' },
    ];
    const prepared = prepareSignedMessage({ role: 'assistant', content: null, thinking_blocks: thinkingBlocks }, scope);
    const stored = JSON.parse(JSON.stringify(prepared.signedContext));
    const messages = [{ role: 'assistant', tool_calls: [], additional_kwargs: { [SIGNED_CONTEXT_KEY]: stored } }];
    const contexts = collectRequestMessageContexts(messages, scope, false);
    const request = {
      messages: [{ role: 'assistant', content: null, tool_calls: [] }],
    };

    restoreRequestMessageContexts(request, contexts);

    expect(request.messages[0]).toMatchObject({ thinking_blocks: thinkingBlocks });
  });

  it('assembles Claude thinking and signature deltas, redacted blocks, and signature-only blocks', () => {
    const accumulator = new SignedStreamAccumulator();
    accumulator.addThinkingBlocks([
      { type: 'thinking', index: 0, thinking: 'plan-', signature: 'sig-' },
      { type: 'redacted_thinking', index: 1, data: 'opaque-' },
      { type: 'thinking', index: 2, thinking: 'second-', signature: 'second-' },
      { type: 'thinking', index: 3, signature: 'signature-only' },
    ]);
    accumulator.addThinkingBlocks([
      { type: 'thinking', index: 0, thinking: 'continued', signature: 'tail' },
      { type: 'redacted_thinking', index: 1, data: 'data' },
      { type: 'thinking', index: 2, thinking: 'continued', signature: 'tail' },
      { type: 'thinking', index: 3, signature: 'continued-signature' },
    ]);

    expect(accumulator.result(scope).signedContext?.thinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'plan-continued', signature: 'sig-tail' },
      { type: 'redacted_thinking', data: 'opaque-data' },
      { type: 'thinking', thinking: 'second-continued', signature: 'second-tail' },
      { type: 'thinking', signature: 'signature-onlycontinued-signature' },
    ]);
  });

  it('assigns missing block indexes in order for Claude thinking, redaction, and next thinking blocks', () => {
    const accumulator = new SignedStreamAccumulator();
    accumulator.addThinkingBlocks([
      { type: 'thinking', thinking: 'first', signature: 'first-signature' },
      { type: 'redacted_thinking', data: 'redacted-payload' },
      { type: 'thinking', thinking: 'second', signature: 'second-signature' },
      { type: 'thinking', signature: 'signature-only' },
    ]);

    expect(accumulator.result(scope).signedContext?.thinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'first', signature: 'first-signature' },
      { type: 'redacted_thinking', data: 'redacted-payload' },
      { type: 'thinking', thinking: 'second', signature: 'second-signature' },
      { type: 'thinking', signature: 'signature-only' },
    ]);
  });

  it('ignores prototype mutation keys while collecting Gemini provider-specific fields', () => {
    const accumulator = new SignedStreamAccumulator();
    const toolCall = JSON.parse(
      '{"id":"call-1","index":0,"function":{"name":"lookup","arguments":"{}"},"provider_specific_fields":{"__proto__":{"polluted":true},"google":{"thought_signature":"safe-signature"}}}',
    );
    const thinkingBlock = JSON.parse('{"type":"thinking","index":0,"__proto__":{"polluted":true},"thinking":"safe"}');

    accumulator.addToolCalls([toolCall]);
    accumulator.addThinkingBlocks([thinkingBlock]);
    const result = accumulator.result(scope);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.signedContext?.toolCalls).toEqual([
      { id: 'call-1', providerSpecificFields: { google: { thought_signature: 'safe-signature' } } },
    ]);
    expect(result.signedContext?.thinkingBlocks).toEqual([{ type: 'thinking', thinking: 'safe' }]);
  });

  it('ignores signed metadata that belongs to another session, service, or model', () => {
    const prepared = prepareSignedMessage(
      {
        tool_calls: [
          {
            id: `call-1__thought__${geminiSignature}`,
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
      scope,
    );
    const message = {
      role: 'assistant',
      tool_calls: prepared.message.tool_calls,
      additional_kwargs: { [SIGNED_CONTEXT_KEY]: prepared.signedContext },
    };
    const request = {
      messages: [{ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function' }] }],
    };

    restoreRequestMessageContexts(
      request,
      collectRequestMessageContexts([message], { ...scope, sessionId: 'session-2' }, false),
    );

    expect(request.messages[0]?.tool_calls).toEqual([{ id: 'call-1', type: 'function' }]);
  });

  it('keeps reasoning restoration gated by its setting', () => {
    const message = {
      role: 'assistant',
      tool_calls: [],
      additional_kwargs: { reasoning_content: 'private reasoning' },
    };

    expect(collectRequestMessageContexts([message], scope, false)).toEqual([undefined]);
    expect(collectRequestMessageContexts([message], scope, true)).toEqual([
      { toolCallIds: [], reasoningContent: 'private reasoning', signedContext: undefined },
    ]);
  });
});
