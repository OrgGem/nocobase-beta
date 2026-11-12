// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import aiKnowledgeBase from '../resources/ai-knowledge-base';
import aiKnowledgeBaseDocuments from '../resources/ai-knowledge-base-documents';
import aiVectorDatabase from '../resources/ai-vector-databases';
import aiVectorStore from '../resources/ai-vector-stores';
import { mergeSecretValues } from '../utils/credentials';

const pgHarness = vi.hoisted(() => ({ clients: [] as Array<{ options: Record<string, unknown> }> }));

vi.mock('pg', () => ({
  Client: class MockClient {
    constructor(options: Record<string, unknown>) {
      pgHarness.clients.push({ options });
    }

    async connect() {}

    async query() {
      return { rows: [] };
    }

    async end() {}
  },
}));

function makeRecord(data: Record<string, unknown>) {
  return {
    ...data,
    get(key: string) {
      return data[key];
    },
    set(key: string, value: unknown) {
      data[key] = value;
    },
    toJSON() {
      return { ...data };
    },
  };
}

function createCtx(overrides: Record<string, unknown> = {}) {
  const httpThrow = vi.fn((status: number, message: unknown) => {
    throw Object.assign(new Error(String(message)), { status });
  });
  const ctx = {
    action: { params: {} as Record<string, unknown> },
    auth: { user: { id: 7, roles: ['member'] } },
    state: { currentRoles: ['member'] },
    app: { acl: { getRole: vi.fn() }, pm: { get: vi.fn() } },
    db: { getRepository: vi.fn() },
    can: vi.fn(() => true),
    acl: { resolveActionParams: vi.fn(async () => ({ mergedParams: { filter: { id: 'db-1' } } })) },
    t: vi.fn((key: string) => key),
    throw: httpThrow,
    set: vi.fn(),
    body: null as unknown,
    ...overrides,
  };
  return ctx;
}

function createTransactionContext(ctx: ReturnType<typeof createCtx>) {
  type TestTransaction = { LOCK: { UPDATE: string } };
  const transaction: TestTransaction = { LOCK: { UPDATE: 'UPDATE' } };
  const db = ctx.db as {
    sequelize?: { transaction: (callback: (transaction: TestTransaction) => Promise<unknown>) => Promise<unknown> };
  };
  db.sequelize = {
    transaction: vi.fn(async (callback: (transaction: TestTransaction) => Promise<unknown>) => callback(transaction)),
  };
  return transaction;
}

function createKbRecord(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: 'kb-1',
    name: 'Knowledge base',
    type: 'LOCAL',
    accessLevel: 'BASIC',
    ownerId: 7,
    enabled: true,
    ...overrides,
  });
}

