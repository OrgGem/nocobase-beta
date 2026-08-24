/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { vi } from 'vitest';
import { createExtStorageActions } from '../actions/ext-storage';
import { signDownloadPayload } from '../url-signing';
import type { IStorageAdapter } from '../adapters/types';

function makeCtx(params: Record<string, unknown>) {
  const thrown: Array<{ status: number; message: string }> = [];
  const ctx = {
    action: { params },
    request: { query: {}, body: {}, headers: {} as Record<string, string> },
    state: {},
    app: {},
    can: () => null,
    db: { getRepository: () => ({ findOne: vi.fn() }) },
    logger: { error: vi.fn(), warn: vi.fn() },
    get: () => undefined,
    set: () => {},
    throw: (status: number, message: string) => {
      thrown.push({ status, message });
      const error = new Error(message) as Error & { status: number };
      error.status = status;
      throw error;
    },
  };
  return { ctx, thrown };
}

describe('extStorage:download signed URL directory binding', () => {
  it('rejects a signed URL when directoryId and filterByTk differ', async () => {
    const adapter = { getStream: vi.fn() } as unknown as IStorageAdapter;
    const actions = createExtStorageActions(async () => adapter);

    const directoryId = '1';
    const expires = Date.now() + 60_000;
    const payload = { directoryId, path: '/a.txt', mode: 'inline' as const, expires };
    const signature = signDownloadPayload(payload);

    const { ctx, thrown } = makeCtx({
      directoryId,
      filterByTk: '2',
      path: '/a.txt',
      mode: 'inline',
      expires: String(expires),
      signature,
    });

    await expect(actions.download(ctx)).rejects.toMatchObject({ status: 403 });
    expect(thrown[0].message).toBe('Invalid signature');
    expect(adapter.getStream).not.toHaveBeenCalled();
  });

  it('allows a signed URL when directoryId and filterByTk match', async () => {
    const directory = { get: (k: string) => ({ id: '1', rootPath: '/', enabled: true, name: 'docs' })[k] };
    const stream = 'fake-stream';
    const adapter = {
      getStream: vi.fn().mockResolvedValue({ stream, contentType: 'text/plain', size: 1 }),
      stat: vi.fn().mockResolvedValue({ type: 'file', size: 1 }),
    } as unknown as IStorageAdapter;
    const actions = createExtStorageActions(async () => adapter);

    const directoryId = '1';
    const expires = Date.now() + 60_000;
    const payload = { directoryId, path: '/a.txt', mode: 'inline' as const, expires };
    const signature = signDownloadPayload(payload);

    const { ctx } = makeCtx({
      directoryId,
      filterByTk: directoryId,
      path: '/a.txt',
      mode: 'inline',
      expires: String(expires),
      signature,
    });
    ctx.db = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(directory) }),
    };

    await actions.download(ctx);
    expect(adapter.getStream).toHaveBeenCalled();
  });
});
