import { vi } from 'vitest';

vi.mock('@nocobase/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nocobase/utils')>();
  return { ...actual, serverRequest: vi.fn() };
});

import { serverRequest } from '@nocobase/utils';
import { redactSecrets, toSafeErrorMessage } from '../utils/redact';
import { assertSafePath, VaultClient, VaultError } from '../vault-client';

const mockedRequest = vi.mocked(serverRequest);

describe('VaultClient', () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it('builds KV v2 secret URLs', () => {
    const client = new VaultClient({
      address: 'https://vault.example.com:8200/',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    expect(client.secretUrl('apps/billing')).toBe('https://vault.example.com:8200/v1/secret/data/apps/billing');
  });

  it('builds KV v1 secret URLs', () => {
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 1,
      mount: 'kv',
    });
    expect(client.secretUrl('apps/billing')).toBe('https://vault.example.com:8200/v1/kv/apps/billing');
  });

  it('builds KV v2 metadata URLs for listing paths', () => {
    const client = new VaultClient({
      address: 'https://vault.example.com:8200/',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    expect(client.listUrl()).toBe('https://vault.example.com:8200/v1/secret/metadata');
    expect(client.listUrl('apps/billing')).toBe('https://vault.example.com:8200/v1/secret/metadata/apps/billing');
    expect(client.listUrl('apps/team name')).toBe('https://vault.example.com:8200/v1/secret/metadata/apps/team%20name');
  });

  it('builds KV v1 URLs for listing paths', () => {
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 1,
      mount: 'kv',
    });
    expect(client.listUrl('apps')).toBe('https://vault.example.com:8200/v1/kv/apps');
  });

  it('lists folders and secrets without exposing values', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { keys: ['billing/', 'shared-config'] } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.listPath('apps')).resolves.toEqual([
      { name: 'billing', path: 'apps/billing', isFolder: true },
      { name: 'shared-config', path: 'apps/shared-config', isFolder: false },
    ]);
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://vault.example.com:8200/v1/secret/metadata/apps',
        params: { list: 'true' },
      }),
    );
  });

  it('treats 404 on list as an empty path instead of an error', async () => {
    mockedRequest.mockRejectedValueOnce({
      message: 'Request failed with status code 404',
      response: { status: 404, data: { errors: [] } },
    });
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.listPath('empty/folder')).resolves.toEqual([]);
  });

  it('recursively lists the whole tree with listAllPaths', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: { data: { keys: ['apps/', 'shared-config'] } } } as never)
      .mockResolvedValueOnce({ data: { data: { keys: ['billing', 'crm'] } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.listAllPaths()).resolves.toEqual({
      entries: [
        { name: 'apps', path: 'apps', isFolder: true },
        { name: 'shared-config', path: 'shared-config', isFolder: false },
        { name: 'billing', path: 'apps/billing', isFolder: false },
        { name: 'crm', path: 'apps/crm', isFolder: false },
      ],
      truncated: false,
    });
  });

  it('stops listAllPaths at maxEntries and reports truncation', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { keys: ['a', 'b', 'c'] } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    const result = await client.listAllPaths('', { maxEntries: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('reports the listed path when Vault denies list permission', async () => {
    mockedRequest.mockRejectedValueOnce({
      message: 'Request failed with status code 403',
      response: { status: 403, data: { errors: ['permission denied'] } },
    });
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.listPath('apps')).rejects.toThrow(
      'Failed to list Vault path "apps": HTTP 403: permission denied',
    );
  });

  it('lists sorted keys for a selected secret', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { data: { password: 'secret', host: 'db' } } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.listSecretKeys('apps/billing')).resolves.toEqual(['host', 'password']);
  });

  it('rejects invalid addresses', () => {
    expect(() => new VaultClient({ address: 'ftp://vault.example.com', authMethod: 'token', token: 't' })).toThrow(
      VaultError,
    );
    expect(() => new VaultClient({ address: 'not a url', authMethod: 'token', token: 't' })).toThrow(VaultError);
  });

  it('reads a KV v2 secret with the configured token', async () => {
    mockedRequest.mockResolvedValueOnce({
      data: { data: { data: { password: 's3cr3t' } } },
    } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 'my-token',
      kvVersion: 2,
      mount: 'secret',
    });
    const value = await client.readSecret('apps/billing', 'password');
    expect(value).toBe('s3cr3t');
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://vault.example.com:8200/v1/secret/data/apps/billing',
        headers: expect.objectContaining({ 'X-Vault-Token': 'my-token' }),
      }),
    );
  });

  it('reads a KV v1 secret', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { password: 'v1-secret' } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 1,
      mount: 'kv',
    });
    await expect(client.readSecret('apps/billing', 'password')).resolves.toBe('v1-secret');
  });

  it('throws when the key is missing from the secret', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { data: { other: 'x' } } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.readSecret('apps/billing', 'password')).rejects.toThrow('Key "password" not found');
  });

  it('readSecretOrNull returns the value when present', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { data: { password: 'v' } } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.readSecretOrNull('apps/billing', 'password')).resolves.toBe('v');
  });

  it('readSecretOrNull returns null when the path does not exist', async () => {
    mockedRequest.mockRejectedValueOnce({ message: '404', response: { status: 404, data: { errors: [] } } });
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.readSecretOrNull('apps/missing', 'password')).resolves.toBeNull();
  });

  it('readSecretOrNull returns null when the key is missing', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { data: { other: 'x' } } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await expect(client.readSecretOrNull('apps/billing', 'password')).resolves.toBeNull();
  });

  it('logs in via AppRole and reuses the client token within the lease', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: { auth: { client_token: 'approle-token', lease_duration: 3600 } } } as never)
      .mockResolvedValueOnce({ data: { data: { data: { password: 'a' } } } } as never)
      .mockResolvedValueOnce({ data: { data: { data: { password: 'b' } } } } as never);

    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'approle',
      roleId: 'role',
      secretId: 'secret',
      kvVersion: 2,
      mount: 'secret',
    });

    await expect(client.readSecret('p', 'password')).resolves.toBe('a');
    await expect(client.readSecret('p', 'password')).resolves.toBe('b');

    // 1 login + 2 reads — no second login within the lease
    expect(mockedRequest).toHaveBeenCalledTimes(3);
    expect(mockedRequest.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: 'https://vault.example.com:8200/v1/auth/approle/login',
        data: { role_id: 'role', secret_id: 'secret' },
      }),
    );
    expect(mockedRequest.mock.calls[1][0]).toEqual(
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Vault-Token': 'approle-token' }) }),
    );
  });

  it('sends the namespace header when configured', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { data: { k: 'v' } } } } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      namespace: 'admin/team-a',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await client.readSecret('p', 'k');
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Vault-Namespace': 'admin/team-a' }) }),
    );
  });

  it('reports sealed vault from health check', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { initialized: true, sealed: true } } as never);
    const client = new VaultClient({ address: 'https://vault.example.com:8200', authMethod: 'token', token: 't' });
    await expect(client.healthCheck()).rejects.toThrow('Vault is sealed');
  });

  it('writes a KV v2 secret wrapped in a data envelope', async () => {
    mockedRequest.mockResolvedValueOnce({ data: {} } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await client.writeSecret('apps/billing', { password: 'new' });
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://vault.example.com:8200/v1/secret/data/apps/billing',
        data: { data: { password: 'new' } },
      }),
    );
  });

  it('writes a KV v1 secret without the data envelope', async () => {
    mockedRequest.mockResolvedValueOnce({ data: {} } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 1,
      mount: 'kv',
    });
    await client.writeSecret('apps/billing', { password: 'new' });
    expect(mockedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://vault.example.com:8200/v1/kv/apps/billing',
        data: { password: 'new' },
      }),
    );
  });

  it('setSecretKey merges the new key with existing keys', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: { data: { data: { host: 'db', password: 'old' } } } } as never)
      .mockResolvedValueOnce({ data: {} } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await client.setSecretKey('apps/billing', 'password', 'new');
    expect(mockedRequest.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        method: 'POST',
        data: { data: { host: 'db', password: 'new' } },
      }),
    );
  });

  it('setSecretKey creates the secret when the path does not exist yet', async () => {
    mockedRequest
      .mockRejectedValueOnce({ message: '404', response: { status: 404, data: { errors: [] } } })
      .mockResolvedValueOnce({ data: {} } as never);
    const client = new VaultClient({
      address: 'https://vault.example.com:8200',
      authMethod: 'token',
      token: 't',
      kvVersion: 2,
      mount: 'secret',
    });
    await client.setSecretKey('apps/new-app', 'apiKey', 'k');
    expect(mockedRequest.mock.calls[1][0]).toEqual(expect.objectContaining({ data: { data: { apiKey: 'k' } } }));
  });
});

describe('assertSafePath', () => {
  it('rejects traversal and absolute paths', () => {
    expect(() => assertSafePath('/abs')).toThrow(VaultError);
    expect(() => assertSafePath('a/../b')).toThrow(VaultError);
    expect(() => assertSafePath('')).toThrow(VaultError);
    expect(() => assertSafePath('apps/billing')).not.toThrow();
  });
});

describe('redact', () => {
  it('redacts vault tokens and URL credentials', () => {
    expect(redactSecrets('token hvs.abcdefghijklmnopqrstuvwxyz123456 leaked')).toBe('token *** leaked');
    expect(redactSecrets('https://user:pass@vault.example.com')).toBe('https://***:***@vault.example.com');
  });

  it('prefers vault error arrays in safe messages', () => {
    const message = toSafeErrorMessage({
      message: 'Request failed with status code 403',
      response: { status: 403, data: { errors: ['permission denied'] } },
    });
    expect(message).toBe('HTTP 403: permission denied');
  });
});
