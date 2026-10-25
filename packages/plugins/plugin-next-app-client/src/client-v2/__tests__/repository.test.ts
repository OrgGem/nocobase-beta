/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { APIClient } from '@nocobase/client-v2';
import { describe, expect, it, vi } from 'vitest';
import { HubRouteRepository } from '../HubRouteRepository';
import type { HubRoute } from '../routes';

function deferred() {
  let complete!: (value: { data: { data: HubRoute[] } }) => void;
  const promise = new Promise<{ data: { data: HubRoute[] } }>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

describe('isolated Hub route cache', () => {
  it('deduplicates initialization and always filters the selected app', async () => {
    const response = deferred();
    const request = vi.fn(() => response.promise);
    const repository = new HubRouteRepository({ request } as unknown as Pick<APIClient, 'request'>, 'sales');
    const a = repository.ensureAccessibleLoaded();
    expect(repository.ensureAccessibleLoaded()).toBe(a);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ filter: { appPath: 'sales' } }) }),
    );
    response.resolve({ data: { data: [{ id: '90071992547409933', schemaUid: 'page' }] } });
    await a;
    expect(repository.getRouteById('90071992547409933')?.schemaUid).toBe('page');
  });
  it('ignores an old user or role response after cache invalidation', async () => {
    const old = deferred();
    const current = deferred();
    const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const repository = new HubRouteRepository({ request } as unknown as Pick<APIClient, 'request'>, 'sales');
    const previous = repository.ensureAccessibleLoaded();
    repository.clear();
    const latest = repository.ensureAccessibleLoaded();
    current.resolve({ data: { data: [{ schemaUid: 'new-user' }] } });
    await latest;
    old.resolve({ data: { data: [{ schemaUid: 'old-user' }] } });
    await previous;
    expect(repository.listAccessible()).toEqual([{ schemaUid: 'new-user' }]);
  });
  it('clears old routes when a refresh is denied and permits an explicit retry', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: [{ schemaUid: 'old' }] } })
      .mockRejectedValueOnce(new Error('403'))
      .mockResolvedValueOnce({ data: { data: [] } });
    const repository = new HubRouteRepository({ request } as unknown as Pick<APIClient, 'request'>, 'sales');
    await repository.ensureAccessibleLoaded();
    await expect(repository.refreshAccessible()).rejects.toThrow('403');
    expect(repository.listAccessible()).toEqual([]);
    expect(repository.isAccessibleLoaded()).toBe(false);
    await repository.ensureAccessibleLoaded();
    expect(repository.isAccessibleLoaded()).toBe(true);
  });
});
