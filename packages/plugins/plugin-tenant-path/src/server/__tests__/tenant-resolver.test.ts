import { describe, expect, it, vi } from 'vitest';
import { TenantResolver } from '../tenant-resolver';

interface FakeRow {
  get(key: string): unknown;
}

function makeRow(values: Record<string, unknown>): FakeRow {
  return {
    get: (key: string) => values[key],
  };
}

function makeDb(rows: Array<Record<string, unknown>>) {
  return {
    getRepository: vi.fn(() => ({
      find: vi.fn(async () => rows.map(makeRow)),
    })),
  } as never;
}

describe('TenantResolver', () => {
  const originalPublicPath = process.env.APP_PUBLIC_PATH;

  const restore = () => {
    if (originalPublicPath === undefined) {
      delete process.env.APP_PUBLIC_PATH;
    } else {
      process.env.APP_PUBLIC_PATH = originalPublicPath;
    }
  };

  it('resolves a tenant by first URL segment and defaults appName to pathPrefix', async () => {
    process.env.APP_PUBLIC_PATH = '/';
    const resolver = new TenantResolver(makeDb([{ id: 1, pathPrefix: 'acme', appName: '', enabled: true }]));
    const tenant = await resolver.resolveFromPath('/acme/admin/list');
    expect(tenant).toEqual({ id: 1, pathPrefix: 'acme', appName: 'acme' });
    restore();
  });

  it('strips APP_PUBLIC_PATH before matching the tenant segment', async () => {
    process.env.APP_PUBLIC_PATH = '/nb';
    const resolver = new TenantResolver(makeDb([{ id: 2, pathPrefix: 'beta', appName: 'beta_app', enabled: true }]));
    const tenant = await resolver.resolveFromPath('/nb/beta/admin');
    expect(tenant?.appName).toBe('beta_app');
    restore();
  });

  it('returns null for an unknown segment', async () => {
    process.env.APP_PUBLIC_PATH = '/';
    const resolver = new TenantResolver(makeDb([{ id: 1, pathPrefix: 'acme', appName: 'acme', enabled: true }]));
    expect(await resolver.resolveFromPath('/other/admin')).toBeNull();
    restore();
  });

  it('resolvePrefix returns the matched segment or null for env fallback', async () => {
    process.env.APP_PUBLIC_PATH = '/';
    const resolver = new TenantResolver(makeDb([{ id: 1, pathPrefix: 'acme', appName: 'acme', enabled: true }]));
    expect(await resolver.resolvePrefix({ url: '/acme/admin' })).toBe('acme');
    expect(await resolver.resolvePrefix({ url: '/v/admin' })).toBeNull();
    restore();
  });

  it('returns null when the repository has no enabled rows', async () => {
    process.env.APP_PUBLIC_PATH = '/';
    const resolver = new TenantResolver(makeDb([]));
    expect(await resolver.resolveFromPath('/off/admin')).toBeNull();
    restore();
  });

  it('reloads mapping after invalidate', async () => {
    process.env.APP_PUBLIC_PATH = '/';
    let rows: Array<Record<string, unknown>> = [];
    const db = {
      getRepository: vi.fn(() => ({
        find: vi.fn(async () => rows.map(makeRow)),
      })),
    } as never;
    const resolver = new TenantResolver(db);
    expect(await resolver.resolveFromPath('/acme/admin')).toBeNull();
    rows = [{ id: 9, pathPrefix: 'acme', appName: 'acme', enabled: true }];
    resolver.invalidate();
    const tenant = await resolver.resolveFromPath('/acme/admin');
    expect(tenant?.pathPrefix).toBe('acme');
    restore();
  });
});
