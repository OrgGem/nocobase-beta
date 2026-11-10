/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import type { Model } from '@nocobase/database';
import type { Context } from '@nocobase/actions';
import type { AttachmentModel } from '@nocobase/plugin-file-manager';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@nocobase/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nocobase/utils')>();
  return { ...original, serverRequest: serverRequestMock };
});

import { CustomLLMProvider } from '../llm-providers/custom-llm';

const SESSION_ID = 'session-compatibility-test';
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/go/v1';
const originalWhitelist = process.env.SERVER_REQUEST_WHITELIST;

function createApp(plugins: Record<string, unknown> = {}) {
  return {
    environment: { renderJsonTemplate: (value: Record<string, unknown>) => value },
    getVersion: () => '2.2.40',
    pm: { get: (name: string) => plugins[name] },
  } as unknown as Application;
}

describe('CustomLLMProvider host compatibility', () => {
  beforeEach(() => {
    process.env.SERVER_REQUEST_WHITELIST = 'opencode.ai,api.openai.com,api.example.com';
  });

  afterEach(() => {
    if (originalWhitelist === undefined) {
      delete process.env.SERVER_REQUEST_WHITELIST;
    } else {
      process.env.SERVER_REQUEST_WHITELIST = originalWhitelist;
    }
    serverRequestMock.mockReset();
    vi.restoreAllMocks();
  });

  it('merges NocoBase session headers with configured model headers', () => {
    const provider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: {
        apiKey: 'test-key',
        baseURL: OPENCODE_BASE_URL,
        requestConfig: JSON.stringify({ extraHeaders: { 'X-Tenant': 'tenant-1' } }),
      },
      modelOptions: { model: 'glm-5' },
      requestContext: { sessionId: SESSION_ID },
    });

    expect(provider.chatModel.clientConfig.defaultHeaders).toEqual({
      'User-Agent': 'NocoBase/2.2.40',
      'x-opencode-session': SESSION_ID,
      'X-Tenant': 'tenant-1',
    });
  });

  it('adds NocoBase session headers to model discovery without overriding configured headers', async () => {
    serverRequestMock.mockResolvedValue({ data: { data: [{ id: 'glm-5' }] } });
    const provider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: {
        apiKey: 'test-key',
        baseURL: OPENCODE_BASE_URL,
        modelsConfig: JSON.stringify({ headers: { 'X-Tenant': 'tenant-1' } }),
      },
      requestContext: { sessionId: SESSION_ID },
    });

    await expect(provider.listModels()).resolves.toMatchObject({ models: [{ id: 'glm-5' }] });

    expect(serverRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: `${OPENCODE_BASE_URL}/models`,
        timeout: 30_000,
        headers: expect.objectContaining({
          'User-Agent': 'NocoBase/2.2.40',
          'x-opencode-session': SESSION_ID,
          'X-Tenant': 'tenant-1',
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it.each(['default', 'off', 'high'] as const)(
    'does not send OpenAI reasoning fields to a generic endpoint for mode %s unless opted in',
    (mode) => {
      const provider = new CustomLLMProvider({
        app: createApp(),
        serviceOptions: { apiKey: 'test-key', baseURL: 'https://api.example.com/v1' },
        modelOptions: { model: 'gpt-5', _reasoning: { mode } },
      });

      const params = provider.chatModel.invocationParams({});
      expect(params.reasoning_effort).toBeUndefined();
      expect(params.reasoning).toBeUndefined();
    },
  );

  it.each([
    ['gpt-5.1', 'off', { reasoning_effort: 'none' }],
    ['gpt-5', 'high', { reasoning_effort: 'high' }],
    ['gpt-5.4-pro', 'high', { reasoning: { effort: 'high' } }],
  ] as const)('maps OpenAI reasoning mode %s into the model request', (model, mode, expectedParams) => {
    const provider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: { apiKey: 'test-key', baseURL: 'https://api.openai.com/v1' },
      modelOptions: { model, _reasoning: { mode } },
    });

    const params = provider.chatModel.invocationParams({});
    expect(params).toMatchObject(expectedParams);
    if (model === 'gpt-5.4-pro') {
      expect(params).not.toHaveProperty('reasoning_effort');
    }
  });

  it('enables reasoning fields for compatible endpoints only when explicitly configured', () => {
    const provider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: {
        apiKey: 'test-key',
        baseURL: 'https://api.example.com/v1',
        requestConfig: JSON.stringify({ useReasoningEffort: true }),
      },
      modelOptions: { model: 'gpt-5', _reasoning: { mode: 'high' } },
    });

    expect(provider.chatModel.invocationParams({})).toMatchObject({ reasoning_effort: 'high' });
  });

  it('lets explicit request config take priority over host reasoning defaults', () => {
    const provider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: {
        apiKey: 'test-key',
        baseURL: 'https://api.openai.com/v1',
        requestConfig: JSON.stringify({ modelKwargs: { reasoning_effort: 'low' } }),
      },
      modelOptions: { model: 'gpt-5', _reasoning: { mode: 'high' } },
    });

    expect(provider.chatModel.invocationParams({})).toMatchObject({ reasoning_effort: 'low' });
  });

  it('preserves explicit extraBody reasoning parameters for compatible model aliases', () => {
    const provider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: {
        apiKey: 'test-key',
        baseURL: 'https://api.example.com/v1',
        requestConfig: JSON.stringify({ useReasoningEffort: true, extraBody: { reasoning_effort: 'medium' } }),
      },
      modelOptions: { model: 'reasoning-model', _reasoning: { mode: 'high' } },
    });

    expect(provider.chatModel.invocationParams({})).toMatchObject({ reasoning_effort: 'medium' });
  });

  it('passes the conversation cache key only to OpenAI and respects an explicit model key', () => {
    const openAIProvider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: { apiKey: 'test-key', baseURL: 'https://api.openai.com/v1' },
      modelOptions: { model: 'gpt-4o-mini' },
      requestContext: { sessionId: SESSION_ID },
    });
    const compatibleProvider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: {
        apiKey: 'test-key',
        baseURL: 'https://api.example.com/v1',
        requestConfig: JSON.stringify({ useSessionPromptCache: true }),
      },
      modelOptions: { model: 'compatible-model' },
      requestContext: { sessionId: SESSION_ID },
    });
    const genericDefaultProvider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: { apiKey: 'test-key', baseURL: 'https://api.example.com/v1' },
      modelOptions: { model: 'gpt-5' },
      requestContext: { sessionId: SESSION_ID },
    });
    const fixedKeyProvider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: { apiKey: 'test-key', baseURL: 'https://api.openai.com/v1' },
      modelOptions: { model: 'gpt-4o-mini', promptCacheKey: 'fixed-key' },
      requestContext: { sessionId: SESSION_ID },
    });
    const configuredKeyProvider = new CustomLLMProvider({
      app: createApp(),
      serviceOptions: {
        apiKey: 'test-key',
        baseURL: 'https://api.openai.com/v1',
        requestConfig: JSON.stringify({ modelKwargs: { prompt_cache_key: 'request-key' } }),
      },
      modelOptions: { model: 'gpt-4o-mini' },
      requestContext: { sessionId: SESSION_ID },
    });

    expect(openAIProvider.chatModel.invocationParams({})).toMatchObject({ prompt_cache_key: SESSION_ID });
    expect(compatibleProvider.chatModel.invocationParams({})).toMatchObject({ prompt_cache_key: SESSION_ID });
    expect(genericDefaultProvider.chatModel.invocationParams({}).prompt_cache_key).toBeUndefined();
    expect(fixedKeyProvider.chatModel.invocationParams({})).toMatchObject({ prompt_cache_key: 'fixed-key' });
    expect(configuredKeyProvider.chatModel.invocationParams({})).toMatchObject({ prompt_cache_key: 'request-key' });
  });

  it('preserves the saved assistant message creation timestamp', () => {
    const createdAt = new Date('2026-11-10T00:00:00.000Z');
    const message = {
      content: { content: 'answer' },
      messageId: 'message-1',
      role: 'assistant',
      createdAt,
    } as unknown as Model;
    const provider = new CustomLLMProvider({ app: createApp() });

    expect(provider.parseResponseMessage(message)).toMatchObject({
      key: 'message-1',
      createdAt,
      role: 'assistant',
      content: { content: 'answer', messageId: 'message-1' },
    });
  });

  it.each([
    {
      label: 'local storage',
      attachment: { filename: 'local.txt', mimetype: 'text/plain', storageId: 1, source: { dataSourceKey: 'main' } },
    },
    {
      label: 'private storage',
      attachment: { filename: 'private.txt', mimetype: 'text/plain', storageId: 2, source: { dataSourceKey: 'main' } },
    },
    {
      label: 'external data source',
      attachment: { filename: 'external.txt', mimetype: 'text/plain', source: { dataSourceKey: 'remote' } },
    },
  ])('reads $label attachments through File Manager and forwards request headers', async ({ attachment }) => {
    const getFileStream = vi.fn(async () => ({ stream: Readable.from([Buffer.from('attachment text')]) }));
    const provider = new CustomLLMProvider({
      app: createApp({ 'file-manager': { getFileStream } }),
    });
    const ctx = {
      get: (name: string) => (name === 'referer' ? 'https://app.example.com' : 'TestAgent/1.0'),
      state: {},
    } as unknown as Context;

    const result = await provider.parseAttachment(ctx, attachment as unknown as AttachmentModel);

    expect(getFileStream).toHaveBeenCalledWith(attachment, {
      requestOptions: { headers: { Referer: 'https://app.example.com', 'User-Agent': 'TestAgent/1.0' } },
    });
    expect(result).toMatchObject({
      placement: 'contentBlocks',
      content: { type: 'text', text: expect.stringContaining('attachment text') },
    });
  });

  it('passes File Manager bytes to DocPixie text extraction for PDF attachments', async () => {
    const document = Buffer.from('%PDF-1.7 mock document');
    const extractTextFromBuffer = vi.fn(async () => 'extracted document text');
    const getFileStream = vi.fn(async () => ({ stream: Readable.from([document]) }));
    const provider = new CustomLLMProvider({
      app: createApp({
        'file-manager': { getFileStream },
        docpixie: { service: { extractTextFromBuffer } },
      }),
    });

    const result = await provider.parseAttachment(
      { state: {} } as unknown as Context,
      { filename: 'document.pdf', mimetype: 'application/pdf', storageId: 3 } as unknown as AttachmentModel,
    );

    expect(extractTextFromBuffer).toHaveBeenCalledWith(document, 'document.pdf');
    expect(result).toMatchObject({
      placement: 'contentBlocks',
      content: { type: 'text', text: expect.stringContaining('extracted document text') },
    });
  });
});
