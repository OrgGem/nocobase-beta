// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockedServerRequest } = vi.hoisted(() => ({ mockedServerRequest: vi.fn() }));

vi.mock('@nocobase/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nocobase/utils')>();
  return { ...actual, serverRequest: mockedServerRequest };
});

import { SftpgoClient } from '../sftpgo-client';

afterEach(() => {
  vi.resetAllMocks();
});

describe('SftpgoClient.createResource', () => {
  it('returns the API key identifier from SFTPGo response headers', async () => {
    mockedServerRequest.mockResolvedValue({
      data: { key: 'one-time-secret' },
      headers: { 'x-object-id': 'key-id-42' },
    });
    const client = new SftpgoClient({ baseUrl: 'https://sftp.example.com', authMethod: 'apikey', apiKey: 'admin-key' });

    await expect(client.createResource('apikeys', { name: 'automation', scope: 1 })).resolves.toEqual({
      key: 'one-time-secret',
      id: 'key-id-42',
    });
    expect(mockedServerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://sftp.example.com/api/v2/apikeys',
        data: { name: 'automation', scope: 1, user: '' },
      }),
    );
  });

  it('does not add an API key identifier to other resource responses', async () => {
    mockedServerRequest.mockResolvedValue({
      data: { username: 'alice' },
      headers: { 'x-object-id': 'user-id' },
    });
    const client = new SftpgoClient({ baseUrl: 'https://sftp.example.com', authMethod: 'apikey', apiKey: 'admin-key' });

    await expect(client.createResource('users', { username: 'alice' })).resolves.toEqual({ username: 'alice' });
  });

  it.each([
    { scope: 1, admin: 'admin-one', user: 'alice', expectedUser: '' },
    { scope: 2, admin: 'admin-one', user: 'alice', expectedUser: 'alice' },
  ])('normalizes scope $scope bindings on API key create', async ({ scope, admin, user, expectedUser }) => {
    mockedServerRequest.mockResolvedValue({ data: { message: 'created' }, headers: { 'x-object-id': 'key-id' } });
    const client = new SftpgoClient({
      baseUrl: 'https://sftp.example.com',
      authMethod: 'apikey',
      apiKey: 'admin-key',
    });

    await client.createResource('apikeys', { name: 'automation', scope, admin, user });

    expect(mockedServerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        data: { name: 'automation', scope, admin: scope === 1 ? admin : '', user: expectedUser },
      }),
    );
  });

  it('rejects an invalid API key scope before issuing an upstream request', async () => {
    const client = new SftpgoClient({
      baseUrl: 'https://sftp.example.com',
      authMethod: 'apikey',
      apiKey: 'admin-key',
    });

    await expect(client.createResource('apikeys', { name: 'automation', scope: 3 })).rejects.toThrow(
      'Invalid API key scope',
    );
    expect(mockedServerRequest).not.toHaveBeenCalled();
  });
});

describe('SftpgoClient.updateResource API key bindings', () => {
  const client = () =>
    new SftpgoClient({ baseUrl: 'https://sftp.example.com', authMethod: 'apikey', apiKey: 'admin-key' });

  it.each([
    {
      direction: 'user to admin',
      current: { id: 'key-id', scope: 2, user: 'alice', admin: '' },
      patch: { scope: 1, admin: 'admin-one' },
      expected: { id: 'key-id', scope: 1, user: '', admin: 'admin-one' },
    },
    {
      direction: 'admin to user',
      current: { id: 'key-id', scope: 1, admin: 'admin-one', user: '' },
      patch: { scope: 2, user: 'alice' },
      expected: { id: 'key-id', scope: 2, admin: '', user: 'alice' },
    },
  ])('clears the old binding when changing API key scope from $direction', async ({ current, patch, expected }) => {
    mockedServerRequest
      .mockResolvedValueOnce({ data: current, headers: {} })
      .mockResolvedValueOnce({ data: expected, headers: {} });

    await client().updateResource('apikeys', 'key-id', patch);

    expect(mockedServerRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'PUT', data: expected }));
  });

  it('preserves an existing binding when the patch changes only other fields', async () => {
    const current = { id: 'key-id', scope: 2, user: 'alice', admin: '', description: 'before' };
    const expected = { ...current, description: 'after' };
    mockedServerRequest
      .mockResolvedValueOnce({ data: current, headers: {} })
      .mockResolvedValueOnce({ data: expected, headers: {} });

    await client().updateResource('apikeys', 'key-id', { description: 'after' });

    expect(mockedServerRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'PUT', data: expected }));
  });
});

describe('SftpgoClient redirect safety', () => {
  it('disables redirects for the admin token request and every authenticated API request', async () => {
    const accessToken = 'synthetic-access-token';
    mockedServerRequest
      .mockResolvedValueOnce({
        data: { access_token: accessToken, expires_at: new Date(Date.now() + 120_000).toISOString() },
        headers: {},
      })
      .mockResolvedValue({ data: { username: 'alice' }, headers: {} });
    const client = new SftpgoClient({
      baseUrl: 'https://sftp.example.com',
      authMethod: 'admin',
      username: 'synthetic-admin',
      password: 'synthetic-password',
    });

    await client.healthCheck();
    await client.verifyAuth();
    await client.listResources('users');
    await client.getResource('users', 'alice');
    await client.createResource('users', { username: 'bob' });
    await client.updateResource('users', 'alice', { username: 'alice-updated' });
    await client.deleteResource('users', 'alice');

    const requests = mockedServerRequest.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(9);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://sftp.example.com/api/v2/token',
      maxRedirects: 0,
    });
    expect(requests[0].headers?.Authorization).toMatch(/^Basic /);
    for (const request of requests) {
      expect(request.maxRedirects).toBe(0);
    }
    for (const request of requests.slice(1)) {
      expect(request.headers?.Authorization).toBe(`Bearer ${accessToken}`);
    }
  });

  it('disables redirects on API-key requests while retaining the API-key header', async () => {
    mockedServerRequest.mockResolvedValue({ data: { status: 'ok' }, headers: {} });
    const client = new SftpgoClient({
      baseUrl: 'https://sftp.example.com',
      authMethod: 'apikey',
      apiKey: 'synthetic-api-key',
      username: 'synthetic-user',
    });

    await client.healthCheck();

    expect(mockedServerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://sftp.example.com/api/v2/status',
        maxRedirects: 0,
        headers: { 'X-SFTPGO-API-KEY': 'synthetic-api-key.synthetic-user' },
      }),
    );
  });

  it('does not expose redirect response bodies or locations in client errors', async () => {
    const syntheticSecret = 'synthetic-redirect-secret';
    const syntheticLocation = 'https://redirect-target.invalid/private';
    const redirectError = Object.assign(new Error(`Request failed with status code 302: ${syntheticSecret}`), {
      response: {
        status: 302,
        data: { message: `Credentials sent to ${syntheticLocation}: ${syntheticSecret}` },
        headers: { location: syntheticLocation },
      },
    });
    mockedServerRequest.mockRejectedValue(redirectError);
    const client = new SftpgoClient({
      baseUrl: 'https://sftp.example.com',
      authMethod: 'apikey',
      apiKey: 'synthetic-api-key',
    });

    let message = '';
    try {
      await client.listResources('users');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('Failed to list users: HTTP 302');
    expect(message).not.toContain(syntheticSecret);
    expect(message).not.toContain(syntheticLocation);
  });
});
