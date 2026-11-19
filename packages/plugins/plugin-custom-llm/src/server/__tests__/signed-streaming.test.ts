// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/server';
import { HumanMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomLLMProvider } from '../llm-providers/custom-llm';
import { SIGNED_CONTEXT_KEY } from '../llm-providers/signed-context';

function event(delta: Record<string, unknown>, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    model: 'claude-stream',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function createProvider() {
  const app = {
    environment: { renderJsonTemplate: (value: Record<string, unknown>) => value },
    getVersion: () => '2.2.40',
    pm: { get: () => ({}) },
  } as unknown as Application;
  return new CustomLLMProvider({
    app,
    serviceOptions: {
      apiKey: 'test-key',
      baseURL: 'https://litellm.example.test/v1',
      apiMode: 'chat-completions',
      claudeModelAliases: ['claude-stream'],
    },
    modelOptions: { model: 'claude-stream', llmService: 'lite' },
    requestContext: { sessionId: 'claude-stream-session' },
  });
}

describe('Claude signed stream conversion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps ordered top-level and provider-specific thinking block deltas through LangChain streaming', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            event({
              role: 'assistant',
              thinking_blocks: [
                { type: 'thinking', index: 0, thinking: 'plan-', signature: 'signature-' },
                { type: 'redacted_thinking', index: 1, data: 'opaque-' },
              ],
              provider_specific_fields: {
                thinking_blocks: [
                  { type: 'thinking', index: 90, thinking: 'must not persist', signature: 'wrong-source' },
                ],
              },
            }),
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            event({
              thinking_blocks: [{ type: 'thinking', index: 0, thinking: 'discarded', signature: 'discarded' }],
              provider_specific_fields: {
                thinking_blocks: [
                  { type: 'thinking', index: 0, thinking: 'continued', signature: 'tail' },
                  { type: 'redacted_thinking', index: 1, data: 'data' },
                  { type: 'thinking', index: 2, signature: 'signature-only' },
                ],
              },
            }),
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            event({
              provider_specific_fields: {
                thinking_blocks: [
                  { type: 'redacted_thinking', index: 1, data: 'data' },
                  { type: 'thinking', index: 2, signature: 'signature-only' },
                ],
              },
            }),
          ),
        );
        controller.enqueue(new TextEncoder().encode(event({}, 'stop')));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const mockFetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-request-id': 'claude-stream-1' },
        }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const chunks = [];

    for await (const chunk of await createProvider()
      .createModel()
      .stream([new HumanMessage('Continue safely')])) {
      chunks.push(chunk);
    }

    expect(mockFetch).toHaveBeenCalledOnce();
    const signedContext = chunks.at(-1)?.additional_kwargs[SIGNED_CONTEXT_KEY];
    expect(signedContext).toMatchObject({
      service: 'lite',
      model: 'claude-stream',
      sessionId: 'claude-stream-session',
      thinkingBlocks: [
        { type: 'thinking', thinking: 'plan-discarded', signature: 'signature-discarded' },
        { type: 'redacted_thinking', data: 'opaque-data' },
        { type: 'thinking', signature: 'signature-only' },
      ],
    });
    expect(JSON.stringify(signedContext)).not.toContain('must not persist');
    expect(JSON.stringify(signedContext)).not.toContain('wrong-source');
  });
});
