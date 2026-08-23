/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import axios from 'axios';
import { createMappingFetch, stripGeminiThoughtSuffix, CustomLLMProvider } from '../llm-providers/custom-llm';

const CONTENT_PATH = 'choices.0.delta.content';

async function runMapping(streamBody: string, mapping: Record<string, string> = { content: CONTENT_PATH }) {
  const mockFetch = vi.fn(async () => {
    return new Response(streamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', mockFetch);
  const mappingFetch = createMappingFetch(mapping);
  if (!mappingFetch) throw new Error('mapping must include a content path');
  const res = await mappingFetch('https://api.example.com/v1/chat/completions', {
    headers: { accept: 'text/event-stream' },
  });
  return res.text();
}

describe('createMappingFetch SSE parser', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('handles CRLF, "data :" spacing, no-space "data:", comments, and whitespace-padded [DONE]', async () => {
    const body =
      ': keep-alive heartbeat\r\n' +
      'data : {"choices":[{"delta":{"content":"Hel"}}]}\r\n' +
      '\r\n' +
      'data:{"choices":[{"delta":{"content":"lo"}}]}\r\n' +
      '\r\n' +
      'data: [DONE]  \r\n' +
      '\r\n';
    const out = await runMapping(body);
    expect(out).toContain('"content":"Hel"');
    expect(out).toContain('"content":"lo"');
    expect(out).toContain('data: [DONE]');
    expect(out).not.toContain('keep-alive');
  });

  it('reassembles an event that is split across reader chunks', async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"Hel', 'lo"}}]}\n\n', 'data: [DONE]\n\n'];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const mockFetch = vi.fn(
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const mappingFetch = createMappingFetch({ content: CONTENT_PATH });
    if (!mappingFetch) throw new Error('mapping must include a content path');
    const res = await mappingFetch('https://api.example.com/v1/chat/completions', {
      headers: { accept: 'text/event-stream' },
    });
    const out = await res.text();
    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('data: [DONE]');
  });

  it('emits finish_reason-only chunks via the fallback branch', async () => {
    const out = await runMapping('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    expect(out).toContain('"finish_reason":"stop"');
  });

  it('drops non-JSON / foreign-format events instead of re-emitting raw data', async () => {
    const out = await runMapping('data: not-json-at-all\n\ndata: [DONE]\n\n');
    expect(out).toContain('data: [DONE]');
    expect(out).not.toContain('not-json-at-all');
  });
});

describe('stripGeminiThoughtSuffix', () => {
  it('strips the __thought__ suffix from tool-call ids', () => {
    expect(stripGeminiThoughtSuffix('call_abc__thought__BASE64==')).toBe('call_abc');
  });

  it('leaves normal ids intact', () => {
    expect(stripGeminiThoughtSuffix('call_normal')).toBe('call_normal');
  });

  it('handles undefined', () => {
    expect(stripGeminiThoughtSuffix(undefined)).toBeUndefined();
  });
});

describe('CustomLLMProvider.listModels', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeApp() {
    return {
      environment: { renderJsonTemplate: (o: Record<string, unknown>) => o },
      pm: { get: () => ({}) },
    } as any;
  }

  it('builds URL + Bearer header and maps ids via dataPath/idPath', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { result: { list: [{ name: 'm-a' }, { name: 'm-b' }] } },
    } as any);

    const provider = new CustomLLMProvider({
      app: makeApp(),
      serviceOptions: {
        baseURL: 'https://api.example.com',
        apiKey: 'sk-test',
        modelsConfig: JSON.stringify({
          path: 'custom/models',
          auth: 'bearer',
          dataPath: 'result.list',
          idPath: 'name',
          headers: { 'X-Tenant': 't1' },
        }),
      },
    });

    const result = await provider.listModels();
    expect(result.models).toEqual([{ id: 'm-a' }, { id: 'm-b' }]);
    expect(getSpy).toHaveBeenCalledTimes(1);
    const [url, config] = getSpy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.example.com/custom/models');
    expect(config.headers).toMatchObject({ Authorization: 'Bearer sk-test', 'X-Tenant': 't1' });
  });

  it('uses x-api-key header for auth=api-key', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { data: [{ id: 'gpt-4' }] },
    } as any);

    const provider = new CustomLLMProvider({
      app: makeApp(),
      serviceOptions: {
        baseURL: 'https://api.example.com',
        apiKey: 'sk-test',
        modelsConfig: JSON.stringify({ auth: 'api-key' }),
      },
    });

    const result = await provider.listModels();
    expect(result.models).toEqual([{ id: 'gpt-4' }]);
    const [, config] = getSpy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(config.headers['x-api-key']).toBe('sk-test');
    expect(config.headers.Authorization).toBeUndefined();
  });

  it('returns code/errMsg when baseURL is missing', async () => {
    const provider = new CustomLLMProvider({
      app: makeApp(),
      serviceOptions: { apiKey: 'sk-test', modelsConfig: JSON.stringify({}) },
    });
    const result = await provider.listModels();
    expect(result.code).toBe(400);
    expect(result.errMsg).toBeTruthy();
  });
});
