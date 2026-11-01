/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { APIClient, Application } from '@nocobase/client-v2';
import { setupClientSafeCache } from '../utils/clientSafeCache';
import { setupRequestDedupAndCache } from '../utils/requestDedupInterceptor';

function createStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function createClient() {
  const request = vi.fn().mockResolvedValue({ status: 200, data: { data: ['metadata'] } });
  const auth = { role: 'admin', token: 'current-token', setRole: vi.fn(), setToken: vi.fn() };
  const client = { request, auth, app: { getName: () => 'main' } } as unknown as APIClient;
  return { client, request, auth };
}

describe('V2 cluster metadata cache', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', createStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces metadata reads and invalidates the cache after a successful write', async () => {
    const { client, request } = createClient();
    setupRequestDedupAndCache(client);
    const config = { url: 'collections:listMeta', params: { dataSource: 'main' } };
    const [first, second] = await Promise.all([client.request(config), client.request(config)]);
    expect(first).toEqual(second);
    expect(request).toHaveBeenCalledTimes(1);
    await client.request(config);
    expect(request).toHaveBeenCalledTimes(1);
    await client.request({ url: 'collections:update', method: 'post' });
    await client.request(config);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not cache normal reads or failed metadata requests', async () => {
    const { client, request } = createClient();
    setupRequestDedupAndCache(client);
    await client.request({ url: 'users:list' });
    await client.request({ url: 'users:list' });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockRejectedValueOnce(new Error('network error'));
    await expect(client.request({ url: 'collections:listMeta' })).rejects.toThrow('network error');
    await client.request({ url: 'collections:listMeta' });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('keeps responses separate when the role changes', async () => {
    const { client, request, auth } = createClient();
    setupRequestDedupAndCache(client);
    await client.request({ url: 'collections:listMeta' });
    auth.role = 'viewer';
    await client.request({ url: 'collections:listMeta' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('isolates datasource headers, clients, and tokens sharing the same suffix', async () => {
    const first = createClient();
    const second = createClient();
    first.auth.token = 'prefix-a:shared-token-suffix';
    second.auth.token = 'prefix-a:shared-token-suffix';
    setupRequestDedupAndCache(first.client);
    setupRequestDedupAndCache(second.client);
    const config = { url: 'collections:listMeta', headers: { 'x-data-source': 'main' } };
    await first.client.request(config);
    await first.client.request({ ...config, headers: { 'x-data-source': 'remote' } });
    await second.client.request(config);
    first.auth.token = 'prefix-b:shared-token-suffix';
    await first.client.request(config);
    expect(first.request).toHaveBeenCalledTimes(3);
    expect(second.request).toHaveBeenCalledTimes(1);
    expect(Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)).join()).not.toContain(
      'token',
    );
  });

  it('does not reuse pending metadata after auth invalidation or successful writes', async () => {
    const { client, request } = createClient();
    const listeners = new Map<string, () => void>();
    setupClientSafeCache(client, {
      addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    } as unknown as Application['eventBus']);
    setupRequestDedupAndCache(client);
    let finish: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = client.request({ url: 'collections:listMeta' });
    listeners.get('auth:tokenChanged')?.();
    await client.request({ url: 'collections:listMeta' });
    finish({ status: 200, data: { data: ['stale'] } });
    await pending;
    const response = await client.request({ url: 'collections:listMeta' });
    expect(response.data.data).toEqual(['metadata']);
    expect(request).toHaveBeenCalledTimes(2);
    await client.request({ url: 'collections:update', method: 'post' });
    await client.request({ url: 'collections:listMeta' });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('keeps complete Axios responses in memory without persisting credentials', async () => {
    const { client, request } = createClient();
    const response = {
      status: 200,
      data: { data: ['metadata'] },
      config: { headers: { Authorization: 'private-token' } },
    };
    const circularResponse = { ...response, request: {} as { response?: unknown } };
    circularResponse.request.response = circularResponse;
    request.mockResolvedValue(circularResponse);
    setupRequestDedupAndCache(client);
    await client.request({ url: 'collections:listMeta' });
    expect(await client.request({ url: 'collections:listMeta' })).toBe(circularResponse);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps cancellation per caller and does not match unrelated URL substrings', async () => {
    const { client, request } = createClient();
    setupRequestDedupAndCache(client);
    const config = { url: 'collections:listMeta', signal: new AbortController().signal };
    await Promise.all([client.request(config), client.request(config)]);
    await client.request({ url: 'custom:run?name=collections:listMeta' });
    await client.request({ url: 'custom:run?name=collections:listMeta' });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('clears cached metadata on auth events and tolerates disabled browser storage', () => {
    const { client, auth } = createClient();
    const originalSetToken = auth.setToken;
    const listeners = new Map<string, () => void>();
    const eventBus = { addEventListener: (name: string, callback: () => void) => listeners.set(name, callback) };
    setupClientSafeCache(client, eventBus as unknown as Application['eventBus']);
    setupClientSafeCache(client, eventBus as unknown as Application['eventBus']);
    sessionStorage.setItem('nb_cache:old', 'cached');
    sessionStorage.setItem('other-setting', 'keep');
    listeners.get('auth:tokenChanged')?.();
    expect(sessionStorage.getItem('nb_cache:old')).toBeNull();
    expect(sessionStorage.getItem('other-setting')).toBe('keep');
    vi.stubGlobal('sessionStorage', {
      get length() {
        throw new Error('storage blocked');
      },
    });
    expect(() => client.auth.setToken('renewed')).not.toThrow();
    expect(originalSetToken).toHaveBeenCalledWith('renewed');
  });
});
