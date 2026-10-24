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
