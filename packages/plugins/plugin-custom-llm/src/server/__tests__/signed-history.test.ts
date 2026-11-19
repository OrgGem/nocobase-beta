// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/server';
import type { Model } from '@nocobase/database';
import { AIMessage } from '@langchain/core/messages';
import { AIEmployee } from '../../../../@nocobase/plugin-ai/src/server/ai-employees/ai-employee';
import { convertAIMessage } from '../../../../@nocobase/plugin-ai/src/server/ai-employees/utils';
import { describe, expect, it, vi } from 'vitest';
import { CustomLLMProvider } from '../llm-providers/custom-llm';
import { prepareSignedMessage, SIGNED_CONTEXT_KEY } from '../llm-providers/signed-context';

const signedScope = { service: 'lite', model: 'gemini-route', sessionId: 'history-session' };

function createProvider() {
  const app = {
    environment: { renderJsonTemplate: (value: Record<string, unknown>) => value },
    getVersion: () => '2.2.40',
    pm: { get: () => ({}) },
  } as unknown as Application;
  return new CustomLLMProvider({
    app,
    serviceOptions: { apiKey: 'test-key', baseURL: 'https://litellm.example.test/v1' },
    modelOptions: { model: signedScope.model, llmService: signedScope.service },
    requestContext: { sessionId: signedScope.sessionId },
  });
}

describe('signed provider history through AI Employee persistence adapters', () => {
  it('round trips signed assistant metadata through convertAIMessage and the native history formatter', async () => {
    const provider = createProvider();
    const aiEmployee = Object.create(AIEmployee.prototype) as AIEmployee;
    Reflect.set(aiEmployee, 'employee', { username: 'employee-test' });
    Reflect.set(aiEmployee, 'skillSettings', { tools: [] });
    Reflect.set(aiEmployee, 'plugin', { workContextHandler: {} });
    Reflect.set(aiEmployee, 'ctx', { logger: { warn: vi.fn() } });

    const signed = prepareSignedMessage(
      {
        tool_calls: [
          {
            id: 'call-history__thought__encoded-gemini-signature',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"one"}' },
            provider_specific_fields: { google: { thought_signature: 'encoded-gemini-signature' } },
          },
        ],
      },
      signedScope,
    );
    const aiMessage = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-history', name: 'lookup', args: { query: 'one' }, type: 'tool_call' }],
      additional_kwargs: { [SIGNED_CONTEXT_KEY]: signed.signedContext },
    });
    const values = convertAIMessage({
      aiEmployee,
      providerName: 'custom',
      provider,
      llmService: signedScope.service,
      model: signedScope.model,
      aiMessage,
    });

    if (values == null) throw new Error('Expected convertAIMessage to persist the assistant message');
    expect(values.metadata?.additional_kwargs?.[SIGNED_CONTEXT_KEY]).toEqual(signed.signedContext);

    const formatMessages = Reflect.get(AIEmployee.prototype, 'formatMessages') as (options: {
      messages: NonNullable<typeof values>[];
      provider: CustomLLMProvider;
    }) => Promise<Array<Record<string, unknown>>>;
    const formatted = await formatMessages.call(aiEmployee, { messages: [values], provider });
    const assistant = formatted[0];

    expect(assistant?.tool_calls).toEqual(values?.toolCalls);
    expect((assistant?.additional_kwargs as Record<string, unknown>)?.[SIGNED_CONTEXT_KEY]).toEqual(
      signed.signedContext,
    );
  });

  it('keeps signed metadata private when parsing an assistant response for the chat client', () => {
    const provider = createProvider();
    const saved = {
      role: 'assistant',
      messageId: 'saved-assistant-message',
      createdAt: new Date('2026-11-19T00:00:00.000Z'),
      content: { content: 'Completed lookup' },
      toolCalls: [{ id: 'call-history', name: 'lookup', args: { query: 'one' } }],
      metadata: {
        additional_kwargs: {
          [SIGNED_CONTEXT_KEY]: {
            version: 1,
            ...signedScope,
            toolCalls: [{ id: 'call-history', originalId: 'call-history__thought__encoded' }],
          },
          public_extra: 'visible metadata',
        },
      },
    } as unknown as Model;

    const response = provider.parseResponseMessage(saved);

    expect(response.content.metadata.additional_kwargs).toEqual({ public_extra: 'visible metadata' });
  });
});
