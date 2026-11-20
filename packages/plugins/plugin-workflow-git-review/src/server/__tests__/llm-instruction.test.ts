// SPDX-License-Identifier: Apache-2.0

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatOpenAI } from '@langchain/openai';
import { LLMProvider } from '@nocobase/plugin-ai';
import type { Application } from '@nocobase/server';
import { describe, expect, it } from 'vitest';
import {
  configureProviderStructuredOutput,
  extractStructuredResult,
  formatProviderError,
  parseTextMessages,
} from '../llm-instruction';
import { REVIEW_SCHEMA } from '../review-result';

function createStubApp(): Application {
  return {
    environment: { renderJsonTemplate: (value: Record<string, unknown>) => value ?? {} },
  } as unknown as Application;
}

class StubProvider extends LLMProvider {
  constructor(model: unknown, modelOptions: Record<string, unknown> = { model: 'test-model' }) {
    super({ app: createStubApp(), serviceOptions: {} });
    this.modelOptions = modelOptions;
    this.chatModel = model;
  }

  createModel() {
    return this.chatModel;
  }
}

async function captureRequestBody(
  invoke: (captureFetch: typeof fetch) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null;
  const fakeFetch: typeof fetch = async (_input, init) => {
    captured = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    throw new Error('CAPTURED_REQUEST');
  };
  try {
    await invoke(fakeFetch);
  } catch (error) {
    if (captured) return captured;
    throw error;
  }
  throw new Error('Expected provider to issue an HTTP request');
}

