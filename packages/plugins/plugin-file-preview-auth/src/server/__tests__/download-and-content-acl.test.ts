// SPDX-License-Identifier: Apache-2.0

import { ACL } from '@nocobase/acl';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginFilePreviewAuthServer } from '../plugin';

function createHttpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function createPluginHarness(overrides: Record<string, unknown> = {}) {
  const actionsMap: Record<string, (ctx: any, next: () => Promise<void>) => Promise<void>> = {};
  const strategies: Record<string, { resolve: (ctx: any, item: any) => Promise<string> }> = {};
  const cacheStore = new Map<string, unknown>();
  const cache = {
    get: vi.fn(async (key: string) => cacheStore.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    }),
  };

  const acl = new ACL();
  const plugin = Object.create(PluginFilePreviewAuthServer.prototype) as any;
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const defaultDb = {
    collections: new Map(),
    getCollection: vi.fn((name: string) => {
      if (name === 'attachments' || name === 'aiFiles') {
        return { name, options: { template: 'file' }, fields: new Map(), model: { primaryKeyAttribute: 'id' } };
      }
      if (name === 'users') {
        return { name: 'users', options: {}, fields: new Map(), model: { primaryKeyAttribute: 'id' } };
      }
      return undefined;
    }),
    getRepository: vi.fn(() => ({ findOne: vi.fn(async () => null) })),
  };

  const fileManager = {
    storagesCache: new Map([
      [
        1,
        {
          id: 1,
          name: 's3-private',
          type: 's3-private',
          options: {
            bucket: 'private-bucket',
            accessKeyId: 'AKIA_SUPER_SECRET',
            secretAccessKey: 'SECRET_KEY_MUST_NOT_LEAK',
          },
        },
      ],
    ]),
    getFileStream: vi.fn(),
  };

  const pm = {
    get: vi.fn((name: string) => {
      if (name === '@nocobase/plugin-file-manager' || name === 'file-manager') return fileManager;
      if (name === 'ai' || name === '@nocobase/plugin-ai') {
        return {
          workContextHandler: {
            registerStrategy: (type: string, strategy: any) => {
              strategies[type] = strategy;
            },
          },
        };
      }
      return null;
    }),
  };

  Object.defineProperties(plugin, {
    app: {
      value: {
        acl,
        resourcer: {
          define: ({ actions }: any) => {
            Object.assign(actionsMap, actions);
          },
        },
      },
      configurable: true,
    },
    db: { value: defaultDb, configurable: true, writable: true },
    pm: { value: pm, configurable: true, writable: true },
    log: { value: log, configurable: true, writable: true },
    cache: { value: cache, configurable: true, writable: true },
  });

  Object.assign(plugin, overrides);
  plugin.registerDownloadApi();
  plugin.registerAIWorkContext();

  return { plugin, actionsMap, strategies, cache, cacheStore, acl, db: plugin.db, fileManager, log };
}

