// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { QdrantClient } from '@qdrant/js-client-rest';
import { DefaultVectorStoreService } from '../features/vector-store-provider-impl';
import { PGVectorDatabaseProvider } from '../providers/pgvector';
import { deleteIndexRevision, LEGACY_INDEX_REVISION } from '../services/index-lifecycle';

type TestDocument = { pageContent: string; metadata: Record<string, unknown> };
type TestVectorStore = {
  addDocuments(documents: TestDocument[], options: { ids: string[] }): Promise<string[]>;
  similaritySearchWithScore(
    query: string,
    limit: number,
  ): Promise<Array<[{ pageContent: string; metadata: Record<string, unknown> }, number]>>;
};

const pgTest = Boolean(process.env.KB_TEST_PGVECTOR_PORT && process.env.KB_TEST_PGVECTOR_PASSWORD);
const qdrantTest = Boolean(process.env.KB_TEST_QDRANT_URL);

function createEmbeddings(): EmbeddingsInterface {
  return {
    embedDocuments: async (texts) =>
      texts.map((text) => {
        if (text.includes('exact') || text.includes('stale')) return [1, 0];
        if (text.includes('near')) return [0.8, 0.6];
        return [0, 1];
      }),
    embedQuery: async () => [1, 0],
  };
}

describe('provider lifecycle integrations (explicit disposable-service opt-in)', () => {
  it.skipIf(!pgTest)(
    'normalizes PGVector scores and deletes only the selected KB, document, and revision',
    async () => {
      const provider = new PGVectorDatabaseProvider();
      const embeddings = createEmbeddings();
      const port = Number(process.env.KB_TEST_PGVECTOR_PORT);
      const tableName = `kb_test_${randomUUID().replaceAll('-', '')}`;
      const params = {
        host: '127.0.0.1',
        port,
        username: process.env.KB_TEST_PGVECTOR_USER ?? 'kb_test',
        password: process.env.KB_TEST_PGVECTOR_PASSWORD ?? '',
        database: process.env.KB_TEST_PGVECTOR_DATABASE ?? 'kb_test',
        tableName,
      };
      const knownStates = [
        { id: 'exact-doc', knowledgeBaseId: 'kb-search', activeIndexRevision: 'current' },
        { id: 'stale-doc', knowledgeBaseId: 'kb-search', activeIndexRevision: 'newer' },
        { id: 'near-doc', knowledgeBaseId: 'kb-search', activeIndexRevision: 'current' },
        { id: 'far-doc', knowledgeBaseId: 'kb-search', activeIndexRevision: 'current' },
      ];
      const plugin = {
        db: {
          getRepository: () => ({
            find: async ({ filter }: { filter: { id: { $in: string[] } } }) =>
              knownStates.filter((state) => filter.id.$in.includes(state.id)).map((state) => ({ toJSON: () => state })),
          }),
        },
      };

      try {
        const store = (await provider.createVectorStore(embeddings, params)) as unknown as TestVectorStore;
        await store.addDocuments(
          [
            {
              pageContent: 'exact current match',
              metadata: { knowledgeBaseOuterId: 'kb-search', documentId: 'exact-doc', indexRevision: 'current' },
            },
            {
              pageContent: 'stale exact match',
              metadata: { knowledgeBaseOuterId: 'kb-search', documentId: 'stale-doc', indexRevision: 'old' },
            },
            {
              pageContent: 'near match',
              metadata: { knowledgeBaseOuterId: 'kb-search', documentId: 'near-doc', indexRevision: 'current' },
            },
            {
              pageContent: 'far match',
              metadata: { knowledgeBaseOuterId: 'kb-search', documentId: 'far-doc', indexRevision: 'current' },
            },
          ],
          { ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] },
        );

        const results = await new DefaultVectorStoreService(store, 'pgvector', plugin as never).search('query', {
          topK: 2,
          score: 0.3,
        });
        expect(results.map((result) => result.metadata.documentId)).toEqual(['exact-doc', 'near-doc']);
        expect(results[0]?.score).toBeGreaterThan(0.99);
        expect(results[1]?.score).toBeGreaterThanOrEqual(0.3);

        const cleanupRevision = 'cleanup-revision';
        const cleanupDocs: TestDocument[] = [
          {
            pageContent: 'cleanup target',
            metadata: {
              knowledgeBaseOuterId: 'kb-cleanup',
              documentId: 'doc-cleanup',
              indexRevision: cleanupRevision,
              cleanupMarker: 'target',
            },
          },
          {
            pageContent: 'same document new revision',
            metadata: {
              knowledgeBaseOuterId: 'kb-cleanup',
              documentId: 'doc-cleanup',
              indexRevision: 'keep-revision',
              cleanupMarker: 'other-revision',
            },
          },
          {
            pageContent: 'same KB different document',
            metadata: {
              knowledgeBaseOuterId: 'kb-cleanup',
              documentId: 'other-document',
              indexRevision: cleanupRevision,
              cleanupMarker: 'other-document',
            },
          },
          {
            pageContent: 'different KB same document',
            metadata: {
              knowledgeBaseOuterId: 'other-kb',
              documentId: 'doc-cleanup',
              indexRevision: cleanupRevision,
              cleanupMarker: 'other-kb',
            },
          },
        ];
        await store.addDocuments(cleanupDocs, { ids: cleanupDocs.map(() => randomUUID()) });
        await deleteIndexRevision('pgvector', params, 'kb-cleanup', 'doc-cleanup', cleanupRevision);
        const remaining = await store.similaritySearchWithScore('query', 100);
        const remainingCleanupMarkers = new Set(
          remaining
            .map(([document]) => document.metadata.cleanupMarker)
            .filter((marker): marker is string => typeof marker === 'string'),
        );
        expect(remainingCleanupMarkers).toEqual(new Set(['other-revision', 'other-document', 'other-kb']));

        const legacyDocs: TestDocument[] = [
          {
            pageContent: 'legacy cleanup target',
            metadata: { knowledgeBaseOuterId: 'kb-cleanup', documentId: 'doc-legacy', cleanupMarker: 'legacy-target' },
          },
          {
            pageContent: 'revisioned row to preserve',
            metadata: {
              knowledgeBaseOuterId: 'kb-cleanup',
              documentId: 'doc-legacy',
              indexRevision: 'keep-revision',
              cleanupMarker: 'legacy-preserve',
            },
          },
        ];
        await store.addDocuments(legacyDocs, { ids: legacyDocs.map(() => randomUUID()) });
        await deleteIndexRevision('pgvector', params, 'kb-cleanup', 'doc-legacy', LEGACY_INDEX_REVISION);
        const afterLegacyCleanup = await store.similaritySearchWithScore('query', 100);
        const legacyMarkers = afterLegacyCleanup
          .map(([document]) => document.metadata.cleanupMarker)
          .filter((marker): marker is string => typeof marker === 'string');
        expect(legacyMarkers).toContain('legacy-preserve');
        expect(legacyMarkers).not.toContain('legacy-target');
        await expect(
          deleteIndexRevision('pgvector', { ...params, tableName: `${tableName}_missing` }, 'kb-1', 'doc-1', 'rev-1'),
        ).resolves.toBeUndefined();
      } finally {
        await provider.close();
        const cleanupClient = new Client({
          host: '127.0.0.1',
          port,
          user: params.username,
          password: params.password,
          database: params.database,
        });
        await cleanupClient.connect();
        try {
          await cleanupClient.query(`DROP TABLE IF EXISTS "${tableName}"`);
        } finally {
          await cleanupClient.end();
        }
      }
    },
  );

  it.skipIf(!pgTest)('resolves writer-folded, schema-qualified, and quoted PG identifiers safely', async () => {
    const port = Number(process.env.KB_TEST_PGVECTOR_PORT);
    const suffix = randomUUID().replaceAll('-', '');
    const mixedCaseName = `KbMixed${suffix}`;
    const quotedName = `KbQuoted${suffix}`;
    const schemaName = `kb_schema_${suffix}`;
    const markerName = `kb_marker_${suffix}`;
    const tableCases = [
      { inputName: mixedCaseName, sqlName: mixedCaseName },
      { inputName: `"${quotedName}"`, sqlName: `"${quotedName}"` },
      { inputName: `${schemaName}.kb_vectors`, sqlName: `"${schemaName}"."kb_vectors"` },
    ];
    const client = new Client({
      host: '127.0.0.1',
      port,
      user: process.env.KB_TEST_PGVECTOR_USER ?? 'kb_test',
      password: process.env.KB_TEST_PGVECTOR_PASSWORD ?? '',
      database: process.env.KB_TEST_PGVECTOR_DATABASE ?? 'kb_test',
    });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`CREATE TABLE "public"."${markerName}" ("id" text PRIMARY KEY, "metadata" jsonb NOT NULL)`);
      await client.query(`INSERT INTO "public"."${markerName}" ("id", "metadata") VALUES ($1, $2::jsonb)`, [
        randomUUID(),
        JSON.stringify({ intact: true }),
      ]);

      for (const tableCase of tableCases) {
        await client.query(`CREATE TABLE ${tableCase.sqlName} ("id" text PRIMARY KEY, "metadata" jsonb NOT NULL)`);
        await client.query(
          `INSERT INTO ${tableCase.sqlName} ("id", "metadata") VALUES ($1, $2::jsonb), ($3, $4::jsonb)`,
          [
            randomUUID(),
            JSON.stringify({ knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'delete-me' }),
            randomUUID(),
            JSON.stringify({ knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'keep-me' }),
          ],
        );
        await deleteIndexRevision(
          'pgvector',
          {
            host: '127.0.0.1',
            port,
            username: process.env.KB_TEST_PGVECTOR_USER ?? 'kb_test',
            password: process.env.KB_TEST_PGVECTOR_PASSWORD ?? '',
            database: process.env.KB_TEST_PGVECTOR_DATABASE ?? 'kb_test',
            tableName: tableCase.inputName,
          },
          'kb-1',
          'doc-1',
          'delete-me',
        );
        const remaining = await client.query(`SELECT count(*)::int AS count FROM ${tableCase.sqlName}`);
        expect(Number(remaining.rows[0]?.count)).toBe(1);
      }

      const injectionPayload = `${mixedCaseName}; DROP TABLE "public"."${markerName}" --`;
      await expect(
        deleteIndexRevision(
          'pgvector',
          {
            host: '127.0.0.1',
            port,
            username: process.env.KB_TEST_PGVECTOR_USER ?? 'kb_test',
            password: process.env.KB_TEST_PGVECTOR_PASSWORD ?? '',
            database: process.env.KB_TEST_PGVECTOR_DATABASE ?? 'kb_test',
            tableName: injectionPayload,
          },
          'kb-1',
          'doc-1',
          'delete-me',
        ),
      ).resolves.toBeUndefined();
      const marker = await client.query(`SELECT count(*)::int AS count FROM "public"."${markerName}"`);
      expect(Number(marker.rows[0]?.count)).toBe(1);
    } finally {
      if (connected) {
        await client.query(`DROP TABLE IF EXISTS "public"."${markerName}"`);
        for (const tableCase of tableCases) await client.query(`DROP TABLE IF EXISTS ${tableCase.sqlName}`);
        await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        await client.end();
      }
    }
  });

  it.skipIf(!pgTest)(
    'keeps PG cleanup permission failures visible while treating an absent relation as clean',
    async () => {
      const port = Number(process.env.KB_TEST_PGVECTOR_PORT);
      const suffix = randomUUID().replaceAll('-', '');
      const schemaName = `kb_auth_${suffix}`;
      const tableName = 'restricted_vectors';
      const roleName = `kb_reader_${suffix}`;
      const rolePassword = randomUUID();
      const databaseName = process.env.KB_TEST_PGVECTOR_DATABASE ?? 'kb_test';
      const username = process.env.KB_TEST_PGVECTOR_USER ?? 'kb_test';
      const password = process.env.KB_TEST_PGVECTOR_PASSWORD ?? '';
      const admin = new Client({ host: '127.0.0.1', port, user: username, password, database: databaseName });
      let connected = false;
      let roleCreated = false;
      try {
        await admin.connect();
        connected = true;
        await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}'`);
        roleCreated = true;
        await admin.query(`CREATE SCHEMA "${schemaName}"`);
        await admin.query(
          `CREATE TABLE "${schemaName}"."${tableName}" ("id" text PRIMARY KEY, "metadata" jsonb NOT NULL)`,
        );
        await admin.query(`INSERT INTO "${schemaName}"."${tableName}" ("id", "metadata") VALUES ($1, $2::jsonb)`, [
          randomUUID(),
          JSON.stringify({ knowledgeBaseOuterId: 'kb-1', documentId: 'doc-1', indexRevision: 'rev-1' }),
        ]);
        await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
        await admin.query(`GRANT SELECT ON TABLE "${schemaName}"."${tableName}" TO "${roleName}"`);

        await expect(
          deleteIndexRevision(
            'pgvector',
            {
              host: '127.0.0.1',
              port,
              username: roleName,
              password: rolePassword,
              database: databaseName,
              tableName: `${schemaName}.${tableName}`,
            },
            'kb-1',
            'doc-1',
            'rev-1',
          ),
        ).rejects.toMatchObject({ code: '42501' });

        const remaining = await admin.query(`SELECT count(*)::int AS count FROM "${schemaName}"."${tableName}"`);
        expect(Number(remaining.rows[0]?.count)).toBe(1);
        await expect(
          deleteIndexRevision(
            'pgvector',
            {
              host: '127.0.0.1',
              port,
              username,
              password,
              database: databaseName,
              tableName: `${schemaName}.missing_vectors`,
            },
            'kb-1',
            'doc-1',
            'rev-1',
          ),
        ).resolves.toBeUndefined();
      } finally {
        if (connected) {
          await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
          if (roleCreated) await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
          await admin.end();
        }
      }
    },
  );

  it.skipIf(!qdrantTest)(
    'deletes only the selected Qdrant revision and treats missing revisions as legacy',
    async () => {
      const url = process.env.KB_TEST_QDRANT_URL;
      if (!url) throw new Error('Qdrant integration URL is required');
      const client = new QdrantClient({ url });
      const collectionName = `kb_test_${randomUUID().replaceAll('-', '')}`;
      await client.createCollection(collectionName, { vectors: { size: 2, distance: 'Cosine' } });

      const points = [
        {
          id: randomUUID(),
          vector: [1, 0],
          payload: {
            metadata: { knowledgeBaseOuterId: 'kb-cleanup', documentId: 'doc-cleanup', indexRevision: 'delete-me' },
          },
        },
        {
          id: randomUUID(),
          vector: [0.8, 0.6],
          payload: {
            metadata: { knowledgeBaseOuterId: 'kb-cleanup', documentId: 'doc-cleanup', indexRevision: 'keep-revision' },
          },
        },
        {
          id: randomUUID(),
          vector: [0, 1],
          payload: {
            metadata: { knowledgeBaseOuterId: 'kb-cleanup', documentId: 'other-document', indexRevision: 'delete-me' },
          },
        },
        {
          id: randomUUID(),
          vector: [0, 1],
          payload: {
            metadata: { knowledgeBaseOuterId: 'other-kb', documentId: 'doc-cleanup', indexRevision: 'delete-me' },
          },
        },
        {
          id: randomUUID(),
          vector: [0, 1],
          payload: { metadata: { knowledgeBaseOuterId: 'kb-cleanup', documentId: 'legacy-doc' } },
        },
        {
          id: randomUUID(),
          vector: [0, 1],
          payload: {
            metadata: { knowledgeBaseOuterId: 'kb-cleanup', documentId: 'legacy-doc', indexRevision: 'keep-revision' },
          },
        },
      ];
      try {
        await client.upsert(collectionName, { wait: true, points });
        const params = { url, collectionName };
        await deleteIndexRevision('qdrant', params, 'kb-cleanup', 'doc-cleanup', 'delete-me');
        await deleteIndexRevision('qdrant', params, 'kb-cleanup', 'legacy-doc', LEGACY_INDEX_REVISION);

        const scroll = await client.scroll(collectionName, { limit: 100, with_payload: true, with_vector: false });
        const metadata = scroll.points.map((point) => point.payload?.metadata as Record<string, unknown> | undefined);
        expect(metadata).not.toContainEqual(
          expect.objectContaining({
            knowledgeBaseOuterId: 'kb-cleanup',
            documentId: 'doc-cleanup',
            indexRevision: 'delete-me',
          }),
        );
        expect(metadata).toContainEqual(
          expect.objectContaining({
            knowledgeBaseOuterId: 'kb-cleanup',
            documentId: 'doc-cleanup',
            indexRevision: 'keep-revision',
          }),
        );
        expect(metadata).toContainEqual(
          expect.objectContaining({
            knowledgeBaseOuterId: 'kb-cleanup',
            documentId: 'other-document',
            indexRevision: 'delete-me',
          }),
        );
        expect(metadata).toContainEqual(
          expect.objectContaining({
            knowledgeBaseOuterId: 'other-kb',
            documentId: 'doc-cleanup',
            indexRevision: 'delete-me',
          }),
        );
        const remainingLegacyPoints = metadata.filter(
          (point) => point?.knowledgeBaseOuterId === 'kb-cleanup' && point.documentId === 'legacy-doc',
        );
        expect(remainingLegacyPoints).toHaveLength(1);
        expect(remainingLegacyPoints[0]?.indexRevision).toBe('keep-revision');
        await client.deleteCollection(collectionName);
        await expect(
          deleteIndexRevision('qdrant', { url, collectionName }, 'kb-cleanup', 'missing-doc', 'old-revision'),
        ).resolves.toBeUndefined();
      } finally {
        const exists = await client.collectionExists(collectionName);
        if (exists.exists) await client.deleteCollection(collectionName);
      }
    },
  );
});
