// SPDX-License-Identifier: Apache-2.0

import { ACL } from '@nocobase/acl';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginFilePreviewAuthServer } from '../plugin';

function createHttpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

interface MockRecordData {
  id: number | string;
  createdById: number;
  storageId: number;
  filename: string;
  title?: string;
  extname?: string;
  mimetype: string;
  path?: string;
  bytes: Buffer;
}

function makeSequelizeLikeRecord(collectionName: string, data: MockRecordData) {
  const { bytes: _bytes, ...plain } = data;
  const record = {
    ...plain,
    constructor: { collection: { name: collectionName } },
    get: (key: string) => (plain as Record<string, unknown>)[key],
    getDataValue: (key: string) => (plain as Record<string, unknown>)[key],
    toJSON: () => ({ ...plain }),
  };
  return record;
}

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createHarness(
  options: {
    aiFiles?: MockRecordData[];
    attachments?: MockRecordData[];
    parentLinks?: Array<{ orderId: number; attachmentId: number | string; orderOwnerId: number }>;
    storageType?: string;
  } = {},
) {
  const actionsMap: Record<string, (ctx: any, next: () => Promise<void>) => Promise<void>> = {};
  const acl = new ACL();
  const plugin = Object.create(PluginFilePreviewAuthServer.prototype) as any;
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const aiFilesList = options.aiFiles || [];
  const attachmentsList = options.attachments || [];
  const parentLinks = options.parentLinks || [];

  const bytesByCollectionAndKey = new Map<string, Buffer>();
  for (const item of aiFilesList) {
    bytesByCollectionAndKey.set(`aiFiles:${item.id}`, item.bytes);
    bytesByCollectionAndKey.set(`file:${item.filename}:${item.path || ''}`, item.bytes);
  }
  for (const item of attachmentsList) {
    bytesByCollectionAndKey.set(`attachments:${item.id}`, item.bytes);
    bytesByCollectionAndKey.set(`file:${item.filename}:${item.path || ''}`, item.bytes);
  }

  const aiFilesFindOne = vi.fn(async (query: any) => {
    const targetId = query?.filterByTk ?? query?.filter?.id;
    const found = aiFilesList.find((item) => String(item.id) === String(targetId));
    if (!found) return null;
    if (query?.filter?.createdById != null && String(found.createdById) !== String(query.filter.createdById)) {
      return null;
    }
    return makeSequelizeLikeRecord('aiFiles', found);
  });

  const attachmentsFindOne = vi.fn(async (query: any) => {
    const targetId = query?.filterByTk ?? query?.filter?.id;
    const found = attachmentsList.find((item) => String(item.id) === String(targetId));
    if (!found) return null;
    if (query?.filter?.createdById != null && String(found.createdById) !== String(query.filter.createdById)) {
      return null;
    }
    return makeSequelizeLikeRecord('attachments', found);
  });

  const ordersCollection = {
    name: 'orders',
    options: {},
    fields: new Map([
      [
        'attachments',
        {
          type: 'belongsToMany',
          options: {
            target: 'attachments',
            through: 'orders_attachments',
            otherKey: 'attachmentId',
            foreignKey: 'orderId',
          },
        },
      ],
    ]),
    model: { name: 'orders', primaryKeyAttribute: 'id' },
    getField: () => ({}),
    repository: {
      count: vi.fn(async (query: any) => {
        const clauses = query?.filter?.$and || (query?.filter ? [query.filter] : []);
        const matchingOrders = parentLinks.filter((link) => {
          return clauses.every((clause: any) => {
            if (clause?.id?.$in && !clause.id.$in.includes(link.orderId)) {
              return false;
            }
            if (clause?.createdById != null && String(link.orderOwnerId) !== String(clause.createdById)) {
              return false;
            }
            return true;
          });
        });
        return matchingOrders.length;
      }),
    },
  };

  const throughCollection = {
    name: 'orders_attachments',
    options: {},
    fields: new Map(),
    model: { name: 'orders_attachments', primaryKeyAttribute: 'id' },
    repository: {
      find: vi.fn(async (query: any) => {
        const attId = query?.filter?.attachmentId;
        return parentLinks
          .filter((link) => String(link.attachmentId) === String(attId))
          .map((link) => ({
            get: (key: string) => (key === 'orderId' ? link.orderId : link.attachmentId),
          }));
      }),
    },
  };

  const collections = new Map<string, any>([
    [
      'aiFiles',
      {
        name: 'aiFiles',
        options: { template: 'file' },
        fields: new Map(),
        model: { name: 'aiFiles', primaryKeyAttribute: 'id', rawAttributes: {} },
        getField: () => ({}),
      },
    ],
    [
      'attachments',
      {
        name: 'attachments',
        options: { template: 'file' },
        fields: new Map(),
        model: { name: 'attachments', primaryKeyAttribute: 'id', rawAttributes: {} },
        getField: () => ({}),
      },
    ],
    [
      'users',
      {
        name: 'users',
        options: {},
        fields: new Map(),
        model: { name: 'users', primaryKeyAttribute: 'id', rawAttributes: {} },
        getField: () => ({}),
      },
    ],
  ]);
  if (parentLinks.length > 0) {
    collections.set('orders', ordersCollection);
    collections.set('orders_attachments', throughCollection);
  }

  const db = {
    collections,
    getCollection: vi.fn((name: string) => collections.get(name)),
    getRepository: vi.fn((name: string) => {
      if (name === 'aiFiles') return { findOne: aiFilesFindOne };
      if (name === 'attachments') return { findOne: attachmentsFindOne };
      if (name === 'orders') return ordersCollection.repository;
      if (name === 'orders_attachments') return throughCollection.repository;
      return { findOne: vi.fn(async () => null) };
    }),
  };

  const fileManager = {
    storagesCache: new Map([
      [
        1,
        {
          id: 1,
          name: 'private-s3',
          type: options.storageType || 's3-private',
          options: {
            bucket: 'private-bucket',
            accessKeyId: 'AKIA_PRIVATE_KEY',
            secretAccessKey: 'SECRET_MUST_NEVER_LEAK',
          },
        },
      ],
    ]),
    getFileStream: vi.fn(async (attachmentObj: any) => {
      const key = `file:${attachmentObj.filename}:${attachmentObj.path || ''}`;
      const bytes = bytesByCollectionAndKey.get(key);
      if (!bytes) {
        throw new Error(`Storage object missing: ${key}`);
      }
      return {
        stream: Readable.from([bytes]),
        contentType: attachmentObj.mimetype,
      };
    }),
  };

  const pm = {
    get: vi.fn((name: string) => {
      if (name === '@nocobase/plugin-file-manager' || name === 'file-manager') return fileManager;
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
    db: { value: db, configurable: true, writable: true },
    pm: { value: pm, configurable: true, writable: true },
    log: { value: log, configurable: true, writable: true },
  });

  plugin.registerDownloadApi();

  return { plugin, actionsMap, acl, db, fileManager, log, aiFilesFindOne, attachmentsFindOne };
}

function createCtx(db: any, overrides: Record<string, unknown> = {}) {
  const responseHeaders: Record<string, string> = {};
  const ctx: any = {
    db,
    state: {
      currentUser: { id: 10, roles: ['member'] },
      currentRoles: ['member'],
      currentRole: 'member',
    },
    action: { params: {} },
    request: { query: {}, body: {}, is: () => false },
    responseHeaders,
    type: '',
    body: undefined,
    set: vi.fn((name: string, value: string) => {
      responseHeaders[name.toLowerCase()] = value;
    }),
    attachment: vi.fn((filename: string) => {
      responseHeaders['content-disposition'] =
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }),
    throw: (status: number, message: string) => {
      throw createHttpError(status, message);
    },
    ...overrides,
  };
  return ctx;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('filePreviewAuth:streamDocument', () => {
  it('streams exact bytes, MIME, filename, and private no-store headers to the aiFiles owner', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\nOwner AI chat report\n%%EOF', 'utf-8');
    const { actionsMap, db, fileManager } = createHarness({
      aiFiles: [
        {
          id: 42,
          createdById: 10,
          storageId: 1,
          filename: 'hash_42.pdf',
          title: 'Báo cáo Q1',
          extname: '.pdf',
          mimetype: 'application/pdf',
          path: 'ai/42',
          bytes: pdfBytes,
        },
      ],
    });

    const ctx = createCtx(db, {
      request: {
        query: {
          collection: 'aiFiles',
          id: '42',
          // Spoofed client parameters must be ignored completely.
          filename: 'spoofed.txt',
          storageId: '999',
          path: '../../etc/passwd',
          url: '/files/main/main/attachments/999',
        },
        body: {},
        is: () => false,
      },
    });

    await actionsMap.streamDocument(ctx, async () => {});

    expect(fileManager.getFileStream).toHaveBeenCalledTimes(1);
    expect(fileManager.getFileStream.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        id: 42,
        storageId: 1,
        filename: 'hash_42.pdf',
        path: 'ai/42',
      }),
    );
    expect(ctx.responseHeaders['cache-control']).toBe('private, no-store');
    expect(ctx.responseHeaders['x-content-type-options']).toBe('nosniff');
    expect(ctx.type).toBe('application/pdf');
    expect(ctx.attachment).toHaveBeenCalledWith('Báo cáo Q1.pdf');
    expect(await readStreamToBuffer(ctx.body)).toEqual(pdfBytes);
  });

  it('denies another logged-in user accessing someone else aiFiles record with 403 and zero bytes', async () => {
    const secretBytes = Buffer.from('CONFIDENTIAL_AI_FILE', 'utf-8');
    const { actionsMap, db, fileManager } = createHarness({
      aiFiles: [
        {
          id: 42,
          createdById: 10,
          storageId: 1,
          filename: 'secret.txt',
          mimetype: 'text/plain',
          path: 'ai/42',
          bytes: secretBytes,
        },
      ],
    });

    const otherUserCtx = createCtx(db, {
      state: {
        currentUser: { id: 20, roles: ['member'] },
        currentRoles: ['member'],
        currentRole: 'member',
      },
      request: { query: { collection: 'aiFiles', id: '42' }, body: {}, is: () => false },
    });

    await expect(actionsMap.streamDocument(otherUserCtx, async () => {})).rejects.toMatchObject({ status: 403 });
    expect(otherUserCtx.body).toBeUndefined();
    expect(fileManager.getFileStream).not.toHaveBeenCalled();
  });

  it('allows ACL-authorized user on standalone attachments and parent-scoped attachments, while blocking unauthorized users', async () => {
    const standaloneBytes = Buffer.from('STANDALONE_ATTACHMENT', 'utf-8');
    const linkedBytes = Buffer.from('ORDER_LINKED_ATTACHMENT', 'utf-8');
    const { actionsMap, acl, db, fileManager } = createHarness({
      attachments: [
        {
          id: 101,
          createdById: 10,
          storageId: 1,
          filename: 'standalone.txt',
          mimetype: 'text/plain',
          path: 'att/101',
          bytes: standaloneBytes,
        },
        {
          id: 102,
          createdById: 10,
          storageId: 1,
          filename: 'order-doc.txt',
          mimetype: 'text/plain',
          path: 'att/102',
          bytes: linkedBytes,
        },
      ],
      parentLinks: [{ orderId: 500, attachmentId: 102, orderOwnerId: 20 }],
    });

    acl.define({
      role: 'reader',
      actions: {
        'attachments:view': {},
        'orders:view': { filter: { createdById: '{{ ctx.state.currentUser.id }}' } },
      },
    });

    // User 20 owns order 500 -> allowed on linked attachment 102 and standalone attachment 101 via attachments:view
    const allowedCtx101 = createCtx(db, {
      state: { currentUser: { id: 20, roles: ['reader'] }, currentRoles: ['reader'], currentRole: 'reader' },
      request: { query: { collection: 'attachments', id: '101' }, body: {}, is: () => false },
    });
    await actionsMap.streamDocument(allowedCtx101, async () => {});
    expect(await readStreamToBuffer(allowedCtx101.body)).toEqual(standaloneBytes);

    const allowedCtx102 = createCtx(db, {
      state: { currentUser: { id: 20, roles: ['reader'] }, currentRoles: ['reader'], currentRole: 'reader' },
      request: { query: { collection: 'attachments', id: '102' }, body: {}, is: () => false },
    });
    await actionsMap.streamDocument(allowedCtx102, async () => {});
    expect(await readStreamToBuffer(allowedCtx102.body)).toEqual(linkedBytes);

    // User 30 has reader role, but does NOT own order 500 -> blocked on linked attachment 102 even with attachments:view!
    const deniedLinkedCtx = createCtx(db, {
      state: { currentUser: { id: 30, roles: ['reader'] }, currentRoles: ['reader'], currentRole: 'reader' },
      request: { query: { collection: 'attachments', id: '102' }, body: {}, is: () => false },
    });
    await expect(actionsMap.streamDocument(deniedLinkedCtx, async () => {})).rejects.toMatchObject({ status: 403 });
    expect(deniedLinkedCtx.body).toBeUndefined();
    expect(fileManager.getFileStream).toHaveBeenCalledTimes(2);
  });

  it('rejects unauthenticated requests with 401 and deleted/missing IDs with 404 without streaming bytes', async () => {
    const { actionsMap, db, fileManager } = createHarness({
      aiFiles: [
        {
          id: 7,
          createdById: 10,
          storageId: 1,
          filename: 'doc.pdf',
          mimetype: 'application/pdf',
          bytes: Buffer.from('%PDF-1.4\nhello'),
        },
      ],
    });

    const unauthCtx = createCtx(db, {
      state: { currentUser: null, currentRoles: [], currentRole: '' },
      request: { query: { collection: 'aiFiles', id: '7' }, body: {}, is: () => false },
    });
    await expect(actionsMap.streamDocument(unauthCtx, async () => {})).rejects.toMatchObject({ status: 401 });

    const missingCtx = createCtx(db, {
      request: { query: { collection: 'aiFiles', id: '9999' }, body: {}, is: () => false },
    });
    await expect(actionsMap.streamDocument(missingCtx, async () => {})).rejects.toMatchObject({ status: 404 });
    expect(fileManager.getFileStream).not.toHaveBeenCalled();
  });

  it('strictly isolates aiFiles and attachments even when IDs and filenames collide', async () => {
    const aiBytes = Buffer.from('AI_FILES_PAYLOAD_42', 'utf-8');
    const attBytes = Buffer.from('ATTACHMENTS_PAYLOAD_42', 'utf-8');
    const attOnlyBytes = Buffer.from('ATTACHMENTS_ONLY_999', 'utf-8');
    const { actionsMap, db, aiFilesFindOne, attachmentsFindOne, fileManager } = createHarness({
      aiFiles: [
        {
          id: 42,
          createdById: 10,
          storageId: 1,
          filename: 'report.pdf',
          mimetype: 'application/pdf',
          path: 'ai/42',
          bytes: aiBytes,
        },
      ],
      attachments: [
        {
          id: 42,
          createdById: 10,
          storageId: 1,
          filename: 'report.pdf',
          mimetype: 'application/pdf',
          path: 'att/42',
          bytes: attBytes,
        },
        {
          id: 999,
          createdById: 10,
          storageId: 1,
          filename: 'only-in-att.pdf',
          mimetype: 'application/pdf',
          path: 'att/999',
          bytes: attOnlyBytes,
        },
      ],
    });

    // Request aiFiles#42 -> must query ONLY aiFiles and stream AI_FILES_PAYLOAD_42
    const aiCtx = createCtx(db, {
      request: { query: { collection: 'aiFiles', id: '42' }, body: {}, is: () => false },
    });
    await actionsMap.streamDocument(aiCtx, async () => {});
    expect(await readStreamToBuffer(aiCtx.body)).toEqual(aiBytes);
    expect(aiFilesFindOne).toHaveBeenCalledTimes(1);
    expect(attachmentsFindOne).not.toHaveBeenCalled();

    // Request attachments#42 -> must query ONLY attachments and stream ATTACHMENTS_PAYLOAD_42
    aiFilesFindOne.mockClear();
    attachmentsFindOne.mockClear();
    const attCtx = createCtx(db, {
      request: { query: { collection: 'attachments', id: '42' }, body: {}, is: () => false },
    });
    await actionsMap.streamDocument(attCtx, async () => {});
    expect(await readStreamToBuffer(attCtx.body)).toEqual(attBytes);
    expect(attachmentsFindOne).toHaveBeenCalledTimes(1);
    expect(aiFilesFindOne).not.toHaveBeenCalled();

    // Request aiFiles#999 (exists only in attachments) -> must 404, never cross over to attachments!
    aiFilesFindOne.mockClear();
    attachmentsFindOne.mockClear();
    const crossCtx = createCtx(db, {
      request: {
        query: {
          collection: 'aiFiles',
          id: '999',
          filename: 'only-in-att.pdf',
          url: '/files/main/main/attachments/999',
        },
        body: {},
        is: () => false,
      },
    });
    await expect(actionsMap.streamDocument(crossCtx, async () => {})).rejects.toMatchObject({ status: 404 });
    expect(attachmentsFindOne).not.toHaveBeenCalled();
    expect(fileManager.getFileStream).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported collections and malformed IDs with 400', async () => {
    const { actionsMap, db, fileManager } = createHarness();

    const badColCtx = createCtx(db, {
      request: { query: { collection: 'users', id: '1' }, body: {}, is: () => false },
    });
    await expect(actionsMap.streamDocument(badColCtx, async () => {})).rejects.toMatchObject({ status: 400 });

    const missingColCtx = createCtx(db, {
      request: { query: { id: '1' }, body: {}, is: () => false },
    });
    await expect(actionsMap.streamDocument(missingColCtx, async () => {})).rejects.toMatchObject({ status: 400 });

    const badIdCtx = createCtx(db, {
      request: { query: { collection: 'aiFiles', id: '../secret' }, body: {}, is: () => false },
    });
    await expect(actionsMap.streamDocument(badIdCtx, async () => {})).rejects.toMatchObject({ status: 400 });

    expect(fileManager.getFileStream).not.toHaveBeenCalled();
  });
});