describe('Git review LLM instruction helpers', () => {
  it('merges user text parts into a single non-empty HumanMessage and rejects non-text parts', () => {
    const messages = parseTextMessages([
      { role: 'system', message: 'System prompt' },
      {
        role: 'user',
        content: [
          { type: 'text', content: 'Additional review instructions:' },
          { type: 'text', content: '' },
          { type: 'text', content: 'Pinned diff:' },
          { type: 'text', content: '@@ -1 +1 @@\n-a\n+b' },
        ],
      },
    ]);

    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1].content).toBe('Additional review instructions:\n\nPinned diff:\n\n@@ -1 +1 @@\n-a\n+b');

    expect(() =>
      parseTextMessages([{ role: 'user', content: [{ type: 'image_url', content: 'https://example.invalid/a.png' }] }]),
    ).toThrow('Review LLM messages support text content only');
  });

  it('strips default text response_format and sends a valid strict JSON schema for OpenAI-compatible providers', async () => {
    const body = await captureRequestBody(async (fakeFetch) => {
      const provider = new StubProvider(
        new ChatOpenAI({
          apiKey: 'test-key',
          model: 'gpt-4o',
          maxRetries: 0,
          modelKwargs: { response_format: { type: 'text' } },
          configuration: { fetch: fakeFetch },
        }),
      );
      configureProviderStructuredOutput(provider, 'openai-completions');
      return provider.invoke({
        messages: [new SystemMessage('sys'), new HumanMessage('diff')],
        structuredOutput: { name: 'code_review', schema: REVIEW_SCHEMA, strict: true },
      });
    });

    const responseFormat = body.response_format as {
      type: string;
      json_schema: {
        name: string;
        strict: boolean;
        schema: {
          type: string;
          properties: { findings: { items: { properties: { line: Record<string, unknown> } } } };
        };
      };
    };
    expect(responseFormat.type).toBe('json_schema');
    expect(responseFormat.json_schema.name).toBe('code_review');
    expect(responseFormat.json_schema.strict).toBe(true);
    expect(responseFormat.json_schema.schema.type).toBe('object');
    expect(responseFormat.json_schema.schema.properties.findings.items.properties.line).not.toHaveProperty('minimum');
  });

  it('strips default text.format for OpenAI Responses API and sends valid json_schema format', async () => {
    const body = await captureRequestBody(async (fakeFetch) => {
      const provider = new StubProvider(
        new ChatOpenAI({
          apiKey: 'test-key',
          model: 'gpt-4o',
          maxRetries: 0,
          useResponsesApi: true,
          modelKwargs: { text: { format: { type: 'text' } } },
          configuration: { fetch: fakeFetch },
        }),
      );
      configureProviderStructuredOutput(provider, 'openai');
      return provider.invoke({
        messages: [new SystemMessage('sys'), new HumanMessage('diff')],
        structuredOutput: { name: 'code_review', schema: REVIEW_SCHEMA, strict: true },
      });
    });

    const text = body.text as { format: { type: string; name: string; strict: boolean; schema: { type: string } } };
    expect(text.format.type).toBe('json_schema');
    expect(text.format.name).toBe('code_review');
    expect(text.format.strict).toBe(true);
    expect(text.format.schema.type).toBe('object');
  });

  it('uses functionCalling with raw input_schema for Anthropic instead of throwing schema type errors', async () => {
    const body = await captureRequestBody(async (fakeFetch) => {
      const provider = new StubProvider(
        new ChatAnthropic({
          apiKey: 'test-key',
          model: 'claude-3-5-sonnet-latest',
          maxRetries: 0,
          clientOptions: { fetch: fakeFetch },
        }),
      );
      configureProviderStructuredOutput(provider, 'anthropic');
      return provider.invoke({
        messages: [new SystemMessage('sys'), new HumanMessage('diff')],
        structuredOutput: { name: 'code_review', schema: REVIEW_SCHEMA, strict: true },
      });
    });

    const tools = body.tools as Array<{ name: string; input_schema: { type: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('code_review');
    expect(tools[0].input_schema.type).toBe('object');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'code_review' });
  });

  it('uses functionCalling with raw parameters for DeepSeek chat completions', async () => {
    const body = await captureRequestBody(async (fakeFetch) => {
      const provider = new StubProvider(
        new ChatDeepSeek({
          apiKey: 'test-key',
          model: 'deepseek-chat',
          maxRetries: 0,
          configuration: { fetch: fakeFetch },
        }),
      );
      configureProviderStructuredOutput(provider, 'deepseek');
      return provider.invoke({
        messages: [new SystemMessage('sys'), new HumanMessage('diff')],
        structuredOutput: { name: 'code_review', schema: REVIEW_SCHEMA, strict: true },
      });
    });

    const tools = body.tools as Array<{ type: string; function: { name: string; parameters: { type: string } } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('code_review');
    expect(tools[0].function.parameters.type).toBe('object');
  });

  it('normalizes tool-call and fenced JSON responses so downstream synthesis receives text content', () => {
    const parsed = { verdict: 'no_findings', findings: [], coverage: { summary: 'Checked', limitations: [] } };
    const fromToolCall = extractStructuredResult({
      parsed,
      raw: { id: 'msg-1', content: [{ type: 'tool_use', name: 'code_review', input: parsed }] },
    });
    expect(fromToolCall.structuredContent).toEqual(parsed);
    expect(fromToolCall.content).toBe(JSON.stringify(parsed));

    const fromFencedText = extractStructuredResult({
      parsed: null,
      raw: { id: 'msg-2', content: `\`\`\`json\n${JSON.stringify(parsed)}\n\`\`\`` },
    });
    expect(fromFencedText.structuredContent).toEqual(parsed);
  });

  it('formats provider errors with status while redacting credentials', () => {
    const err = Object.assign(
      new Error('Authorization: Bearer secret-token-123 failed for https://user:pass@proxy.test with sk-1234567890'),
      { status: 400 },
    );
    const formatted = formatProviderError(err);
    expect(formatted).toContain('HTTP 400:');
    expect(formatted).not.toContain('secret-token-123');
    expect(formatted).not.toContain('user:pass');
    expect(formatted).not.toContain('sk-1234567890');
  });
});
