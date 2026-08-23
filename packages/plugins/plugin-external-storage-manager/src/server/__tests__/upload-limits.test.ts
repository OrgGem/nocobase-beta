import { vi } from 'vitest';
import { createExtStorageActions, getMaxUploadBytes, getMaxUploadFiles } from '../actions/ext-storage';
import type { IStorageAdapter } from '../adapters/types';

function createDirectory(id = 1) {
  const directoryValues: Record<string, string | number | boolean> = {
    id,
    name: 'docs',
    rootPath: '/',
    enabled: true,
  };
  return {
    get(key: string) {
      return directoryValues[key];
    },
  };
}

function createContext(overrides: Record<string, unknown> = {}) {
  const directory = createDirectory();
  const thrown: Array<{ status: number; message: string }> = [];
  const putStream = vi.fn().mockResolvedValue(undefined);
  const adapter = { putStream } as unknown as IStorageAdapter;
  const actions = createExtStorageActions(async () => adapter);
  const ctx = {
    action: {
      params: {
        directoryId: 1,
        path: '/docs',
        ...(overrides.actionParams as Record<string, unknown>),
      },
    },
    request: {
      query: {},
      body: {},
      headers: {} as Record<string, unknown>,
      is: () => false,
      ...(overrides.request as Record<string, unknown>),
    },
    req: {},
    state: {},
    app: {},
    can: () => ({ params: { filter: {} } }),
    db: {
      getRepository: () => ({
        findOne: async () => directory,
      }),
    },
    logger: { error: vi.fn(), warn: vi.fn() },
    throw: (status: number, message: string) => {
      thrown.push({ status, message });
      const error = new Error(message) as Error & { status: number };
      error.status = status;
      throw error;
    },
    ...(overrides.ctx as Record<string, unknown>),
  };
  return { actions, ctx, thrown, putStream };
}

describe('extStorage:upload size limits', () => {
  it('rejects multipart uploads whose declared content-length exceeds the limit with 413', async () => {
    const { actions, ctx, thrown, putStream } = createContext({
      request: {
        query: {},
        body: {},
        headers: { 'content-length': String(300 * 1024 * 1024) },
        is: () => true,
      },
    });

    await expect(actions.upload(ctx)).rejects.toMatchObject({ status: 413 });
    expect(thrown[0].message).toContain('Upload too large');
    expect(putStream).not.toHaveBeenCalled();
  });

  it('rejects raw stream uploads whose declared content-length exceeds the limit with 413', async () => {
    const { actions, ctx, thrown, putStream } = createContext({
      request: {
        query: {},
        body: {},
        headers: { 'content-length': String(300 * 1024 * 1024) },
        is: () => false,
      },
    });

    await expect(actions.upload(ctx)).rejects.toMatchObject({ status: 413 });
    expect(thrown[0].message).toContain('Upload too large');
    expect(putStream).not.toHaveBeenCalled();
  });

  it('allows uploads within the limit', async () => {
    const { actions, ctx, putStream } = createContext({
      request: {
        query: {},
        body: {},
        headers: { 'content-length': String(1024), 'content-type': 'text/plain' },
        is: () => false,
      },
    });

    await actions.upload(ctx);
    expect(putStream).toHaveBeenCalledTimes(1);
  });

  describe('env parsing', () => {
    it('uses defaults when env vars are missing or invalid', () => {
      expect(getMaxUploadBytes({})).toBe(200 * 1024 * 1024);
      expect(getMaxUploadFiles({})).toBe(50);
      expect(getMaxUploadBytes({ EXT_STORAGE_MAX_UPLOAD_MB: 'abc' })).toBe(200 * 1024 * 1024);
      expect(getMaxUploadFiles({ EXT_STORAGE_MAX_UPLOAD_FILES: '-1' })).toBe(50);
    });

    it('parses valid env values', () => {
      expect(getMaxUploadBytes({ EXT_STORAGE_MAX_UPLOAD_MB: '10' })).toBe(10 * 1024 * 1024);
      expect(getMaxUploadFiles({ EXT_STORAGE_MAX_UPLOAD_FILES: '5' })).toBe(5);
    });
  });
});
