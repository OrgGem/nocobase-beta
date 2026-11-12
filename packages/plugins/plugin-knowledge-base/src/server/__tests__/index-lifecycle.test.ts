// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTypes, Sequelize } from 'sequelize';
import {
  endpointFingerprint,
  IndexLifecycleService,
  LEGACY_INDEX_REVISION,
  NEVER_INDEXED_TOKEN,
  deleteIndexRevision,
} from '../services/index-lifecycle';
import { filterCurrentDocuments } from '../services/index-visibility';
import { DefaultVectorStoreService } from '../features/vector-store-provider-impl';
import { buildSearchCacheKey } from '../services/cache';
import { KnowledgeSearchService } from '../services/knowledge-search';
import { createStoredKnowledgeBaseDocument } from '../utils/create-document';
import { DocumentVersionService } from '../services/document-version';
import AddIndexLifecycleFields from '../migrations/20261112000000-add-index-lifecycle-fields';

const vectorMocks = vi.hoisted(() => ({
  pgClient: {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  },
  qdrantClient: {
    delete: vi.fn(),
    collectionExists: vi.fn(),
  },
  PgClient: vi.fn(),
  QdrantClient: vi.fn(),
}));

vi.mock('pg', () => ({ Client: vectorMocks.PgClient }));
vi.mock('@qdrant/js-client-rest', () => ({ QdrantClient: vectorMocks.QdrantClient }));

type Data = Record<string, unknown>;
type Transaction = { LOCK: { UPDATE: string } };
type MockRow = {
  get(key: string): unknown;
  get(options: { plain: true }): Data;
  update(values: Data): Promise<void>;
};
type RepoQuery = {
  filter?: Record<string, unknown>;
  fields?: string[];
  sort?: string[];
  limit?: number;
  appends?: string[];
  transaction?: Transaction;
};
type ModelQuery = { where?: Record<string, unknown>; transaction?: Transaction; lock?: string; attributes?: string[] };

function createRow(initial: Data): MockRow & { data: Data } {
  const data = { ...initial };
  function get(key: string): unknown;
  function get(options: { plain: true }): Data;
  function get(keyOrOptions: string | { plain: true }): unknown {
    return typeof keyOrOptions === 'string' ? data[keyOrOptions] : { ...data };
  }

  return {
    data,
    get,
    update: async (values) => {
      Object.assign(data, values);
    },
  };
}

function createFixture(initialDocuments: Data[], options: { vectorDatabase?: Data; files?: Data[] } = {}) {
  const documents = new Map(initialDocuments.map((document) => [String(document.id), createRow(document)]));
  const files = new Map((options.files ?? []).map((file) => [String(file.id), createRow(file)]));
  const transaction: Transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const dbConfig = options.vectorDatabase;
  const vectorDatabase = dbConfig ? createRow(dbConfig) : null;
  const vectorStore = dbConfig ? createRow({ id: 'vs-1', vectorDatabaseId: dbConfig.id ?? 'vdb-1' }) : null;
  const kbData: Data = {
    id: 'kb-1',
    deleteSourceFile: false,
    ...(vectorStore ? { vectorStoreId: 'vs-1' } : {}),
    ...(dbConfig
      ? {
          vectorStore: {
            vectorDatabase: {
              id: dbConfig.id ?? 'vdb-1',
              provider: dbConfig.provider,
              connectParams: dbConfig.connectParams,
            },
          },
        }
      : {}),
  };
  const kbRow = createRow(kbData);
  const matchesWhere = (row: MockRow, where?: Record<string, unknown>) =>
    !where || Object.entries(where).every(([key, value]) => String(row.get(key) ?? '') === String(value ?? ''));
  const docModel = {
    findOne: vi.fn(
      async ({ where }: ModelQuery = {}) =>
        Array.from(documents.values()).find((row) => matchesWhere(row, where)) ?? null,
    ),
    findAll: vi.fn(async ({ where }: ModelQuery = {}) =>
      Array.from(documents.values()).filter((row) => matchesWhere(row, where)),
    ),
  };
  const docRepo = {
    collection: { model: docModel },
    find: vi.fn(async ({ filter }: RepoQuery = {}) => {
      let rows = Array.from(documents.values());
      const requestedIds = filter?.id as { $in?: unknown[] } | undefined;
      if (Array.isArray(requestedIds?.$in)) {
        const idSet = new Set(requestedIds.$in.map(String));
        rows = rows.filter((row) => idSet.has(String(row.get('id'))));
      }
      if (filter?.indexCleanupNeeded === true) rows = rows.filter((row) => row.get('indexCleanupNeeded') === true);
      return rows.map((row) => ({ toJSON: () => ({ ...row.data }) }));
    }),
  };
  const kbRepo = {
    collection: {
      model: {
        findOne: vi.fn(async ({ where }: ModelQuery = {}) => (matchesWhere(kbRow, where) ? kbRow : null)),
      },
    },
    findOne: vi.fn(async ({ filter }: RepoQuery = {}) =>
      String(filter?.id ?? '') === String(kbData.id) ? { toJSON: () => ({ ...kbData }) } : null,
    ),
    destroy: vi.fn(async (_options: { filterByTk?: string; transaction?: Transaction } = {}) => undefined),
  };
  const vectorDatabaseRepo = {
    collection: {
      model: {
        findOne: vi.fn(async ({ where }: ModelQuery = {}) =>
          vectorDatabase && matchesWhere(vectorDatabase, where) ? vectorDatabase : null,
        ),
      },
    },
    findOne: vi.fn(async () => (vectorDatabase ? { toJSON: () => ({ ...vectorDatabase.data }) } : null)),
  };
  const vectorStoreRepo = {
    collection: {
      model: {
        findOne: vi.fn(async ({ where }: ModelQuery = {}) =>
          vectorStore && matchesWhere(vectorStore, where) ? vectorStore : null,
        ),
      },
    },
  };
  const fileRepo = {
    collection: {
      model: {
        findOne: vi.fn(
          async ({ where }: ModelQuery = {}) =>
            Array.from(files.values()).find((row) => matchesWhere(row, where)) ?? null,
        ),
      },
    },
    destroy: vi.fn(async () => undefined),
  };
  const repositories: Record<string, unknown> = {
    aiKnowledgeBaseDocuments: docRepo,
    aiKnowledgeBases: kbRepo,
    aiVectorStores: vectorStoreRepo,
    aiVectorDatabases: vectorDatabaseRepo,
    aiFiles: fileRepo,
  };
  const plugin = {
    app: { logger: { warn: vi.fn() } },
    db: {
      sequelize: {
        transaction: vi.fn(async <T>(callback: (transaction: Transaction) => Promise<T>) => callback(transaction)),
      },
      getRepository: (name: string) => repositories[name],
    },
  };
  return { plugin, documents, files, docRepo, docModel, kbRepo, kbRow, vectorStoreRepo, vectorDatabaseRepo, fileRepo };
}

