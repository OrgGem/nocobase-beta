// SPDX-License-Identifier: Apache-2.0

import { vi } from 'vitest';
import { createExtStorageActions } from '../actions/ext-storage';
import type { IStorageAdapter } from '../adapters/types';

describe('extStorage:delete mapped root protection', () => {
  it('rejects recursive deletion of the mapped directory root before resolving an adapter', async () => {
    const directory = {
      get(key: string) {
        return { id: 1, rootPath: '/', enabled: true }[key];
      },
    };
    const getAdapter = vi.fn<() => Promise<IStorageAdapter>>();
    const thrown: Array<{ status: number; message: string }> = [];
    const actions = createExtStorageActions(getAdapter);
    const ctx = {
      action: { params: { directoryId: 1, path: '/', type: 'directory' } },
      state: {},
      app: {},
      t: (key: string) => key,
      can: () => ({ params: { filter: {} } }),
      db: { getRepository: () => ({ findOne: vi.fn().mockResolvedValue(directory) }) },
      throw(status: number, message: string) {
        thrown.push({ status, message });
        const error = new Error(message) as Error & { status: number };
        error.status = status;
        throw error;
      },
    };

    await expect(actions.delete(ctx)).rejects.toMatchObject({ status: 400 });
    expect(thrown).toEqual([{ status: 400, message: 'Cannot delete the mapped directory root' }]);
    expect(getAdapter).not.toHaveBeenCalled();
  });
});
