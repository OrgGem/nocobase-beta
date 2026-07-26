import { vi } from 'vitest';
import { createExtStorageActions } from '../actions/ext-storage';
import type { IStorageAdapter } from '../adapters/types';

describe('External Storage Manager list action', () => {
  it('does not apply offset a second time to an adapter page', async () => {
    const directoryValues: Record<string, string | number | boolean> = {
      id: 1,
      name: 'SFTP documents',
      rootPath: '/',
      enabled: true,
    };
    const directory = {
      get(key: string) {
        return directoryValues[key];
      },
    };
    const list = vi.fn().mockResolvedValue({
      entries: [
        { name: 'c.txt', path: '/c.txt', type: 'file', size: 3, modifiedAt: 0 },
        { name: 'd.txt', path: '/d.txt', type: 'file', size: 4, modifiedAt: 0 },
      ],
      total: 4,
      hasMore: false,
    });
    const adapter = { list } as unknown as IStorageAdapter;
    const actions = createExtStorageActions(async () => adapter);
    const ctx = {
      action: {
        params: {
          directoryId: 1,
          path: '/',
          offset: 2,
          limit: 2,
        },
      },
      request: { query: {}, body: {} },
      state: {},
      app: {},
      can: () => ({ params: { filter: {} } }),
      db: {
        getRepository: () => ({
          findOne: async () => directory,
        }),
      },
    } as {
      action: { params: Record<string, unknown> };
      request: { query: Record<string, unknown>; body: Record<string, unknown> };
      state: Record<string, unknown>;
      app: Record<string, unknown>;
      can: () => { params: { filter: Record<string, unknown> } };
      db: { getRepository: () => { findOne: () => Promise<typeof directory> } };
      body?: unknown;
    };

    await actions.list(ctx);

    expect(list).toHaveBeenCalledWith('/', expect.objectContaining({ offset: 2, limit: 2 }));
    expect(ctx.body).toEqual({
      data: [
        { name: 'c.txt', path: '/c.txt', type: 'file', size: 3, modifiedAt: 0 },
        { name: 'd.txt', path: '/d.txt', type: 'file', size: 4, modifiedAt: 0 },
      ],
      meta: expect.objectContaining({ offset: 2, limit: 2, total: 4, hasMore: false }),
    });
  });
});
