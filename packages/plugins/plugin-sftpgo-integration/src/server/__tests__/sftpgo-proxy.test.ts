// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import type PluginSftpgoIntegrationServer from '../plugin';
import { SftpgoInvalidApiKeyScopeError, type SftpgoClient } from '../sftpgo-client';
import { createSftpgoProxyActions } from '../actions/sftpgo-proxy';
import { maskApiKey } from '../utils/mask-api-key';

function createContext(params: Record<string, unknown>, authMethod: 'admin' | 'apikey' = 'admin'): Context {
  const connection = {
    get: vi.fn((field: string) => {
      if (field === 'enabled') return true;
      if (field === 'id') return 1;
      if (field === 'authMethod') return authMethod;
      return undefined;
    }),
  };
  const repository = {
    findOne: vi.fn().mockResolvedValue(connection),
  };

  return {
    action: { params },
    db: { getRepository: vi.fn(() => repository) },
    can: vi.fn(() => ({})),
    acl: { resolveActionParams: vi.fn().mockResolvedValue({ parsedParams: undefined }) },
    t: (value: string) => value,
    throw: (status: number, message: string) => {
      throw Object.assign(new Error(`${status}: ${message}`), { status });
    },
  } as unknown as Context;
}

function createPlugin(client: Partial<SftpgoClient>): PluginSftpgoIntegrationServer {
  return {
    getClient: vi.fn().mockResolvedValue(client),
    attachMaskedApiKeySecrets: vi.fn(async (_connectionId: number, apiKeys: unknown[]) => apiKeys),
    saveApiKeySecret: vi.fn().mockResolvedValue(undefined),
    deleteApiKeySecret: vi.fn().mockResolvedValue(undefined),
  } as unknown as PluginSftpgoIntegrationServer;
}

const next: Next = vi.fn();

describe('SFTPGo proxy response body', () => {
  it('returns the upstream list directly so NocoBase wraps it only once', async () => {
    const users = [{ username: 'alice' }];
    const client = { listResources: vi.fn().mockResolvedValue(users) };
    const ctx = createContext({ connectionId: 1, limit: 100 });

    await createSftpgoProxyActions(createPlugin(client), 'users').list(ctx, next);

    expect(ctx.body).toEqual(users);
    expect(ctx.body).not.toEqual({ data: users });
  });

  it('returns the created API key response directly', async () => {
    const created = { message: 'API key created', id: 'key-id', key: 'one-time-secret' };
    const client = {
      createResource: vi.fn().mockResolvedValue(created),
      listResources: vi.fn(),
    };
    const plugin = createPlugin(client);
    const ctx = createContext({
      connectionId: 1,
      values: { name: 'automation', scope: 1 },
    });

    await createSftpgoProxyActions(plugin, 'apikeys').create(ctx, next);

    expect(ctx.body).toEqual(created);
    expect(client.createResource).toHaveBeenCalledWith('apikeys', { name: 'automation', scope: 1 });
    expect(plugin.saveApiKeySecret).toHaveBeenCalledWith(1, 'key-id', 'automation', 'one-time-secret');
    expect(client.listResources).not.toHaveBeenCalled();
  });

  it('returns the one-time API key and a warning when no identifier is available', async () => {
    const created = { message: 'API key created', key: 'one-time-secret' };
    const client = {
      createResource: vi.fn().mockResolvedValue(created),
      listResources: vi.fn(),
    };
    const plugin = createPlugin(client);
    const ctx = createContext({ connectionId: 1, values: { name: 'automation', scope: 1 } });

    await createSftpgoProxyActions(plugin, 'apikeys').create(ctx, next);

    expect(ctx.body).toEqual({ ...created, keyStorageWarning: true });
    expect(plugin.saveApiKeySecret).not.toHaveBeenCalled();
    expect(client.listResources).not.toHaveBeenCalled();
  });

  it('keeps the one-time API key visible if local secret storage fails', async () => {
    const created = { message: 'API key created', id: 'key-id', key: 'one-time-secret' };
    const client = { createResource: vi.fn().mockResolvedValue(created), listResources: vi.fn() };
    const plugin = createPlugin(client);
    vi.mocked(plugin.saveApiKeySecret).mockRejectedValue(new Error('local database unavailable'));
    const ctx = createContext({ connectionId: 1, values: { name: 'automation', scope: 1 } });

    await createSftpgoProxyActions(plugin, 'apikeys').create(ctx, next);

    expect(ctx.body).toEqual({ ...created, keyStorageWarning: true });
    expect(client.listResources).not.toHaveBeenCalled();
  });
});

describe('SFTPGo API key management proxy access', () => {
  it.each(['list', 'get', 'create', 'update', 'destroy'] as const)(
    'rejects %s before creating an SFTPGo client for an API-key-authenticated connection',
    async (actionName) => {
      const plugin = createPlugin({
        listResources: vi.fn(),
        getResource: vi.fn(),
        createResource: vi.fn(),
        updateResource: vi.fn(),
        deleteResource: vi.fn(),
      });
      const params = {
        connectionId: 1,
        filterByTk: 'key-id',
        values: { name: 'automation', scope: 1 },
      };
      const ctx = createContext(params, 'apikey');
      const actions = createSftpgoProxyActions(plugin, 'apikeys');

      await expect(actions[actionName](ctx, next)).rejects.toThrow(
        '400: API key management requires an admin-authenticated connection',
      );
      expect(plugin.getClient).not.toHaveBeenCalled();
    },
  );

  it('returns a client validation error as HTTP 400 for an invalid API key scope', async () => {
    const plugin = createPlugin({
      createResource: vi.fn().mockRejectedValue(new SftpgoInvalidApiKeyScopeError()),
    });
    const ctx = createContext({ connectionId: 1, values: { name: 'automation', scope: 3 } });
    const actions = createSftpgoProxyActions(plugin, 'apikeys');

    await expect(actions.create(ctx, next)).rejects.toThrow('400: Invalid API key scope');
  });
});

describe('API key masking', () => {
  it('masks 70 percent of the middle of an API key', () => {
    const secret = '12345678901234567890';
    const masked = maskApiKey(secret);

    expect(masked).toBe('123**************890');
    expect(masked).toHaveLength(secret.length);
  });

  it('fully masks very short values', () => {
    expect(maskApiKey('abc')).toBe('***');
  });
});