function createCtx(overrides: Record<string, unknown> = {}) {
  return {
    db: undefined as any,
    state: {
      currentUser: { id: 10, roles: ['member'] },
      currentRoles: ['member'],
      currentRole: 'member',
    },
    action: { params: {} },
    request: { query: {}, body: {}, is: () => false },
    headers: {},
    set: vi.fn(),
    attachment: vi.fn(),
    throw: (status: number, message: string) => {
      throw createHttpError(status, message);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('filePreviewAuth security & ACL boundaries', () => {
  it('blocks virtual attachment bypass when id is missing from DB but storageId and filename are supplied', async () => {
    const { actionsMap, db, fileManager } = createPluginHarness();
    const ctx = createCtx({
      db,
      request: {
        query: { id: '0', storageId: '1', filename: 'private/payroll.pdf' },
        body: {},
        is: () => false,
      },
    });

    await expect(actionsMap.download(ctx, async () => {})).rejects.toMatchObject({ status: 404 });
    expect(fileManager.getFileStream).not.toHaveBeenCalled();
  });

  it('rejects non-file collections like users with 400 in download', async () => {
    const usersFindOne = vi.fn(async () => ({ id: 1, filename: 'secret.pdf', storageId: 1 }));
    const { actionsMap, db, fileManager } = createPluginHarness();
    db.getRepository = vi.fn((name: string) => ({
      findOne: name === 'users' ? usersFindOne : vi.fn(async () => null),
    }));

    const ctx = createCtx({
      db,
      request: {
        query: { id: '1', collection: 'users' },
        body: {},
        is: () => false,
      },
    });

    await expect(actionsMap.download(ctx, async () => {})).rejects.toMatchObject({ status: 400 });
    expect(usersFindOne).not.toHaveBeenCalled();
    expect(fileManager.getFileStream).not.toHaveBeenCalled();
  });

  it('does not write preview_error.log or log storage secrets when download streaming fails', async () => {
    const errorLogPath = path.join(process.cwd(), 'preview_error.log');
    const existedBefore = fs.existsSync(errorLogPath);
    const { actionsMap, db, fileManager, log } = createPluginHarness();
    const ownedAttachment = {
      id: 42,
      createdById: 10,
      storageId: 1,
      filename: 'report.pdf',
      url: '/uploads/report.pdf',
      toJSON: () => ({ id: 42, createdById: 10, storageId: 1, filename: 'report.pdf', url: '/uploads/report.pdf' }),
      get: (k: string) => ({ id: 42, createdById: 10, storageId: 1, filename: 'report.pdf' })[k],
    };
    db.getRepository = vi.fn(() => ({ findOne: vi.fn(async () => ownedAttachment) }));
    fileManager.getFileStream.mockRejectedValue(new Error('S3 access denied'));

    const ctx = createCtx({
      db,
      request: { query: { id: '42', collection: 'attachments' }, body: {}, is: () => false },
    });

    await expect(actionsMap.download(ctx, async () => {})).rejects.toMatchObject({ status: 500 });
    if (!existedBefore) {
      expect(fs.existsSync(errorLogPath)).toBe(false);
    }
    const logged = log.error.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).not.toContain('SECRET_KEY_MUST_NOT_LEAK');
    expect(logged).not.toContain('AKIA_SUPER_SECRET');
  });

  it('enforces attachment access control in getContent and AI work context resolve', async () => {
    const { actionsMap, strategies, db, plugin } = createPluginHarness();
    const otherUsersAttachment = {
      id: 77,
      createdById: 999,
      filename: 'confidential.pdf',
      mimetype: 'application/pdf',
      get: (k: string) => ({ id: 77, createdById: 999, filename: 'confidential.pdf', mimetype: 'application/pdf' })[k],
    };
    db.getRepository = vi.fn(() => ({ findOne: vi.fn(async () => otherUsersAttachment) }));
    plugin.extractAttachmentText = vi.fn(async () => 'TOP SECRET');

    const ctx = createCtx({
      db,
      request: { query: {}, body: { file: { id: 77 } }, is: () => false },
    });

    await expect(actionsMap.getContent(ctx, async () => {})).rejects.toMatchObject({ status: 403 });
    await expect(strategies['file-preview'].resolve(ctx, { content: { file: { id: 77 } } })).rejects.toMatchObject({
      status: 403,
    });
    expect(plugin.extractAttachmentText).not.toHaveBeenCalled();
  });

  it('isolates uploaded file cache keys from persisted attachment cache keys in getContent', async () => {
    const { actionsMap, cacheStore, db, plugin } = createPluginHarness();
    const persistedAttachment = {
      id: 55,
      createdById: 10,
      filename: 'real.txt',
      mimetype: 'text/plain',
      extname: '.txt',
      get: (k: string) =>
        ({ id: 55, createdById: 10, filename: 'real.txt', mimetype: 'text/plain', extname: '.txt' })[k],
    };
    db.getRepository = vi.fn(() => ({ findOne: vi.fn(async () => persistedAttachment) }));
    plugin.consumeUploadedParseFile = vi.fn(async () => ({
      buffer: Buffer.from('attacker text'),
      attachment: { id: 55, filename: 'fake.txt', mimetype: 'text/plain', extname: '.txt' },
      cacheKey: 'sha256-attacker:.txt:13',
    }));
    plugin.extractUploadedFileText = vi.fn(async () => 'attacker text');
    plugin.extractAttachmentText = vi.fn(async () => 'real persisted text');

    const uploadCtx = createCtx({ db });
    await actionsMap.getContent(uploadCtx, async () => {});

    plugin.consumeUploadedParseFile = vi.fn(async () => null);
    const persistedCtx = createCtx({
      db,
      request: { query: {}, body: { file: { id: 55 } }, is: () => false },
    });
    await actionsMap.getContent(persistedCtx, async () => {});

    expect(persistedCtx.body.content).toContain('real persisted text');
    expect(persistedCtx.body.content).not.toContain('attacker text');
    expect(cacheStore.has('document_parser_uploaded_text:sha256-attacker:.txt:13')).toBe(true);
  });

  it('evaluates parent collection ACL own-scope templates via acl.resolveActionParams', async () => {
    const { plugin, acl } = createPluginHarness();
    acl.define({
      role: 'member',
      actions: {
        'orders:view': { filter: { createdById: '{{ ctx.state.currentUser.id }}' } },
      },
    });

    const countMock = vi.fn(async () => 1);
    const throughCollection = {
      repository: {
        find: vi.fn(async () => [{ get: (key: string) => (key === 'orderId' ? 501 : null) }]),
      },
    };
    const ordersCollection = {
      name: 'orders',
      model: { primaryKeyAttribute: 'id' },
      getField: () => ({}),
      repository: { count: countMock },
    };

    const db = {
      getCollection: (name: string) => {
        if (name === 'orders_attachments') return throughCollection;
        if (name === 'orders') return ordersCollection;
        return undefined;
      },
    };
    plugin.db = db;
    plugin.getParentCollections = () => [
      {
        collectionName: 'orders',
        throughTable: 'orders_attachments',
        otherKey: 'attachmentId',
        foreignKey: 'orderId',
      },
    ];

    const ctx = createCtx({ db });
    const allowed = await plugin.checkParentCollectionAccess(42, 'attachments', ['member'], ctx);

    expect(allowed).toBe(true);
    expect(countMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          $and: [{ id: { $in: [501] } }, { createdById: 10 }],
        },
        context: ctx,
      }),
    );
  });
});