describe('knowledge base authorization and secret boundaries', () => {
  it('rejects non-scalar filterByTk values before authorization or writes on KB, vector DB, and vector store mutations', async () => {
    const mutations = [
      ['knowledge base update', aiKnowledgeBase.actions.update, 'aiKnowledgeBases'],
      ['knowledge base destroy', aiKnowledgeBase.actions.destroy, 'aiKnowledgeBases'],
      ['vector database update', aiVectorDatabase.actions.update, 'aiVectorDatabases'],
      ['vector database destroy', aiVectorDatabase.actions.destroy, 'aiVectorDatabases'],
      ['vector store update', aiVectorStore.actions.update, 'aiVectorStores'],
      ['vector store destroy', aiVectorStore.actions.destroy, 'aiVectorStores'],
    ] as const;
    const invalidIds: unknown[] = [['record-a', 'record-b'], { id: 'record-a' }, { $ne: 'record-a' }];

    for (const [name, action] of mutations) {
      for (const filterByTk of invalidIds) {
        const repoRead = vi.fn();
        const repoWrite = vi.fn();
        const ctx = createCtx({
          action: { params: { filterByTk, values: { name: 'unsafe update' } } },
          db: { getRepository: vi.fn(() => ({ findOne: repoRead, update: repoWrite, destroy: repoWrite })) },
        });

        await expect(action(ctx as never, vi.fn())).rejects.toMatchObject({ status: 400 });

        expect(ctx.throw).toHaveBeenCalledWith(400, 'A valid single record ID is required');
        expect(ctx.can).not.toHaveBeenCalled();
        expect(ctx.acl.resolveActionParams).not.toHaveBeenCalled();
        expect(ctx.db.getRepository).not.toHaveBeenCalled();
        expect(repoRead, name).not.toHaveBeenCalled();
        expect(repoWrite, name).not.toHaveBeenCalled();
      }
    }
  });

  it('rejects another user’s aiFiles ID before document creation or queueing on both create paths', async () => {
    for (const action of [aiKnowledgeBaseDocuments.actions.create, aiKnowledgeBase.actions.addDocument]) {
      const fileFindOne = vi.fn(async () => null);
      const documentCreate = vi.fn();
      const queuePlugin = { indexLifecycle: {}, documentVersionService: {} };
      const ctx = createCtx({
        action: {
          params: {
            values: {
              knowledgeBaseId: 'kb-1',
              fileId: 'file-owned-by-user-22',
              filename: 'private.txt',
              uploadedById: 22,
            },
          },
        },
        app: { acl: { getRole: vi.fn() }, pm: { get: vi.fn(() => queuePlugin) } },
        db: {
          getRepository: vi.fn((name: string) => {
            if (name === 'aiKnowledgeBases') return { findOne: vi.fn(async () => createKbRecord()) };
            if (name === 'aiFiles') return { findOne: fileFindOne };
            return { create: documentCreate, update: vi.fn() };
          }),
        },
      });

      await expect(action(ctx as never, vi.fn())).rejects.toThrow('File not found');

      expect(fileFindOne).toHaveBeenCalledWith({
        filter: { id: 'file-owned-by-user-22', createdById: '7' },
      });
      expect(documentCreate).not.toHaveBeenCalled();
      expect(ctx.app.pm.get).not.toHaveBeenCalled();
      expect(ctx.throw).toHaveBeenCalledWith(404, expect.stringContaining('File not found'));
    }
  });

  it('accepts an owned scalar aiFiles ID and derives the creator from the authenticated user', async () => {
    const file = makeRecord({ id: 'file-7', filename: 'owned.txt', createdById: '7' });
    const fileRepoFindOne = vi.fn(async () => file);
    const fileModelFindOne = vi.fn(async () => file);
    const kbRecord = createKbRecord();
    const kbModelFindOne = vi.fn(async () => kbRecord);
    const docRecord = makeRecord({ id: 'doc-1', knowledgeBaseId: undefined, fileId: undefined });
    const documentCreate = vi.fn(async () => docRecord);
    const documentUpdate = vi.fn(async () => docRecord);
    const plugin = { app: { eventQueue: { publish: vi.fn() } }, indexLifecycle: {} };
    const next = vi.fn();
    const ctx = createCtx({
      action: {
        params: {
          values: {
            knowledgeBaseId: 'kb-1',
            fileId: 'file-7',
            filename: 'owned.txt',
            uploadedById: 'spoofed-user',
            indexRevision: 'caller-revision',
            activeIndexRevision: 'caller-active-revision',
            indexDeleted: true,
            status: 'success',
            auditEvents: [{ secret: 'nested-write' }],
          },
        },
      },
      app: { acl: { getRole: vi.fn() }, pm: { get: vi.fn(() => plugin) } },
    });
    const transaction = createTransactionContext(ctx);
    const aiFiles = {
      findOne: fileRepoFindOne,
      collection: { model: { findOne: fileModelFindOne } },
    };
    const kbRepository = {
      findOne: vi.fn(async () => kbRecord),
      collection: { model: { findOne: kbModelFindOne } },
    };
    const documentRepository = {
      create: documentCreate,
      update: documentUpdate,
    };
    (ctx.db as { getRepository: unknown }).getRepository = vi.fn((name: string) => {
      if (name === 'aiKnowledgeBases') return kbRepository;
      if (name === 'aiFiles') return aiFiles;
      return documentRepository;
    });

    await aiKnowledgeBaseDocuments.actions.create(ctx as never, next);

    expect(fileRepoFindOne).toHaveBeenCalledWith({ filter: { id: 'file-7', createdById: '7' } });
    expect(fileModelFindOne).toHaveBeenCalledWith({
      where: { id: 'file-7', createdById: '7' },
      transaction,
      lock: 'UPDATE',
    });
    expect(documentCreate).toHaveBeenCalledWith({
      values: {
        knowledgeBaseId: 'kb-1',
        fileId: 'file-7',
        filename: 'owned.txt',
        textContent: undefined,
        status: 'pending',
        uploadedById: '7',
        indexWorkerToken: '__never_indexed__',
      },
      transaction,
    });
    expect(documentUpdate).toHaveBeenCalledWith({
      filterByTk: 'doc-1',
      values: { knowledgeBaseId: 'kb-1', fileId: 'file-7' },
      transaction,
    });
    expect(ctx.body).toBe(docRecord);
    expect(plugin.app.eventQueue.publish).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps caller document filters and intersects them with accessible KB IDs for list and stats', async () => {
    const inputListFilter = { knowledgeBaseId: { $in: ['public', 'private'] } };
    const inputStatsFilter = { $or: [{ status: 'failed' }, { status: 'pending' }] };
    const accessibleIds = ['public', 'shared-to-member', 'owned-by-7'];
    const kbFind = vi.fn(async () => accessibleIds.map((id) => makeRecord({ id })));
    const documentFind = vi.fn(async () => []);
    const ctx = createCtx({
      action: { params: { filter: inputListFilter } },
      db: {
        getRepository: vi.fn((name: string) =>
          name === 'aiKnowledgeBases' ? { find: kbFind } : { find: documentFind },
        ),
      },
    });

    await aiKnowledgeBaseDocuments.actions.list(ctx as never, vi.fn());

    expect(inputListFilter).toEqual({ knowledgeBaseId: { $in: ['public', 'private'] } });
    expect(kbFind).toHaveBeenCalledWith(expect.objectContaining({ fields: ['id'] }));
    expect(documentFind).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          $and: expect.arrayContaining([
            inputListFilter,
            { indexDeleted: { $isFalsy: true } },
            { knowledgeBaseId: { $in: accessibleIds } },
          ]),
        },
      }),
    );

    documentFind.mockClear();
    ctx.action.params = { filter: inputStatsFilter };

    await aiKnowledgeBaseDocuments.actions.stats(ctx as never, vi.fn());

    expect(inputStatsFilter).toEqual({ $or: [{ status: 'failed' }, { status: 'pending' }] });
    expect(documentFind).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          $and: expect.arrayContaining([
            inputStatsFilter,
            { indexDeleted: { $isFalsy: true } },
            { knowledgeBaseId: { $in: accessibleIds } },
          ]),
        },
      }),
    );
  });

  it('denies version-list access before reading version rows in an inaccessible KB', async () => {
    const docFindOne = vi.fn(async () => makeRecord({ id: 'doc-private', knowledgeBaseId: 'kb-private' }));
    const versionList = vi.fn(async () => [{ version: 1 }]);
    const plugin = { documentVersionService: { listVersions: versionList } };
    const ctx = createCtx({
      action: { params: { filterByTk: 'doc-private' } },
      app: { acl: { getRole: vi.fn() }, pm: { get: vi.fn(() => plugin) } },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'aiKnowledgeBaseDocuments') return { findOne: docFindOne };
          return { findOne: vi.fn(async () => createKbRecord({ id: 'kb-private', ownerId: 22 })) };
        }),
      },
    });

    await expect(aiKnowledgeBaseDocuments.actions.listVersions(ctx as never, vi.fn())).rejects.toThrow('Access denied');

    expect(ctx.throw).toHaveBeenCalledWith(403, 'Access denied');
    expect(versionList).not.toHaveBeenCalled();
  });

  it('masks External RAG keys in read, create, update, export, and nested associations', async () => {
    const secret = 'rag-secret-from-storage';
    const nestedDatabase = {
      id: 'vdb-1',
      name: 'Vector database',
      provider: 'pgvector',
      connectParams: { host: 'db.internal', password: 'vector-password', apiKey: 'vector-api-key' },
    };
    const record = createKbRecord({
      type: 'EXTERNAL_RAG',
      options: { ragProvider: 'external-http', ragApiUrl: 'https://rag.example.test', ragApiKey: secret },
      vectorStore: { id: 'vs-1', vectorDatabase: nestedDatabase },
    });
    const repo = {
      findOne: vi.fn(async () => record),
      find: vi.fn(async () => [record]),
      create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => makeRecord({ id: 'kb-new', ...values })),
      update: vi.fn(async ({ values }: { values: Record<string, unknown> }) =>
        makeRecord({ ...record.toJSON(), ...values }),
      ),
      collection: { model: { findOne: vi.fn(async () => record) } },
    };
    const ctx = createCtx({
      auth: { user: { id: 1, roles: ['root'] } },
      state: { currentRoles: ['root'] },
      action: { params: { filterByTk: 'kb-1' } },
      db: { getRepository: vi.fn(() => repo) },
    });
    const transaction = createTransactionContext(ctx);

    await aiKnowledgeBase.actions.get(ctx as never, vi.fn());
    expect(ctx.body).toMatchObject({
      options: { ragProvider: 'external-http', hasRagApiKey: true },
      vectorStore: { vectorDatabase: { connectParams: { password: '***', apiKey: '***' } } },
    });
    expect(JSON.stringify(ctx.body)).not.toContain(secret);
    expect(JSON.stringify(ctx.body)).not.toContain('vector-password');
    expect(JSON.stringify(ctx.body)).not.toContain('vector-api-key');

    ctx.action.params = {
      values: {
        name: 'Created External RAG',
        type: 'EXTERNAL_RAG',
        accessLevel: 'BASIC',
        options: { ragProvider: 'external-http', ragApiKey: secret },
      },
    };
    ctx.body = null;
    await aiKnowledgeBase.actions.create(ctx as never, vi.fn());
    expect(repo.create).toHaveBeenCalledWith({
      values: expect.objectContaining({
        type: 'EXTERNAL_RAG',
        ownerId: '1',
        options: { ragProvider: 'external-http', ragApiKey: secret },
      }),
      transaction,
    });
    expect((ctx.body as { options: Record<string, unknown> }).options).toMatchObject({ hasRagApiKey: true });
    expect((ctx.body as { options: Record<string, unknown> }).options).not.toHaveProperty('ragApiKey');

    ctx.action.params = {
      filterByTk: 'kb-1',
      values: { options: { ragProvider: 'external-http', ragApiKey: '***' } },
    };
    ctx.body = null;
    await aiKnowledgeBase.actions.update(ctx as never, vi.fn());
    expect(repo.update).toHaveBeenCalledWith({
      filterByTk: 'kb-1',
      values: expect.objectContaining({ options: expect.objectContaining({ ragApiKey: secret }) }),
      transaction,
    });
    expect(JSON.stringify(ctx.body)).not.toContain(secret);

    const exportDocRepo = { find: vi.fn(async () => []) };
    (ctx.db as { getRepository: unknown }).getRepository = vi.fn((name: string) =>
      name === 'aiKnowledgeBaseDocuments' ? exportDocRepo : repo,
    );
    ctx.action.params = { filterByTk: 'kb-1' };
    ctx.body = null;
    await aiKnowledgeBase.actions.export(ctx as never, vi.fn());
    expect(JSON.stringify(ctx.body)).not.toContain(secret);
    expect(JSON.stringify(ctx.body)).not.toContain('ragApiKey');
  });

  it('requires a replacement or explicit clear when an External RAG credential changes recipient', async () => {
    const secret = 'rag-secret-from-storage';
    const record = createKbRecord({
      type: 'EXTERNAL_RAG',
      options: { ragProvider: 'external-http', ragApiUrl: 'https://old-rag.example.test', ragApiKey: secret },
    });
    const update = vi.fn(async ({ values }: { values: Record<string, unknown> }) =>
      makeRecord({ ...record.toJSON(), ...values }),
    );
    const repo = {
      findOne: vi.fn(async () => record),
      update,
      collection: { model: { findOne: vi.fn(async () => record) } },
    };
    const ctx = createCtx({
      action: {
        params: {
          filterByTk: 'kb-1',
          values: { options: { ragProvider: 'external-http', ragApiUrl: 'https://new-rag.example.test' } },
        },
      },
      auth: { user: { id: 1, roles: ['root'] } },
      state: { currentRoles: ['root'] },
      db: { getRepository: vi.fn(() => repo) },
    });
    const transaction = createTransactionContext(ctx);

    await expect(aiKnowledgeBase.actions.update(ctx as never, vi.fn())).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.body)).not.toContain(secret);

    ctx.action.params = {
      filterByTk: 'kb-1',
      values: {
        options: { ragProvider: 'external-http', ragApiUrl: 'https://new-rag.example.test', ragApiKey: null },
      },
    };
    await aiKnowledgeBase.actions.update(ctx as never, vi.fn());
    expect(update).toHaveBeenCalledWith({
      filterByTk: 'kb-1',
      values: { options: { ragProvider: 'external-http', ragApiUrl: 'https://new-rag.example.test' } },
      transaction,
    });
    expect(JSON.stringify(ctx.body)).not.toContain(secret);
  });

  it('returns array updates with sanitized rows and drops nested or internal KB writes', async () => {
    const records = [
      createKbRecord({ id: 'kb-a', options: { ragApiKey: 'array-secret-a' } }),
      createKbRecord({ id: 'kb-b', options: { ragApiKey: 'array-secret-b' } }),
    ];
    const update = vi.fn(async () => records);
    const repo = {
      findOne: vi.fn(async () => records[0]),
      update,
      collection: { model: { findOne: vi.fn(async () => records[0]) } },
    };
    const ctx = createCtx({
      action: {
        params: {
          filterByTk: 'kb-a',
          values: {
            name: 'Renamed',
            documents: [{ textContent: 'nested write' }],
            vectorStore: { vectorDatabase: { connectParams: { password: 'nested-secret' } } },
            indexDeleted: true,
            activeIndexRevision: 'forged-revision',
            createdById: 123,
          },
        },
      },
      auth: { user: { id: 1, roles: ['root'] } },
      state: { currentRoles: ['root'] },
      db: { getRepository: vi.fn(() => repo) },
    });
    const transaction = createTransactionContext(ctx);

    await aiKnowledgeBase.actions.update(ctx as never, vi.fn());

    expect(update).toHaveBeenCalledWith({ filterByTk: 'kb-a', values: { name: 'Renamed' }, transaction });
    expect(ctx.body).toMatchObject([
      { id: 'kb-a', options: { hasRagApiKey: true } },
      { id: 'kb-b', options: { hasRagApiKey: true } },
    ]);
    expect(JSON.stringify(ctx.body)).not.toContain('array-secret-a');
    expect(JSON.stringify(ctx.body)).not.toContain('array-secret-b');
    expect(JSON.stringify(ctx.body)).not.toContain('nested-secret');
  });

  it('ignores nested documents, nested vector stores, and index fields on KB creation', async () => {
    const create = vi.fn(async ({ values }: { values: Record<string, unknown>; transaction?: unknown }) =>
      makeRecord({ id: 'kb-created', ...values }),
    );
    const repo = { create, update: vi.fn() };
    const ctx = createCtx({
      action: {
        params: {
          values: {
            name: 'Caller supplied KB',
            type: 'LOCAL',
            accessLevel: 'BASIC',
            documents: [{ filename: 'injected.txt', textContent: 'untrusted nested create' }],
            vectorStore: { connectParams: { password: 'nested-write' } },
            indexDeleted: true,
            ownerId: 900,
            createdById: 900,
          },
        },
      },
      db: { getRepository: vi.fn(() => repo) },
    });
    const transaction = createTransactionContext(ctx);

    await aiKnowledgeBase.actions.create(ctx as never, vi.fn());

    expect(create).toHaveBeenCalledOnce();
    const { values } = create.mock.calls[0][0];
    expect(values).toMatchObject({ name: 'Caller supplied KB', type: 'LOCAL', accessLevel: 'BASIC', ownerId: '7' });
    expect(create.mock.calls[0][0].transaction).toBe(transaction);
    expect(values).not.toHaveProperty('documents');
    expect(values).not.toHaveProperty('vectorStore');
    expect(values).not.toHaveProperty('indexDeleted');
    expect(values).not.toHaveProperty('createdById');
  });

  it('masks vector DB secrets in direct and nested vector store responses', async () => {
    const record = makeRecord({
      id: 'db-1',
      name: 'Vector DB',
      provider: 'pgvector',
      connectParams: { host: 'db.internal', password: 'stored-password', apiKey: 'stored-api-key' },
    });
    const vectorDbRepo = { find: vi.fn(async () => [record]), findOne: vi.fn(async () => record) };
    const vectorStoreRepo = {
      find: vi.fn(async () => [makeRecord({ id: 'vs-1', vectorDatabase: record })]),
      findOne: vi.fn(async () => makeRecord({ id: 'vs-1', vectorDatabase: record })),
    };
    const ctx = createCtx({
      db: {
        getRepository: vi.fn((name: string) => (name === 'aiVectorDatabases' ? vectorDbRepo : vectorStoreRepo)),
      },
    });

    await aiVectorDatabase.actions.list(ctx as never, vi.fn());
    expect(JSON.stringify(ctx.body)).not.toContain('stored-password');
    expect(JSON.stringify(ctx.body)).not.toContain('stored-api-key');
    expect(ctx.body).toMatchObject([{ connectParams: { password: '***', apiKey: '***' } }]);

    await aiVectorStore.actions.list(ctx as never, vi.fn());
    expect(JSON.stringify(ctx.body)).not.toContain('stored-password');
    expect(JSON.stringify(ctx.body)).not.toContain('stored-api-key');
    expect(ctx.body).toMatchObject([{ vectorDatabase: { connectParams: { password: '***', apiKey: '***' } } }]);
  });

  it('drops unapproved vector DB fields on create while retaining the configured secret', async () => {
    const record = makeRecord({
      id: 'db-new',
      name: 'Vector database',
      provider: 'pgvector',
      enabled: true,
      connectParams: { host: 'db.internal', password: 'new-password' },
    });
    const create = vi.fn(async ({ values }: { values: Record<string, unknown> }) =>
      makeRecord({ id: 'db-new', ...values }),
    );
    const ctx = createCtx({
      action: {
        params: {
          values: {
            name: 'Vector database',
            provider: 'pgvector',
            enabled: true,
            connectParams: { host: 'db.internal', password: 'new-password' },
            indexDeleted: true,
            createdById: 900,
            auditEvents: [{ secret: 'nested-write' }],
          },
        },
      },
      db: {
        getRepository: vi.fn(() => ({ create: async (args: { values: Record<string, unknown> }) => create(args) })),
      },
    });

    await aiVectorDatabase.actions.create(ctx as never, vi.fn());

    expect(create).toHaveBeenCalledWith({
      values: {
        name: 'Vector database',
        provider: 'pgvector',
        enabled: true,
        connectParams: { host: 'db.internal', password: 'new-password' },
      },
    });
    expect(JSON.stringify(ctx.body)).not.toContain('new-password');
    expect(ctx.body).toMatchObject({ connectParams: { password: '***' } });
    expect(record.get('id')).toBe('db-new');
  });

  it('preserves omitted and masked secrets, clears explicit blanks, and accepts replacements', () => {
    const original = { password: 'old-password', apiKey: 'old-api-key', database: 'kb' };

    expect(mergeSecretValues(original, { database: 'renamed' }, ['password', 'apiKey'])).toEqual({
      ...original,
      database: 'renamed',
    });
    expect(mergeSecretValues(original, { password: '***', apiKey: '***' }, ['password', 'apiKey'])).toEqual(original);
    expect(mergeSecretValues(original, { password: null, apiKey: '' }, ['password', 'apiKey'])).toEqual({
      database: 'kb',
    });
    expect(
      mergeSecretValues(original, { password: 'new-password', apiKey: 'new-api-key' }, ['password', 'apiKey']),
    ).toEqual({ password: 'new-password', apiKey: 'new-api-key', database: 'kb' });
  });

  it('keeps the saved connection on title-only edits and authorizes saved-record connection tests', async () => {
    pgHarness.clients.length = 0;
    const storedParams = {
      host: 'pg.internal',
      port: 5432,
      username: 'kb_user',
      password: 'stored-password',
      database: 'kb',
      tableName: 'vectors',
    };
    const existing = makeRecord({ id: 'db-1', name: 'Old title', provider: 'pgvector', connectParams: storedParams });
    const modelFindOne = vi.fn(async () => existing);
    const update = vi.fn(async ({ values }: { values: Record<string, unknown> }) =>
      makeRecord({ ...existing.toJSON(), ...values }),
    );
    const docsFind = vi.fn(async () => []);
    const vectorDbFindOne = vi.fn(async () => existing);
    const vectorDbRepo = {
      findOne: vectorDbFindOne,
      update,
      collection: { model: { findOne: modelFindOne } },
    };
    const ctx = createCtx({
      action: { params: { filterByTk: 'db-1', values: { name: 'New title' } } },
      db: {
        sequelize: {
          transaction: vi.fn(async (callback: (transaction: { LOCK: { UPDATE: string } }) => Promise<unknown>) =>
            callback({ LOCK: { UPDATE: 'UPDATE' } }),
          ),
        },
        getRepository: vi.fn((name: string) =>
          name === 'aiKnowledgeBaseDocuments' ? { find: docsFind } : vectorDbRepo,
        ),
      },
    });

    await aiVectorDatabase.actions.update(ctx as never, vi.fn());
    expect(update).toHaveBeenCalledWith({
      filterByTk: 'db-1',
      values: { name: 'New title' },
      transaction: expect.any(Object),
    });
    expect(JSON.stringify(ctx.body)).not.toContain('stored-password');

    ctx.action.params = {
      values: { values: { id: 'db-1', provider: 'pgvector', connectParams: { host: 'pg.internal' } } },
    };
    await aiVectorDatabase.actions.test(ctx as never, vi.fn());
    expect(ctx.can).toHaveBeenCalledWith({ resource: 'aiVectorDatabase', action: 'update' });
    expect(ctx.acl.resolveActionParams).toHaveBeenCalledWith(ctx, {
      resourceName: 'aiVectorDatabase',
      actionName: 'update',
      params: { filterByTk: 'db-1' },
    });
    expect(vectorDbFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ filterByTk: 'db-1', filter: { id: 'db-1' } }),
    );
    expect(pgHarness.clients.at(-1)?.options.password).toBe('stored-password');
    expect(JSON.stringify(ctx.body)).not.toContain('stored-password');
  });

  it('does not send an existing password to a newly supplied PostgreSQL host', async () => {
    pgHarness.clients.length = 0;
    const existing = makeRecord({
      id: 'db-1',
      provider: 'pgvector',
      connectParams: {
        host: 'pg.internal',
        port: 5432,
        username: 'kb_user',
        password: 'stored-password',
        database: 'kb',
        tableName: 'vectors',
      },
    });
    const ctx = createCtx({
      action: {
        params: {
          values: {
            values: { id: 'db-1', provider: 'pgvector', connectParams: { host: 'new-host.attacker.test' } },
          },
        },
      },
      db: {
        getRepository: vi.fn((name: string) =>
          name === 'aiVectorDatabases' ? { findOne: vi.fn(async () => existing) } : { find: vi.fn(async () => []) },
        ),
      },
    });
    await expect(aiVectorDatabase.actions.test(ctx as never, vi.fn())).rejects.toMatchObject({ status: 400 });

    expect(ctx.throw).toHaveBeenCalledWith(400, expect.any(String));
    expect(pgHarness.clients).toHaveLength(0);
    expect(JSON.stringify(ctx.body)).not.toContain('stored-password');
  });

  it('requires a new or cleared password before saving a changed vector DB destination', async () => {
    const existing = makeRecord({
      id: 'db-1',
      name: 'Vector database',
      provider: 'pgvector',
      connectParams: {
        host: 'pg.internal',
        port: 5432,
        username: 'kb_user',
        password: 'stored-password',
        database: 'kb',
        tableName: 'vectors',
      },
    });
    const update = vi.fn(async ({ values }: { values: Record<string, unknown> }) =>
      makeRecord({ ...existing.toJSON(), ...values }),
    );
    const repo = { collection: { model: { findOne: vi.fn(async () => existing) } }, update };
    const ctx = createCtx({
      action: {
        params: { filterByTk: 'db-1', values: { connectParams: { host: 'new-host.example.test' } } },
      },
      db: {
        getRepository: vi.fn((name: string) =>
          name === 'aiKnowledgeBaseDocuments' ? { find: vi.fn(async () => []) } : repo,
        ),
      },
    });
    const transaction = createTransactionContext(ctx);

    await expect(aiVectorDatabase.actions.update(ctx as never, vi.fn())).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();

    ctx.action.params = {
      filterByTk: 'db-1',
      values: { connectParams: { host: 'new-host.example.test', password: null } },
    };
    await aiVectorDatabase.actions.update(ctx as never, vi.fn());
    expect(update).toHaveBeenCalledWith({
      filterByTk: 'db-1',
      values: {
        connectParams: {
          host: 'new-host.example.test',
          port: 5432,
          username: 'kb_user',
          database: 'kb',
          tableName: 'vectors',
        },
      },
      transaction,
    });
    expect(JSON.stringify(ctx.body)).not.toContain('stored-password');
  });

  it('rejects saved-connection tests without update permission', async () => {
    const findOne = vi.fn();
    const ctx = createCtx({
      can: vi.fn(() => false),
      action: { params: { values: { values: { id: 'db-1' } } } },
      db: { getRepository: vi.fn(() => ({ findOne })) },
    });

    await expect(aiVectorDatabase.actions.test(ctx as never, vi.fn())).rejects.toMatchObject({ status: 403 });

    expect(ctx.throw).toHaveBeenCalledWith(403, 'Access denied');
    expect(findOne).not.toHaveBeenCalled();
  });
});
