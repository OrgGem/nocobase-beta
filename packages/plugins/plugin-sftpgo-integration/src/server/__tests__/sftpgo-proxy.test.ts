import type { Context, Next } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import type PluginSftpgoIntegrationServer from '../plugin';
import type { SftpgoClient } from '../sftpgo-client';
import { createSftpgoProxyActions } from '../actions/sftpgo-proxy';
import { maskApiKey } from '../utils/mask-api-key';

function createContext(params: Record<string, unknown>): Context {
  const connection = {
    get: vi.fn((field: string) => {
      if (field === 'enabled') return true;
      if (field === 'id') return 1;
      return undefined;
    }),
  };
  const repository = {
    findOne: vi.fn().mockResolvedValue(connection),
  };

  return {
    action: { params },
    db: { getRepository: vi.fn(() => repository) },
    throw: (status: number, message: string) => {
      throw new Error(`${status}: ${message}`);
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
    const created = { message: 'API key created', key: 'one-time-secret' };
    const client = {
      createResource: vi.fn().mockResolvedValue(created),
      listResources: vi.fn().mockResolvedValue([{ id: 'key-id', name: 'automation' }]),
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
