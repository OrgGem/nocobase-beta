import { vi } from 'vitest';

vi.mock('@nocobase/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nocobase/utils')>();
  return { ...actual, serverRequest: vi.fn() };
});

import { serverRequest } from '@nocobase/utils';
import { SecretCache } from '../secret-cache';
import { SyncService } from '../sync-service';

const mockedRequest = vi.mocked(serverRequest);

function makeModel(values: Record<string, unknown>): any {
  return {
    get: (key: string) => values[key],
    previous: () => undefined,
    set: vi.fn(),
    changed: () => false,
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function makeConnection(_values: Record<string, unknown>): any {
  return { get: (key: string) => _values[key], set: vi.fn() };
}

function makePlugin(envVars: Record<string, string>, hasEnvRepo = true): any {
  const envRepo = hasEnvRepo
    ? {
        collection: { existsInDb: vi.fn().mockResolvedValue(true) },
        findOne: vi
          .fn()
          .mockImplementation(({ filterByTk }) => (envVars[filterByTk] !== undefined ? { name: filterByTk } : null)),
        update: vi.fn().mockResolvedValue(undefined),
      }
    : null;
  return {
    app: { environment: { getVariables: () => envVars } },
    db: {
      getRepository: (name: string) => (name === 'environmentVariables' ? envRepo : null),
    },
  } as any;
}

describe('SyncService.processMapping', () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it('pulls vault value into the cache when envVariable is empty', async () => {
    mockedRequest.mockResolvedValueOnce({ data: { data: { data: { password: 'v1' } } } } as never);
    const plugin = makePlugin({});
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'DB_PASSWORD',
      secretPath: 'apps/billing',
      secretKey: 'password',
      direction: 'pull',
      envVariable: null,
    });
    const client: any = { readSecret: vi.fn() };
    client.readSecret.mockResolvedValueOnce('v1');

    await svc.processMapping(mapping, client as any);

    expect(client.readSecret).toHaveBeenCalledWith('apps/billing', 'password');
    expect(cache.get('DB_PASSWORD')).toBe('v1');
  });

  it('writes to environmentVariables only when vault value differs from env', async () => {
    const plugin = makePlugin({ TEST: 'old' });
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'TEST',
      secretPath: 'apps/billing',
      secretKey: 'password',
      direction: 'pull',
      envVariable: 'TEST',
    });
    const client: any = { readSecret: vi.fn() };
    client.readSecret.mockResolvedValueOnce('new');

    await svc.processMapping(mapping, client as any);

    expect(plugin.db.getRepository('environmentVariables').update).toHaveBeenCalledWith({
      filterByTk: 'TEST',
      values: { value: 'new' },
    });
    expect(cache.get('TEST')).toBe('new');
  });

  it('skips environmentVariables update when env already matches vault', async () => {
    const plugin = makePlugin({ TEST: 'same' });
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'TEST',
      secretPath: 'apps/billing',
      secretKey: 'password',
      direction: 'pull',
      envVariable: 'TEST',
    });
    const client: any = { readSecret: vi.fn() };
    client.readSecret.mockResolvedValueOnce('same');

    await svc.processMapping(mapping, client as any);

    expect(plugin.db.getRepository('environmentVariables').update).not.toHaveBeenCalled();
  });

  it('throws when envVariable was deleted but mapping still references it (pull)', async () => {
    const plugin = makePlugin({}); // env row missing
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'TEST',
      secretPath: 'apps/billing',
      secretKey: 'password',
      direction: 'pull',
      envVariable: 'TEST',
    });
    const client: any = { readSecret: vi.fn() };
    client.readSecret.mockResolvedValueOnce('v');

    await expect(svc.processMapping(mapping, client as any)).rejects.toThrow(
      'Environment variable "TEST" no longer exists',
    );
    // cache is still updated — vault read succeeded, $vault.TEST keeps working
    expect(cache.get('TEST')).toBe('v');
  });

  it('pushes env value to vault only when values differ', async () => {
    const plugin = makePlugin({ TEST: 'new' });
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'TEST',
      secretPath: 'apps/billing',
      secretKey: 'password',
      direction: 'push',
      envVariable: 'TEST',
    });
    const client: any = { readSecretOrNull: vi.fn(), setSecretKey: vi.fn() };
    client.readSecretOrNull.mockResolvedValueOnce('old');

    await svc.processMapping(mapping, client as any);

    expect(client.setSecretKey).toHaveBeenCalledWith('apps/billing', 'password', 'new');
    expect(cache.get('TEST')).toBe('new');
  });

  it('push creates the secret when the path does not exist yet', async () => {
    const plugin = makePlugin({ TEST: 'new' });
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'TEST',
      secretPath: 'apps/new-app',
      secretKey: 'password',
      direction: 'push',
      envVariable: 'TEST',
    });
    const client: any = { readSecretOrNull: vi.fn(), setSecretKey: vi.fn() };
    client.readSecretOrNull.mockResolvedValueOnce(null);

    await svc.processMapping(mapping, client as any);

    expect(client.setSecretKey).toHaveBeenCalledWith('apps/new-app', 'password', 'new');
    expect(cache.get('TEST')).toBe('new');
  });

  it('skips vault write when env value already matches (push)', async () => {
    const plugin = makePlugin({ TEST: 'same' });
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'TEST',
      secretPath: 'apps/billing',
      secretKey: 'password',
      direction: 'push',
      envVariable: 'TEST',
    });
    const client: any = { readSecretOrNull: vi.fn(), setSecretKey: vi.fn() };
    client.readSecretOrNull.mockResolvedValueOnce('same');

    await svc.processMapping(mapping, client as any);

    expect(client.setSecretKey).not.toHaveBeenCalled();
    expect(cache.get('TEST')).toBe('same');
  });

  it('throws when push direction is missing envVariable', async () => {
    const plugin = makePlugin({});
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'TEST',
      secretPath: 'apps/billing',
      secretKey: 'password',
      direction: 'push',
      envVariable: null,
    });
    const client: any = { readSecret: vi.fn() };

    await expect(svc.processMapping(mapping, client as any)).rejects.toThrow('envVariable is required');
  });

  it('throws when push env value is not set at runtime', async () => {
    const plugin = makePlugin({}); // env row exists but no value in runtime vars
    const cache = new SecretCache();
    const svc = new SyncService(plugin, cache);
    const mapping = makeModel({
      variableKey: 'TEST',
      secretPath: 'apps/billing',
      secretKey: 'password',
      direction: 'push',
      envVariable: 'TEST',
    });
    const client: any = { readSecret: vi.fn() };

    await expect(svc.processMapping(mapping, client as any)).rejects.toThrow('is not set');
  });
});
