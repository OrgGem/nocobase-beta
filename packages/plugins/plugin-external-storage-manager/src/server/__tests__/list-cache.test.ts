import { vi } from 'vitest';
import { createExtStorageActions } from '../actions/ext-storage';
import { TtlCache } from '../list-cache';
import type { IStorageAdapter, FileEntry } from '../adapters/types';

function createListContext(list: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  const directoryValues: Record<string, string | number | boolean> = {
    id: 1,
    name: 'docs',
    rootPath: '/root',
    enabled: true,
  };
  const directory = {
    get(key: string) {
      return directoryValues[key];
    },
  };
  const adapter = { list } as unknown as IStorageAdapter;
  const actions = createExtStorageActions(async () => adapter);
  const ctx = {
    action: {
      params: {
        directoryId: 1,
        path: '/',
        ...(overrides.actionParams as Record<string, unknown>),
      },
    },
    request: { query: {}, body: {} },
    state: {},
    app: {},
    can: () => ({ params: { filter: {} } }),
    db: { getRepository: () => ({ findOne: async () => directory }) },
    logger: { error: vi.fn(), warn: vi.fn() },
    throw: (status: number, message: string) => {
      const error = new Error(message) as Error & { status: number };
      error.status = status;
      throw error;
    },
  };
  return { actions, ctx };
}

const ENTRIES: FileEntry[] = [
  { name: 'a.txt', path: '/a.txt', type: 'file', size: 1, modifiedAt: 0 },
  { name: 'b.txt', path: '/b.txt', type: 'file', size: 2, modifiedAt: 0 },
  { name: 'sub', path: '/sub', type: 'directory', size: 0, modifiedAt: 0 },
];

describe('list search TTL cache', () => {
  it('serves identical full-scan searches from cache without calling the adapter again', async () => {
    const list = vi.fn().mockResolvedValue([...ENTRIES]);
    const { actions, ctx } = createListContext(list, { actionParams: { path: '/', search: 'a' } });

    await actions.list(ctx);
    const firstMeta = (ctx.body as any).meta;
    expect(firstMeta.cached).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);

    await actions.list(ctx);
    expect(list).toHaveBeenCalledTimes(1);
    const secondMeta = (ctx.body as any).meta;
    expect(secondMeta.cached).toBe(true);
    expect((ctx.body as any).data).toHaveLength(1);
    expect(secondMeta.total).toEqual(1);
  });

  it('does not cache paginated ListResult responses', async () => {
    const list = vi.fn().mockResolvedValue({
      entries: ENTRIES.slice(0, 2),
      total: 2,
      hasMore: false,
    });
    const { actions, ctx } = createListContext(list);

    await actions.list(ctx);
    await actions.list(ctx);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('distinguishes cache entries by path, search, and type', async () => {
    const list = vi.fn().mockResolvedValue([...ENTRIES]);
    const { actions, ctx } = createListContext(list);

    (ctx.action.params as Record<string, unknown>).search = 'a';
    await actions.list(ctx);
    (ctx.action.params as Record<string, unknown>).search = 'b';
    await actions.list(ctx);
    (ctx.action.params as Record<string, unknown>).search = 'a';
    (ctx.action.params as Record<string, unknown>).type = 'file';
    await actions.list(ctx);

    expect(list).toHaveBeenCalledTimes(3);
  });

  it('expires entries after the TTL and re-fetches', async () => {
    vi.useFakeTimers();
    try {
      const list = vi.fn().mockResolvedValue([...ENTRIES]);
      const cache = new TtlCache<FileEntry[]>({ ttlMs: 1000, maxEntries: 10 });
      const adapter = { list } as unknown as IStorageAdapter;
      const actions = createExtStorageActions(async () => adapter, { listCache: cache });
      const directory = { get: (k: string) => ({ id: 1, name: 'docs', rootPath: '/root', enabled: true }[k]) };
      const ctx: any = {
        action: { params: { directoryId: 1, path: '/', search: 'a' } },
        request: { query: {}, body: {} },
        state: {},
        app: {},
        can: () => ({ params: { filter: {} } }),
        db: { getRepository: () => ({ findOne: async () => directory }) },
        logger: { error: vi.fn() },
        throw: () => {},
      };

      await actions.list(ctx);
      await actions.list(ctx);
      expect(list).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1500);
      await actions.list(ctx);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates a directory cache after mutations', async () => {
    const list = vi.fn().mockResolvedValue([...ENTRIES]);
    const putStream = vi.fn().mockResolvedValue(undefined);
    const adapter = { list, putStream } as unknown as IStorageAdapter;
    const actions = createExtStorageActions(async () => adapter);
    const directory = { get: (k: string) => ({ id: 1, name: 'docs', rootPath: '/root', enabled: true }[k]) };
    const makeCtx = (params: Record<string, unknown>): any => ({
      action: { params: { directoryId: 1, ...params } },
      request: { query: {}, body: {}, headers: {} },
      req: {},
      state: {},
      app: {},
      can: () => ({ params: { filter: {} } }),
      db: { getRepository: () => ({ findOne: async () => directory }) },
      logger: { error: vi.fn() },
      throw: () => {},
    });

    const listCtx = makeCtx({ path: '/', search: 'a' });
    await actions.list(listCtx);
    expect(list).toHaveBeenCalledTimes(1);

    // Mutation through a different action instance of the same closure
    const uploadCtx = makeCtx({ path: '/sub' });
    uploadCtx.request.is = () => false;
    await actions.upload(uploadCtx);

    await actions.list(listCtx);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('TtlCache evicts oldest entries beyond maxEntries', () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    cache.set('k3', 'v3');
    expect(cache.size).toEqual(2);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toEqual('v2');
    expect(cache.get('k3')).toEqual('v3');
  });
});