function qdrantDatabase(overrides: Data = {}): Data {
  return {
    id: 'vdb-1',
    provider: 'qdrant',
    connectParams: { url: 'http://127.0.0.1:6333', collectionName: 'kb_vectors' },
    ...overrides,
  };
}

describe('IndexLifecycleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vectorMocks.PgClient.mockImplementation(() => vectorMocks.pgClient);
    vectorMocks.QdrantClient.mockImplementation(() => vectorMocks.qdrantClient);
    vectorMocks.qdrantClient.collectionExists.mockResolvedValue({ exists: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('activates only the current worker after its vector write completes', async () => {
    KnowledgeSearchService.cache.clear();
    const fixture = createFixture(
      [
        {
          id: 'doc-1',
          knowledgeBaseId: 'kb-1',
          indexWorkerToken: NEVER_INDEXED_TOKEN,
          status: 'pending',
          chunkCount: 0,
        },
      ],
      { vectorDatabase: qdrantDatabase() },
    );
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);
    const currentCacheKey = buildSearchCacheKey(['kb-1'], 'query', {});
    const otherCacheKey = buildSearchCacheKey(['kb-2'], 'query', {});
    KnowledgeSearchService.cache.set(currentCacheKey, ['stale result']);
    KnowledgeSearchService.cache.set(otherCacheKey, ['other KB result']);
    const revision = await lifecycle.requestReprocess('doc-1');
    const firstWorker = await lifecycle.begin('doc-1');

    expect(firstWorker).toMatchObject({ revision, token: expect.any(String) });
    expect(fixture.documents.get('doc-1')?.data.indexWorkerToken).toBe(firstWorker?.token);
    expect(
      await filterCurrentDocuments(fixture.plugin as never, [
        { id: 'new-write', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: revision } },
      ]),
    ).toEqual([]);

    const nextRevision = await lifecycle.requestReprocess('doc-1');
    const nextWorker = await lifecycle.begin('doc-1');
    expect(nextWorker?.revision).toBe(nextRevision);
    expect(await lifecycle.activate('doc-1', revision, String(firstWorker?.token), { chunkCount: 2 })).toBe(false);
    expect(fixture.documents.get('doc-1')?.data.activeIndexRevision).toBeUndefined();
    expect(await lifecycle.activate('doc-1', nextRevision, String(nextWorker?.token), { chunkCount: 2 })).toBe(true);
    expect(fixture.documents.get('doc-1')?.data).toMatchObject({
      activeIndexRevision: nextRevision,
      status: 'success',
      chunkCount: 2,
      indexWorkerToken: null,
    });
    expect(KnowledgeSearchService.cache.get(currentCacheKey)).toBeUndefined();
    expect(KnowledgeSearchService.cache.get(otherCacheKey)).toEqual(['other KB result']);
    await expect(
      filterCurrentDocuments(fixture.plugin as never, [
        { id: 'old-write', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: revision } },
        {
          id: 'new-write',
          metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: nextRevision },
        },
      ]),
    ).resolves.toEqual([
      { id: 'new-write', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: nextRevision } },
    ]);
  });

  it('keeps the active revision visible after a partial write fails and retries with a fresh revision', async () => {
    const fixture = createFixture(
      [
        {
          id: 'doc-1',
          knowledgeBaseId: 'kb-1',
          indexRevision: 'failed-revision',
          activeIndexRevision: 'active-revision',
          indexWorkerToken: 'worker-current',
          status: 'processing',
          retryCount: 2,
          retiredIndexRevisions: [],
        },
      ],
      { vectorDatabase: qdrantDatabase() },
    );
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);

    await lifecycle.fail('doc-1', 'failed-revision', 'worker-stale', 'stale failure');
    expect(fixture.documents.get('doc-1')?.data.status).toBe('processing');
    await lifecycle.fail('doc-1', 'failed-revision', 'worker-current', 'partial write failed');
    expect(fixture.documents.get('doc-1')?.data).toMatchObject({
      activeIndexRevision: 'active-revision',
      indexRevision: null,
      status: 'failed',
      retryCount: 3,
      indexCleanupNeeded: true,
      indexCleanupPending: true,
      retiredIndexRevisions: ['failed-revision'],
    });

    const visible = await filterCurrentDocuments(fixture.plugin as never, [
      { metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'active-revision' } },
      { metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'failed-revision' } },
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.metadata?.indexRevision).toBe('active-revision');

    const retryRevision = await lifecycle.requestReprocess('doc-1');
    expect(retryRevision).not.toBe('failed-revision');
    expect(fixture.documents.get('doc-1')?.data.retiredIndexRevisions).toEqual(['failed-revision']);
  });

  it('filters stale, deleted, cross-KB, and unknown chunks while retaining legacy rows', async () => {
    const fixture = createFixture([
      { id: 'current', knowledgeBaseId: 'kb-1', activeIndexRevision: 'r2' },
      { id: 'legacy', knowledgeBaseId: 'kb-1', activeIndexRevision: null, indexWorkerToken: null },
      { id: 'deleted', knowledgeBaseId: 'kb-1', activeIndexRevision: 'r1', indexDeleted: true },
      { id: 'other-kb', knowledgeBaseId: 'kb-2', activeIndexRevision: 'r1' },
    ]);
    const candidates = [
      { id: 'stale', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'current', indexRevision: 'r1' } },
      { id: 'current', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'current', indexRevision: 'r2' } },
      { id: 'legacy', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'legacy' } },
      {
        id: 'legacy-new-format',
        metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'legacy', indexRevision: 'r1' },
      },
      { id: 'deleted', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'deleted', indexRevision: 'r1' } },
      { id: 'wrong-kb', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'other-kb', indexRevision: 'r1' } },
      { id: 'missing', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'missing', indexRevision: 'r1' } },
    ];

    await expect(filterCurrentDocuments(fixture.plugin as never, candidates)).resolves.toEqual([
      candidates[1],
      candidates[2],
    ]);
  });

  it('preserves claim-free rows when no vector store is configured', async () => {
    for (const workerToken of [NEVER_INDEXED_TOKEN, null]) {
      const fixture = createFixture([
        {
          id: 'doc-1',
          knowledgeBaseId: 'kb-1',
          indexRevision: null,
          indexWorkerToken: workerToken,
          status: 'pending',
        },
      ]);
      const lifecycle = new IndexLifecycleService(fixture.plugin as never);

      await expect(lifecycle.requestReprocess('doc-1')).resolves.toBeNull();
      await expect(lifecycle.begin('doc-1')).resolves.toBeNull();
      expect(fixture.documents.get('doc-1')?.data).toMatchObject({
        indexRevision: null,
        indexWorkerToken: workerToken,
        status: 'pending',
      });
    }
  });

  it('fences a real worker and retires its uncommitted revision if the vector store disappears', async () => {
    const fixture = createFixture([
      {
        id: 'doc-1',
        knowledgeBaseId: 'kb-1',
        indexRevision: 'worker-revision',
        activeIndexRevision: 'active-revision',
        indexWorkerToken: 'active-worker',
        indexWorkerStartedAt: new Date(),
        status: 'processing',
        retiredIndexRevisions: [],
      },
    ]);
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);

    await expect(lifecycle.requestReprocess('doc-1')).resolves.toBeNull();

    expect(fixture.documents.get('doc-1')?.data).toMatchObject({
      indexRevision: null,
      activeIndexRevision: 'active-revision',
      indexWorkerToken: null,
      indexWorkerStartedAt: null,
      status: 'pending',
      retiredIndexRevisions: ['worker-revision'],
      indexCleanupNeeded: false,
      indexCleanupPending: true,
      indexCleanupProgress: 0,
    });
    await expect(lifecycle.activate('doc-1', 'worker-revision', 'active-worker', { chunkCount: 3 })).resolves.toBe(
      false,
    );
    expect(fixture.documents.get('doc-1')?.data.activeIndexRevision).toBe('active-revision');
  });

  it('restores a text version by opening a new index revision and queueing the document', async () => {
    const fixture = createFixture(
      [
        {
          id: 'doc-1',
          knowledgeBaseId: 'kb-1',
          textContent: 'current text',
          filename: 'current.txt',
          indexRevision: 'active-revision',
          activeIndexRevision: 'active-revision',
          status: 'success',
        },
      ],
      { vectorDatabase: qdrantDatabase() },
    );
    type VersionRecord = {
      documentId: string;
      version: number;
      textContent: string;
      filename: string;
      changeType?: string;
    };
    const versions: VersionRecord[] = [
      { documentId: 'doc-1', version: 1, textContent: 'restored text', filename: 'old.txt' },
    ];
    const versionsRepo = {
      findOne: vi.fn(
        async ({ filter }: RepoQuery = {}) =>
          versions.find((version) => version.documentId === String(filter?.documentId) && version.version === 1) ??
          null,
      ),
      find: vi.fn(async ({ filter, sort, offset }: RepoQuery & { offset?: number } = {}) => {
        const rows = versions.filter(
          (version) => !filter?.documentId || version.documentId === String(filter.documentId),
        );
        if (sort?.[0] === '-version') rows.sort((left, right) => right.version - left.version);
        return typeof offset === 'number' ? rows.slice(offset) : rows;
      }),
      create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
        const version = values as unknown as VersionRecord;
        versions.push(version);
        return version;
      }),
      destroy: vi.fn(async () => undefined),
    };
    const documentRow = fixture.documents.get('doc-1');
    if (!documentRow) throw new Error('Missing restore document fixture');
    const documentRepository = {
      ...fixture.docRepo,
      findOne: vi.fn(async () => ({ get: (key: string) => documentRow.get(key) })),
    };
    const db = {
      sequelize: fixture.plugin.db.sequelize,
      getRepository: (name: string) =>
        name === 'aiKnowledgeBaseDocumentVersions'
          ? versionsRepo
          : name === 'aiKnowledgeBaseDocuments'
            ? documentRepository
            : fixture.plugin.db.getRepository(name),
    };
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);
    const service = new DocumentVersionService(db as never, lifecycle);
    const enqueue = vi.fn(async () => undefined);

    await expect(service.restoreVersion('doc-1', 1, enqueue, 7)).resolves.toMatchObject({ restored: true });

    expect(fixture.documents.get('doc-1')?.data).toMatchObject({ textContent: 'restored text', status: 'pending' });
    expect(fixture.documents.get('doc-1')?.data.indexRevision).not.toBe('active-revision');
    expect(versions.map((version) => version.changeType)).toEqual([undefined, 'reprocess', 'restore']);
    expect(enqueue).toHaveBeenCalledWith('doc-1');
  });

  it('filters provider results to current revisions and applies normalized similarity thresholds', async () => {
    const fixture = createFixture([
      { id: 'doc-1', knowledgeBaseId: 'kb-1', activeIndexRevision: 'current' },
      { id: 'legacy-doc', knowledgeBaseId: 'kb-1', activeIndexRevision: null },
    ]);
    const similaritySearchWithScore = vi.fn(
      async () =>
        [
          [
            {
              pageContent: 'exact match',
              metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'current' },
            },
            1,
          ],
          [
            {
              pageContent: 'near match',
              metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'current' },
            },
            0.5,
          ],
          [
            {
              pageContent: 'old revision',
              metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'old' },
            },
            0.99,
          ],
          [
            { pageContent: 'below threshold', metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'legacy-doc' } },
            0.2,
          ],
        ] as never,
    );
    const service = new DefaultVectorStoreService({ similaritySearchWithScore }, 'pgvector', fixture.plugin as never);

    await expect(service.search('query', { topK: 2, score: 0.3 })).resolves.toEqual([
      {
        content: 'exact match',
        metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'current' },
        score: 1,
      },
      {
        content: 'near match',
        metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'current' },
        score: 0.5,
      },
    ]);
    expect(similaritySearchWithScore).toHaveBeenCalledWith('query', 2, undefined);
  });

  it('tombstones never-indexed imported text without requesting vector cleanup', async () => {
    const fixture = createFixture([
      {
        id: 'doc-1',
        knowledgeBaseId: 'kb-1',
        indexWorkerToken: NEVER_INDEXED_TOKEN,
        indexRevision: null,
        activeIndexRevision: null,
        retiredIndexRevisions: [],
        chunkCount: 0,
        status: 'pending',
      },
    ]);
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);

    await lifecycle.markDeleted('doc-1');

    expect(fixture.documents.get('doc-1')?.data).toMatchObject({
      indexDeleted: true,
      status: 'deleted',
      indexCleanupNeeded: false,
      indexCleanupPending: false,
      retiredIndexRevisions: [],
      indexCleanupRoute: null,
    });
  });

  it('keeps a legacy indexed tombstone hidden when its cleanup route is unknown', async () => {
    const fixture = createFixture([
      {
        id: 'doc-1',
        knowledgeBaseId: 'kb-1',
        indexWorkerToken: null,
        indexRevision: null,
        activeIndexRevision: null,
        retiredIndexRevisions: null,
        chunkCount: 3,
        status: 'success',
      },
    ]);
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);

    await lifecycle.markDeleted('doc-1');

    expect(fixture.documents.get('doc-1')?.data).toMatchObject({
      indexDeleted: true,
      indexCleanupNeeded: false,
      indexCleanupPending: true,
      retiredIndexRevisions: [LEGACY_INDEX_REVISION],
      error: expect.stringContaining('manual investigation'),
    });
    await expect(
      filterCurrentDocuments(fixture.plugin as never, [
        { metadata: { knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1' } },
      ]),
    ).resolves.toEqual([]);
  });

  it('detaches and tombstones documents in the same transaction as knowledge-base deletion', async () => {
    const fixture = createFixture(
      [
        {
          id: 'doc-1',
          knowledgeBaseId: 'kb-1',
          indexRevision: 'active-revision',
          activeIndexRevision: 'active-revision',
          indexWorkerToken: null,
          chunkCount: 4,
          status: 'success',
        },
      ],
      { vectorDatabase: qdrantDatabase() },
    );
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);

    await lifecycle.destroyKnowledgeBase('kb-1', () => true);

    expect(fixture.documents.get('doc-1')?.data).toMatchObject({
      knowledgeBaseId: null,
      indexDeleted: true,
      retiredIndexRevisions: ['active-revision'],
      indexCleanupNeeded: true,
      indexCleanupPending: true,
      indexCleanupRoute: {
        knowledgeBaseId: 'kb-1',
        vectorDatabaseId: 'vdb-1',
        provider: 'qdrant',
        collectionName: 'kb_vectors',
        endpointFingerprint: endpointFingerprint('qdrant', {
          url: 'http://127.0.0.1:6333',
          collectionName: 'kb_vectors',
        }),
      },
    });
    expect(fixture.kbRepo.destroy).toHaveBeenCalledWith({ filterByTk: 'kb-1', transaction: expect.any(Object) });
    const kbLockOrder = fixture.kbRepo.collection.model.findOne.mock.invocationCallOrder[0];
    const documentScanOrder = fixture.docModel.findAll.mock.invocationCallOrder[0];
    const kbDestroyOrder = fixture.kbRepo.destroy.mock.invocationCallOrder[0];
    if (kbLockOrder === undefined || documentScanOrder === undefined || kbDestroyOrder === undefined) {
      throw new Error('Missing knowledge-base deletion call order evidence');
    }
    expect(kbLockOrder).toBeLessThan(documentScanOrder);
    expect(documentScanOrder).toBeLessThan(kbDestroyOrder);
    const transaction = fixture.kbRepo.collection.model.findOne.mock.calls[0]?.[0].transaction;
    expect(fixture.docModel.findAll.mock.calls[0]?.[0].transaction).toBe(transaction);
    const knowledgeBaseDestroyCall = fixture.kbRepo.destroy.mock.calls[0];
    if (!knowledgeBaseDestroyCall) throw new Error('Knowledge-base deletion was not called');
    expect(knowledgeBaseDestroyCall[0].transaction).toBe(transaction);
  });

  it('deletes an owned source file only when no other live document refers to it', async () => {
    const fixture = createFixture(
      [
        {
          id: 'doc-1',
          knowledgeBaseId: 'kb-1',
          indexRevision: 'active-revision',
          activeIndexRevision: 'active-revision',
          uploadedById: 7,
          fileId: 10,
        },
        { id: 'doc-2', knowledgeBaseId: 'kb-2', fileId: 10, indexDeleted: false },
      ],
      { files: [{ id: 10, createdById: 7 }] },
    );
    fixture.kbRow.data.deleteSourceFile = true;
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);

    await expect(lifecycle.deleteOwnedSourceFile('doc-1', 'active-revision')).resolves.toBe(false);
    expect(fixture.fileRepo.destroy).not.toHaveBeenCalled();

    const secondDocument = fixture.documents.get('doc-2');
    if (!secondDocument) throw new Error('Missing second document fixture');
    secondDocument.data.indexDeleted = true;
    await expect(lifecycle.deleteOwnedSourceFile('doc-1', 'active-revision')).resolves.toBe(true);
    expect(fixture.documents.get('doc-1')?.data.fileId).toBeNull();
    expect(fixture.fileRepo.destroy).toHaveBeenCalledWith({ filterByTk: 10, transaction: expect.any(Object) });
  });

  it('honors the KB source-file flag after locking the KB row', async () => {
    const fixture = createFixture(
      [
        {
          id: 'doc-1',
          knowledgeBaseId: 'kb-1',
          indexRevision: 'active-revision',
          activeIndexRevision: 'active-revision',
          uploadedById: 7,
          fileId: 10,
        },
      ],
      { files: [{ id: 10, createdById: 7 }] },
    );
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);

    await expect(lifecycle.deleteOwnedSourceFile('doc-1', 'active-revision')).resolves.toBe(false);

    expect(fixture.kbRepo.collection.model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ transaction: expect.any(Object), lock: 'UPDATE' }),
    );
    expect(fixture.docModel.findOne).toHaveBeenCalledTimes(1);
    expect(fixture.docModel.findAll).not.toHaveBeenCalled();
    expect(fixture.fileRepo.destroy).not.toHaveBeenCalled();
  });

  it('checks file references after the KB, document, and file locks observe a concurrent reference', async () => {
    const fixture = createFixture(
      [
        {
          id: 'doc-1',
          knowledgeBaseId: 'kb-1',
          indexRevision: 'active-revision',
          activeIndexRevision: 'active-revision',
          uploadedById: 7,
          fileId: 10,
        },
        { id: 'doc-2', knowledgeBaseId: 'kb-2', fileId: 10, indexDeleted: true },
      ],
      { files: [{ id: 10, createdById: 7 }] },
    );
    fixture.kbRow.data.deleteSourceFile = true;
    const secondDocument = fixture.documents.get('doc-2');
    if (!secondDocument) throw new Error('Missing second document fixture');
    fixture.docModel.findAll.mockImplementation(async ({ where }: ModelQuery = {}) => {
      secondDocument.data.indexDeleted = false;
      return Array.from(fixture.documents.values()).filter((row) =>
        Object.entries(where ?? {}).every(([key, value]) => String(row.get(key) ?? '') === String(value ?? '')),
      );
    });
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);

    await expect(lifecycle.deleteOwnedSourceFile('doc-1', 'active-revision')).resolves.toBe(false);

    const docCalls = fixture.docModel.findOne.mock.invocationCallOrder;
    const kbLockOrder = fixture.kbRepo.collection.model.findOne.mock.invocationCallOrder[0];
    const lockedDocOrder = docCalls[1];
    const fileLockOrder = fixture.fileRepo.collection.model.findOne.mock.invocationCallOrder[0];
    const referenceQueryOrder = fixture.docModel.findAll.mock.invocationCallOrder[0];
    expect(kbLockOrder).toBeLessThan(lockedDocOrder);
    expect(lockedDocOrder).toBeLessThan(fileLockOrder);
    expect(fileLockOrder).toBeLessThan(referenceQueryOrder);
    expect(fixture.fileRepo.destroy).not.toHaveBeenCalled();
  });

  it('clears pending status after one confirmed cleanup cycle and does not repend a historical tombstone on failure', async () => {
    const database = qdrantDatabase();
    const fixture = createFixture(
      [
        {
          id: 'confirmed',
          knowledgeBaseId: 'kb-1',
          indexDeleted: true,
          indexCleanupNeeded: true,
          indexCleanupPending: true,
          indexCleanupProgress: 0,
          indexCleanupCursor: 0,
          retiredIndexRevisions: ['old-revision'],
          indexCleanupRoute: {
            knowledgeBaseId: 'kb-1',
            vectorDatabaseId: 'vdb-1',
            provider: 'qdrant',
            collectionName: 'kb_vectors',
            endpointFingerprint: endpointFingerprint('qdrant', {
              url: 'http://127.0.0.1:6333',
              collectionName: 'kb_vectors',
            }),
          },
        },
        {
          id: 'historical',
          knowledgeBaseId: null,
          indexDeleted: true,
          indexCleanupNeeded: true,
          indexCleanupPending: false,
          indexCleanupProgress: 1,
          indexCleanupCursor: 1,
          retiredIndexRevisions: ['old-revision'],
          indexCleanupRoute: {
            knowledgeBaseId: 'kb-1',
            vectorDatabaseId: 'vdb-1',
            provider: 'qdrant',
            collectionName: 'kb_vectors',
            endpointFingerprint: 'fingerprint-for-old-endpoint',
          },
        },
      ],
      { vectorDatabase: database },
    );
    const lifecycle = new IndexLifecycleService(fixture.plugin as never);
    const confirmed = fixture.documents.get('confirmed');
    if (!confirmed) throw new Error('Missing cleanup fixture');
    confirmed.data.indexCleanupRoute = {
      knowledgeBaseId: 'kb-1',
      vectorDatabaseId: 'vdb-1',
      provider: 'qdrant',
      collectionName: 'kb_vectors',
      endpointFingerprint: endpointFingerprint('qdrant', database.connectParams as Record<string, unknown>),
    };

    await lifecycle.sweep();

    expect(vectorMocks.qdrantClient.delete).toHaveBeenCalledTimes(1);
    expect(confirmed.data).toMatchObject({ indexCleanupPending: false, indexCleanupProgress: 1 });
    expect(fixture.documents.get('historical')?.data.indexCleanupPending).toBe(false);
    expect(fixture.plugin.app.logger.warn).toHaveBeenCalledWith(
      '[KnowledgeBase] Index cleanup failed for document historical; it will be retried.',
    );
  });

  it('clears pending cleanup when the PG table or confirmed Qdrant collection is already absent', async () => {
    const pgDatabase = {
      id: 'vdb-1',
      provider: 'pgvector',
      connectParams: {
        host: '127.0.0.1',
        port: 5432,
        username: 'unit-test-user',
        password: 'unit-test-password',
        database: 'vectors',
        tableName: 'missing_vectors',
      },
    };
    const pgFixture = createFixture(
      [
        {
          id: 'pg-doc',
          knowledgeBaseId: 'kb-1',
          indexCleanupNeeded: true,
          indexCleanupPending: true,
          retiredIndexRevisions: ['old-revision'],
          indexCleanupRoute: {
            knowledgeBaseId: 'kb-1',
            vectorDatabaseId: 'vdb-1',
            provider: 'pgvector',
            collectionName: 'missing_vectors',
            endpointFingerprint: endpointFingerprint('pgvector', pgDatabase.connectParams),
          },
        },
      ],
      { vectorDatabase: pgDatabase },
    );
    vectorMocks.pgClient.query.mockResolvedValueOnce({ rows: [] });
    await new IndexLifecycleService(pgFixture.plugin as never).sweep();
    expect(pgFixture.documents.get('pg-doc')?.data.indexCleanupPending).toBe(false);

    const qdrantDatabaseConfig = qdrantDatabase();
    const qdrantFixture = createFixture(
      [
        {
          id: 'qdrant-doc',
          knowledgeBaseId: 'kb-1',
          indexCleanupNeeded: true,
          indexCleanupPending: true,
          retiredIndexRevisions: ['old-revision'],
          indexCleanupRoute: {
            knowledgeBaseId: 'kb-1',
            vectorDatabaseId: 'vdb-1',
            provider: 'qdrant',
            collectionName: 'missing_collection',
            endpointFingerprint: endpointFingerprint('qdrant', {
              url: 'http://127.0.0.1:6333',
              collectionName: 'missing_collection',
            }),
          },
        },
      ],
      {
        vectorDatabase: {
          ...qdrantDatabaseConfig,
          connectParams: { url: 'http://127.0.0.1:6333', collectionName: 'missing_collection' },
        },
      },
    );
    const notFound = Object.assign(new Error('collection not found'), { status: 404 });
    vectorMocks.qdrantClient.delete.mockRejectedValueOnce(notFound);
    vectorMocks.qdrantClient.collectionExists.mockResolvedValueOnce({ exists: false });
    await new IndexLifecycleService(qdrantFixture.plugin as never).sweep();
    expect(qdrantFixture.documents.get('qdrant-doc')?.data.indexCleanupPending).toBe(false);
    expect(qdrantFixture.plugin.app.logger.warn).not.toHaveBeenCalled();
  });

  it('uses a quoted table identifier and bound values for PGVector cleanup', async () => {
    vectorMocks.pgClient.query.mockResolvedValueOnce({
      rows: [{ nspname: 'public', relname: 'kb_vectors', relkind: 'r' }],
    });
    await deleteIndexRevision(
      'pgvector',
      {
        host: '127.0.0.1',
        port: 5432,
        username: 'user',
        password: 'unit-test-password',
        database: 'vectors',
        tableName: 'kb_vectors',
      },
      'kb-1',
      "doc'1",
      "revision'1",
    );

    expect(vectorMocks.pgClient.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('pg_catalog.to_regclass($1)'),
      ['kb_vectors'],
    );
    expect(vectorMocks.pgClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('DELETE FROM "public"."kb_vectors"'),
      ['kb-1', "doc'1", "revision'1"],
    );
    expect(vectorMocks.pgClient.query.mock.calls[1]?.[0]).toContain('"metadata"->>\'indexRevision\' = $3');
    const injectionPayload = 'vectors"; DROP TABLE secrets; --';
    vectorMocks.pgClient.query.mockRejectedValueOnce(new Error('invalid regclass syntax'));
    await expect(
      deleteIndexRevision('pgvector', { tableName: injectionPayload }, 'kb-1', 'doc-1', 'rev-1'),
    ).rejects.toThrow('invalid regclass syntax');
    expect(vectorMocks.pgClient.query).toHaveBeenLastCalledWith(expect.stringContaining('pg_catalog.to_regclass($1)'), [
      injectionPayload,
    ]);
    expect(vectorMocks.pgClient.query).toHaveBeenCalledTimes(3);
  });

  it('cleans legacy provider rows only inside the selected KB and document scope', async () => {
    vectorMocks.pgClient.query.mockResolvedValueOnce({
      rows: [{ nspname: 'public', relname: 'kb_vectors', relkind: 'r' }],
    });
    await deleteIndexRevision(
      'pgvector',
      {
        host: '127.0.0.1',
        port: 5432,
        username: 'user',
        password: 'unit-test-password',
        database: 'vectors',
        tableName: 'kb_vectors',
      },
      'kb-1',
      'doc-1',
      LEGACY_INDEX_REVISION,
    );

    expect(vectorMocks.pgClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('"metadata"->>\'indexRevision\' IS NULL'),
      ['kb-1', 'doc-1'],
    );
    expect(vectorMocks.pgClient.query.mock.calls[1]?.[0]).toContain('"metadata"->>\'knowledgeBaseOuterId\' = $1');
    expect(vectorMocks.pgClient.query.mock.calls[1]?.[0]).toContain('"metadata"->>\'documentId\' = $2');
  });

  it('treats confirmed missing provider targets as clean and preserves authorization failures', async () => {
    vectorMocks.pgClient.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      deleteIndexRevision('pgvector', { tableName: 'missing_vectors' }, 'kb-1', 'doc-1', 'rev-1'),
    ).resolves.toBeUndefined();
    expect(vectorMocks.pgClient.query).toHaveBeenCalledTimes(1);
    expect(vectorMocks.pgClient.end).toHaveBeenCalledTimes(1);

    const permissionDenied = Object.assign(new Error('permission denied'), { code: '42501' });
    vectorMocks.pgClient.query.mockRejectedValueOnce(permissionDenied);
    await expect(
      deleteIndexRevision('pgvector', { tableName: 'restricted_vectors' }, 'kb-1', 'doc-1', 'rev-1'),
    ).rejects.toBe(permissionDenied);

    const collectionMissing = Object.assign(new Error('collection not found'), { status: 404 });
    vectorMocks.qdrantClient.delete.mockRejectedValueOnce(collectionMissing);
    vectorMocks.qdrantClient.collectionExists.mockResolvedValueOnce({ exists: false });
    await expect(
      deleteIndexRevision(
        'qdrant',
        { url: 'http://127.0.0.1:6333', collectionName: 'missing_collection' },
        'kb-1',
        'doc-1',
        'rev-1',
      ),
    ).resolves.toBeUndefined();
    expect(vectorMocks.qdrantClient.collectionExists).toHaveBeenCalledWith('missing_collection');

    const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
    vectorMocks.qdrantClient.delete.mockRejectedValueOnce(forbidden);
    await expect(
      deleteIndexRevision(
        'qdrant',
        { url: 'http://127.0.0.1:6333', collectionName: 'restricted_collection' },
        'kb-1',
        'doc-1',
        'rev-1',
      ),
    ).rejects.toBe(forbidden);
    expect(vectorMocks.qdrantClient.collectionExists).toHaveBeenCalledTimes(1);

    const proxyNotFound = Object.assign(new Error('upstream returned not found'), { status: 404 });
    vectorMocks.qdrantClient.delete.mockRejectedValueOnce(proxyNotFound);
    vectorMocks.qdrantClient.collectionExists.mockResolvedValueOnce({ exists: true });
    await expect(
      deleteIndexRevision(
        'qdrant',
        { url: 'http://127.0.0.1:6333', collectionName: 'existing_collection' },
        'kb-1',
        'doc-1',
        'rev-1',
      ),
    ).rejects.toBe(proxyNotFound);
    expect(vectorMocks.qdrantClient.collectionExists).toHaveBeenLastCalledWith('existing_collection');
  });

  it('uses KB, document, and revision filters for Qdrant cleanup without mutating the configured collection', async () => {
    const params = { url: 'http://127.0.0.1:6333', collectionName: 'kb_vectors' };

    await deleteIndexRevision('qdrant', params, 'kb-1', 'doc-1', 'revision-1');

    expect(vectorMocks.qdrantClient.delete).toHaveBeenCalledWith('kb_vectors', {
      wait: true,
      filter: {
        must: [
          { key: 'metadata.knowledgeBaseOuterId', match: { value: 'kb-1' } },
          { key: 'metadata.documentId', match: { value: 'doc-1' } },
          { key: 'metadata.indexRevision', match: { value: 'revision-1' } },
        ],
      },
    });
    expect(params).toEqual({ url: 'http://127.0.0.1:6333', collectionName: 'kb_vectors' });

    await deleteIndexRevision('qdrant', params, 'kb-1', 'doc-1', LEGACY_INDEX_REVISION);
    expect(vectorMocks.qdrantClient.delete).toHaveBeenLastCalledWith('kb_vectors', {
      wait: true,
      filter: {
        must: [
          { key: 'metadata.knowledgeBaseOuterId', match: { value: 'kb-1' } },
          { key: 'metadata.documentId', match: { value: 'doc-1' } },
          { is_empty: { key: 'metadata.indexRevision' } },
        ],
      },
    });
  });

  it('preserves legacy NULL during schema sync and migration, and stamps new helper-created rows', async () => {
    const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const queryInterface = sequelize.getQueryInterface();
    const tableName = 'aiKnowledgeBaseDocuments';
    try {
      await queryInterface.createTable(tableName, {
        id: { type: DataTypes.STRING, primaryKey: true },
        status: { type: DataTypes.STRING },
      });
      await queryInterface.bulkInsert(tableName, [{ id: 'legacy-doc', status: 'success' }]);
      const model = sequelize.define(
        'aiKnowledgeBaseDocuments',
        {
          id: { type: DataTypes.STRING, primaryKey: true },
          status: { type: DataTypes.STRING },
          indexWorkerToken: { type: DataTypes.STRING },
        },
        { tableName, timestamps: false },
      );
      const collection = {
        model,
        getTableNameWithSchema: () => tableName,
      };
      await model.sync({ alter: { drop: false } });
      const migration = new AddIndexLifecycleFields({
        db: {
          sequelize,
          getCollection: () => collection,
        },
      } as never);

      await migration.up();
      await migration.up();

      const legacy = await model.findByPk('legacy-doc');
      expect(legacy?.get('indexWorkerToken')).toBeNull();
      const documentRepo = {
        collection: { model },
        create: async ({ values, transaction }: { values: Record<string, unknown>; transaction: unknown }) =>
          model.create(values, { transaction: transaction as never }),
        update: async ({ filterByTk, values }: { filterByTk: string; values: Record<string, unknown> }) =>
          model.update(values, { where: { id: filterByTk } }),
      };
      const knowledgeBaseRepo = {
        collection: {
          model: {
            findOne: async () => ({ toJSON: () => ({ id: 'kb-1', vectorStoreId: null }) }),
          },
        },
      };
      const db = {
        sequelize,
        getRepository: (name: string) => (name === 'aiKnowledgeBases' ? knowledgeBaseRepo : documentRepo),
      };
      const fresh = await createStoredKnowledgeBaseDocument(db as never, {
        id: 'fresh-doc',
        knowledgeBaseId: 'kb-1',
        status: 'pending',
      });
      expect(fresh.get('indexWorkerToken')).toBe(NEVER_INDEXED_TOKEN);
    } finally {
      await sequelize.close();
    }
  });
});
