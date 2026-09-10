/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyComplexity } from '../utils/complexity-classifier';
import { resolveModelReference } from '../utils/resolve-service';

vi.mock('../utils/resolve-service', () => ({
  resolveModelReference: vi.fn(),
}));

const mockResolveModelReference = vi.mocked(resolveModelReference);

function serviceModel(values: Record<string, unknown>): Model {
  return {
    get: (key: string) => values[key],
  } as Model;
}

function createContext(invoke: (messages: unknown[], params: Record<string, unknown>) => unknown): Context {
  const model = { invoke: vi.fn(invoke) };
  class TestProvider {
    createModel() {
      return model;
    }
  }
  return {
    app: {
      pm: {
        get: vi.fn().mockReturnValue({
          aiManager: {
            llmProviders: new Map([['test-provider', { provider: TestProvider }]]),
          },
        }),
      },
    },
  } as unknown as Context;
}

const LONG_TEXT = 'This is a sufficiently long request body that exceeds the minimum classifier text length.';

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveModelReference.mockResolvedValue({
    service: serviceModel({ name: 'classifier-svc', provider: 'test-provider', enabled: true, options: {} }),
    modelId: 'classifier-model',
  });
});

describe('classifyComplexity', () => {
  it('returns true when the model answers {"complex": true}', async () => {
    const ctx = createContext(() => ({ content: '{"complex": true}' }));
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(true);
  });

  it('returns false when the model answers {"complex": false}', async () => {
    const ctx = createContext(() => ({ content: '{"complex": false}' }));
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(false);
  });

  it('parses a JSON string response', async () => {
    const ctx = createContext(() => '{"complex": true}');
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(true);
  });

  it('parses an array content block response', async () => {
    const ctx = createContext(() => ({ content: [{ type: 'text', text: '{"complex": true}' }] }));
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(true);
  });

  it('falls back to a regex match when the output is not strict JSON', async () => {
    const ctx = createContext(() => ({ content: 'Sure, here you go: {"complex": true}' }));
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(true);
  });

  it('returns false for an unparseable response', async () => {
    const ctx = createContext(() => ({ content: 'I cannot classify this.' }));
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(false);
  });

  it('returns false when the provider invoke throws', async () => {
    const ctx = createContext(() => {
      throw new Error('provider down');
    });
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(false);
  });

  it('returns false when the invoke rejects', async () => {
    const ctx = createContext(() => Promise.reject(new Error('timeout')));
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(false);
  });

  it('returns false for text below the minimum length', async () => {
    const ctx = createContext(() => ({ content: '{"complex": true}' }));
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', 'Hello')).resolves.toBe(false);
    expect(mockResolveModelReference).not.toHaveBeenCalled();
  });

  it('returns false for an empty reference', async () => {
    const ctx = createContext(() => ({ content: '{"complex": true}' }));
    await expect(classifyComplexity(ctx, '   ', LONG_TEXT)).resolves.toBe(false);
    expect(mockResolveModelReference).not.toHaveBeenCalled();
  });

  it('returns false when the reference cannot be resolved', async () => {
    mockResolveModelReference.mockResolvedValue(null);
    const ctx = createContext(() => ({ content: '{"complex": true}' }));
    await expect(classifyComplexity(ctx, 'missing-svc/model', LONG_TEXT)).resolves.toBe(false);
  });

  it('returns false when the classifier service is disabled', async () => {
    mockResolveModelReference.mockResolvedValue({
      service: serviceModel({ name: 'classifier-svc', provider: 'test-provider', enabled: false, options: {} }),
      modelId: 'classifier-model',
    });
    const ctx = createContext(() => ({ content: '{"complex": true}' }));
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(false);
  });

  it('returns false when plugin-ai is not loaded', async () => {
    const ctx = {
      app: { pm: { get: vi.fn().mockReturnValue(undefined) } },
    } as unknown as Context;
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(false);
  });

  it('returns false when the provider is not registered', async () => {
    const ctx = {
      app: {
        pm: {
          get: vi.fn().mockReturnValue({ aiManager: { llmProviders: new Map() } }),
        },
      },
    } as unknown as Context;
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(false);
  });

  it('returns false when the created model has no invoke method', async () => {
    class NoInvokeProvider {
      createModel() {
        return {};
      }
    }
    const ctx = {
      app: {
        pm: {
          get: vi.fn().mockReturnValue({
            aiManager: { llmProviders: new Map([['test-provider', { provider: NoInvokeProvider }]]) },
          }),
        },
      },
    } as unknown as Context;
    await expect(classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT)).resolves.toBe(false);
  });

  it('passes the classifier prompt and a temperature-0 model option', async () => {
    const invoke = vi.fn(() => ({ content: '{"complex": false}' }));
    const ctx = createContext(invoke);
    await classifyComplexity(ctx, 'classifier-svc/classifier-model', LONG_TEXT);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [messages, params] = invoke.mock.calls[0];
    expect(messages[0][0]).toBe('system');
    expect(messages[1][0]).toBe('human');
    expect(messages[1][1]).toBe(LONG_TEXT);
    expect(params.signal).toBeInstanceOf(AbortSignal);
  });
});
