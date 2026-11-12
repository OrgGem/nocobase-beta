// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'crypto';
import type { Transaction } from 'sequelize';
import { Client } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import type PluginKnowledgeBaseServer from '../plugin';
import { KnowledgeSearchService } from './knowledge-search';

export const LEGACY_INDEX_REVISION = '__legacy__';
export const NEVER_INDEXED_TOKEN = '__never_indexed__';

type IndexState = {
  id: string;
  knowledgeBaseId: string;
  indexRevision?: string | null;
  activeIndexRevision?: string | null;
  indexWorkerToken?: string | null;
  indexWorkerStartedAt?: Date | string | null;
  indexDeleted?: boolean | null;
  retiredIndexRevisions?: string[] | null;
  indexCleanupCursor?: number | null;
  status?: string;
  fileId?: string | number | null;
  uploadedById?: string | number | null;
  updatedAt?: Date | string | null;
  retryCount?: number | null;
  indexCleanupRoute?: CleanupRoute | null;
  indexCleanupPending?: boolean | null;
  indexCleanupProgress?: number | null;
  chunkCount?: number | null;
};

type CleanupRoute = {
  knowledgeBaseId: string;
  vectorDatabaseId: string;
  provider: string;
  collectionName: string;
  endpointFingerprint: string;
};

type VectorDatabaseSnapshot = { id: string; provider: string; connectParams: Record<string, unknown> };
type VectorStoreSnapshot = Record<string, unknown> & { vectorDatabase: VectorDatabaseSnapshot };
export type IndexAttempt = { revision: string; token: string; vectorStore: VectorStoreSnapshot };

export function endpointFingerprint(provider: string, params: Record<string, unknown>): string {
  let endpoint: unknown[];
  if (provider === 'pgvector') {
    endpoint = [params.host, params.port, params.database];
  } else if (provider === 'qdrant') {
    const url = new URL(String(params.url));
    endpoint = [url.origin, url.pathname];
  } else {
    endpoint = [provider];
  }
  return createHash('sha256').update(JSON.stringify(endpoint)).digest('hex');
}

function retired(state: IndexState, ...revisions: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set([
      ...(Array.isArray(state.retiredIndexRevisions) ? state.retiredIndexRevisions : []),
      ...revisions.filter(Boolean),
    ]),
  ) as string[];
}

function tombstoneValues(state: IndexState, route: CleanupRoute | null): Record<string, unknown> {
  const neverIndexed =
    state.indexWorkerToken === NEVER_INDEXED_TOKEN &&
    !state.indexRevision &&
    !state.activeIndexRevision &&
    !state.retiredIndexRevisions?.length &&
    Number(state.chunkCount ?? 0) === 0;
  const revisions = neverIndexed
    ? []
    : retired(state, state.indexRevision, state.activeIndexRevision ?? LEGACY_INDEX_REVISION);
  return {
    indexDeleted: true,
    status: 'deleted',
    indexWorkerToken: null,
    indexWorkerStartedAt: null,
    retiredIndexRevisions: revisions,
    indexCleanupNeeded: Boolean(revisions.length && route),
    indexCleanupPending: revisions.length > 0,
    indexCleanupProgress: 0,
    indexCleanupRoute: route,
    ...(revisions.length && !route
      ? { error: 'Vector cleanup requires manual investigation: original route unavailable' }
      : {}),
  };
}

/** SQL state is the authority for activation; vector writes never activate themselves. */
export class IndexLifecycleService {
  constructor(private plugin: PluginKnowledgeBaseServer) {}

  private async withDocument<T>(
    id: string,
    fn: (
      state: IndexState,
      update: (values: Record<string, unknown>) => Promise<void>,
      transaction: Transaction,
    ) => Promise<T>,
  ): Promise<T | null> {
    const model = this.plugin.db.getRepository('aiKnowledgeBaseDocuments').collection.model;
    return this.plugin.db.sequelize.transaction(async (transaction) => {
      const row = await model.findOne({ where: { id }, transaction, lock: transaction.LOCK.UPDATE });
      if (!row) return null;
      const state = row.get({ plain: true }) as IndexState;
      return fn(
        state,
        async (values) => {
          await row.update(values, { transaction });
        },
        transaction,
      );
    });
  }

  private async lockStorage(vectorStoreId: unknown, transaction: Transaction): Promise<VectorStoreSnapshot | null> {
    if (vectorStoreId == null) return null;
    const store = await this.plugin.db.getRepository('aiVectorStores').collection.model.findOne({
      where: { id: vectorStoreId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const databaseId = store?.get('vectorDatabaseId');
    if (databaseId == null) return null;
    const dbRow = await this.plugin.db.getRepository('aiVectorDatabases').collection.model.findOne({
      where: { id: databaseId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const database = dbRow?.get({ plain: true }) as VectorDatabaseSnapshot | undefined;
    if (!database?.id || !database.provider || !database.connectParams) return null;
    return { ...store.get({ plain: true }), vectorDatabase: database };
  }

  private cleanupRoute(knowledgeBaseId: string, store: VectorStoreSnapshot | null): CleanupRoute | null {
    const database = store?.vectorDatabase;
    if (!database) return null;
    const params = database.connectParams;
    const collectionName = String(
      database.provider === 'pgvector' ? params.tableName ?? '' : params.collectionName ?? '',
    );
    if (!collectionName) return null;
    let fingerprint: string;
    try {
      fingerprint = endpointFingerprint(database.provider, params);
    } catch {
      return null;
    }
    return {
      knowledgeBaseId: String(knowledgeBaseId),
      vectorDatabaseId: String(database.id),
      provider: String(database.provider),
      collectionName,
      endpointFingerprint: fingerprint,
    };
  }

  private async withStoredDocument<T>(
    id: string,
    fn: (
      state: IndexState,
      update: (values: Record<string, unknown>) => Promise<void>,
      store: VectorStoreSnapshot | null,
    ) => Promise<T>,
  ): Promise<T | null> {
    const docModel = this.plugin.db.getRepository('aiKnowledgeBaseDocuments').collection.model;
    const initial = await docModel.findOne({ where: { id }, attributes: ['knowledgeBaseId'] });
    const knowledgeBaseId = initial?.get('knowledgeBaseId');
    if (!knowledgeBaseId) return null;
    return this.plugin.db.sequelize.transaction(async (transaction) => {
      const kb = await this.plugin.db.getRepository('aiKnowledgeBases').collection.model.findOne({
        where: { id: knowledgeBaseId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!kb) return null;
      const store = await this.lockStorage(kb.get('vectorStoreId'), transaction);
      const row = await docModel.findOne({ where: { id }, transaction, lock: transaction.LOCK.UPDATE });
      const state = row?.get({ plain: true }) as IndexState | undefined;
      if (!state || String(state.knowledgeBaseId) !== String(knowledgeBaseId)) return null;
      return fn(
        state,
        async (values) => {
          await row.update(values, { transaction });
        },
        store,
      );
    });
  }

  async requestReprocess(id: string, values: Record<string, unknown> = {}): Promise<string | null> {
    const result = await this.withStoredDocument(String(id), async (state, update, store) => {
      if (state.indexDeleted) throw new Error('Document is deleted');
      if (!store) {
        const running = state.indexWorkerToken && state.indexWorkerToken !== NEVER_INDEXED_TOKEN;
        const orphaned = running && state.indexRevision !== state.activeIndexRevision ? state.indexRevision : null;
        await update({
          ...values,
          status: 'pending',
          error: null,
          retryCount: values.retryCount ?? 0,
          ...(running
            ? {
                indexWorkerToken: null,
                indexWorkerStartedAt: null,
                indexRevision: null,
                retiredIndexRevisions: retired(state, orphaned),
                ...(orphaned ? { indexCleanupNeeded: false, indexCleanupPending: true, indexCleanupProgress: 0 } : {}),
              }
            : {}),
        });
        return { revision: null };
      }
      const revision = randomUUID();
      const oldPending = state.indexRevision !== state.activeIndexRevision ? state.indexRevision : null;
      const revisions = retired(state, oldPending);
      await update({
        ...values,
        indexRevision: revision,
        indexWorkerToken: state.indexWorkerToken === NEVER_INDEXED_TOKEN ? NEVER_INDEXED_TOKEN : null,
        indexWorkerStartedAt: null,
        status: 'pending',
        error: null,
        retryCount: values.retryCount ?? 0,
        retiredIndexRevisions: revisions,
        indexCleanupNeeded: revisions.length > 0,
        ...(oldPending ? { indexCleanupPending: true, indexCleanupProgress: 0 } : {}),
      });
      return { revision };
    });
    if (!result) throw new Error('Document not found');
    return result.revision;
  }

  async markDeleted(id: string): Promise<void> {
    const result = await this.withStoredDocument(String(id), async (state, update, store) => {
      if (state.indexDeleted) return true;
      const route = this.cleanupRoute(String(state.knowledgeBaseId), store);
      await update(tombstoneValues(state, route));
      KnowledgeSearchService.invalidateKnowledgeBase(String(state.knowledgeBaseId));
      return true;
    });
    if (!result) throw new Error('Document not found');
  }

  /** Detach durable tombstones before deleting their parent KB, in one SQL transaction. */
  async destroyKnowledgeBase(id: string, authorize: (kb: Record<string, unknown>) => boolean): Promise<void> {
    const kbRepo = this.plugin.db.getRepository('aiKnowledgeBases');
    const docModel = this.plugin.db.getRepository('aiKnowledgeBaseDocuments').collection.model;
    await this.plugin.db.sequelize.transaction(async (transaction) => {
      const kb = await kbRepo.collection.model.findOne({ where: { id }, transaction, lock: transaction.LOCK.UPDATE });
      if (!kb) throw new Error('Knowledge base not found');
      if (!authorize(kb.get({ plain: true }) as Record<string, unknown>)) {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      }
      const store = await this.lockStorage(kb.get('vectorStoreId'), transaction);
      const docs = await docModel.findAll({
        where: { knowledgeBaseId: id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const needsRoute = docs.some((row) => !row.get('indexDeleted'));
      const route = needsRoute ? this.cleanupRoute(id, store) : null;
      for (const row of docs) {
        const state = row.get({ plain: true }) as IndexState;
        await row.update(
          {
            ...(!state.indexDeleted ? tombstoneValues(state, route) : {}),
            knowledgeBaseId: null,
          },
          { transaction },
        );
      }
      await kbRepo.destroy({ filterByTk: id, transaction });
    });
    KnowledgeSearchService.invalidateKnowledgeBase(String(id));
  }

  async begin(id: string): Promise<IndexAttempt | null> {
    return this.withStoredDocument(String(id), async (state, update, store) => {
      if (!store || state.indexDeleted || state.status === 'success' || state.status === 'processing') return null;
      const revision = state.indexRevision ?? randomUUID();
      const token = randomUUID();
      await update({
        indexRevision: revision,
        indexWorkerToken: token,
        indexWorkerStartedAt: new Date(),
        status: 'processing',
      });
      return { revision, token, vectorStore: store };
    });
  }

  async recoverAbandoned(id: string, cutoff: Date): Promise<boolean> {
    return Boolean(
      await this.withStoredDocument(String(id), async (state, update, store) => {
        if (!store) return false;
        const startedAt = state.indexWorkerStartedAt ?? state.updatedAt;
        const updated = startedAt ? new Date(startedAt).getTime() : Number.NaN;
        if (
          state.indexDeleted ||
          state.status !== 'processing' ||
          !Number.isFinite(updated) ||
          updated >= cutoff.getTime()
        )
          return false;
        const previous = state.indexRevision !== state.activeIndexRevision ? state.indexRevision : null;
        const revisions = retired(state, previous);
        await update({
          indexRevision: randomUUID(),
          indexWorkerToken: null,
          indexWorkerStartedAt: null,
          status: 'pending',
          retiredIndexRevisions: revisions,
          indexCleanupNeeded: revisions.length > 0,
          ...(previous ? { indexCleanupPending: true, indexCleanupProgress: 0 } : {}),
        });
        return true;
      }),
    );
  }

  async activate(id: string, revision: string, token: string, values: Record<string, unknown>): Promise<boolean> {
    return Boolean(
      await this.withDocument(String(id), async (state, update) => {
        if (state.indexDeleted || state.indexRevision !== revision || state.indexWorkerToken !== token) return false;
        const revisions = retired(state, state.activeIndexRevision ?? LEGACY_INDEX_REVISION);
        await update({
          ...values,
          activeIndexRevision: revision,
          indexWorkerToken: null,
          indexWorkerStartedAt: null,
          retiredIndexRevisions: revisions,
          indexCleanupNeeded: true,
          indexCleanupPending: true,
          indexCleanupProgress: 0,
          status: 'success',
          error: null,
        });
        KnowledgeSearchService.invalidateKnowledgeBase(String(state.knowledgeBaseId));
        return true;
      }),
    );
  }

  async fail(id: string, revision: string, token: string, error: string): Promise<void> {
    await this.withDocument(String(id), async (state, update) => {
      if (state.indexDeleted || state.indexRevision !== revision || state.indexWorkerToken !== token) return;
      const revisions = retired(state, revision);
      const record = state as IndexState & { retryCount?: number };
      await update({
        indexRevision: null,
        indexWorkerToken: null,
        indexWorkerStartedAt: null,
        status: 'failed',
        error,
        retryCount: Number(record.retryCount ?? 0) + 1,
        retiredIndexRevisions: revisions,
        indexCleanupNeeded: true,
        indexCleanupPending: true,
        indexCleanupProgress: 0,
      });
    });
  }

  async deleteOwnedSourceFile(id: string, revision: string): Promise<boolean> {
    const docRepo = this.plugin.db.getRepository('aiKnowledgeBaseDocuments');
    const initial = await docRepo.collection.model.findOne({ where: { id }, attributes: ['knowledgeBaseId'] });
    const knowledgeBaseId = initial?.get('knowledgeBaseId');
    if (!knowledgeBaseId) return false;
    return this.plugin.db.sequelize.transaction(async (transaction) => {
      // Match the KB -> document -> file lock order used by KB deletion and document creation.
      const kb = await this.plugin.db.getRepository('aiKnowledgeBases').collection.model.findOne({
        where: { id: knowledgeBaseId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!kb?.get('deleteSourceFile')) return false;
      const row = await docRepo.collection.model.findOne({ where: { id }, transaction, lock: transaction.LOCK.UPDATE });
      const state = row?.get({ plain: true }) as IndexState | undefined;
      if (
        !state ||
        String(state.knowledgeBaseId) !== String(knowledgeBaseId) ||
        state.indexDeleted ||
        state.indexRevision !== revision ||
        state.activeIndexRevision !== revision ||
        !state.fileId ||
        !state.uploadedById
      )
        return false;
      const fileRepo = this.plugin.db.getRepository('aiFiles');
      const file = await fileRepo.collection.model.findOne({
        where: { id: state.fileId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!file || String(file.get('createdById') ?? '') !== String(state.uploadedById)) return false;
      const refs = await docRepo.collection.model.findAll({ where: { fileId: state.fileId }, transaction });
      if (refs.some((ref) => String(ref.get('id')) !== String(id) && !ref.get('indexDeleted'))) return false;
      await row.update({ fileId: null }, { transaction });
      // File manager's afterDestroy hook invokes the configured storage adapter.
      await fileRepo.destroy({ filterByTk: state.fileId, transaction });
      return true;
    });
  }

  /** Revisit retired revisions: a worker that was paused during cleanup can still write later. */
  async sweep(limit = 10): Promise<void> {
    const repo = this.plugin.db.getRepository('aiKnowledgeBaseDocuments');
    const records = await repo.find({
      filter: { indexCleanupNeeded: true },
      sort: ['indexCleanupAt', 'id'],
      limit,
      appends: ['knowledgeBase', 'knowledgeBase.vectorStore', 'knowledgeBase.vectorStore.vectorDatabase'],
    });
    for (const record of records) {
      const doc = record.toJSON();
      const revisions: string[] = Array.isArray(doc.retiredIndexRevisions) ? doc.retiredIndexRevisions : [];
      const cursor = Math.max(0, Number(doc.indexCleanupCursor) || 0);
      let succeeded = false;
      try {
        if (revisions.length) {
          const route = doc.indexCleanupRoute as CleanupRoute | null;
          const vectorDatabase = route
            ? (
                await this.plugin.db
                  .getRepository('aiVectorDatabases')
                  .findOne({ filter: { id: route.vectorDatabaseId } })
              )?.toJSON()
            : doc.knowledgeBase?.vectorStore?.vectorDatabase;
          if (!vectorDatabase) throw new Error('Vector database configuration is unavailable');
          const params = { ...vectorDatabase.connectParams } as Record<string, unknown>;
          if (route) {
            if (
              route.provider !== vectorDatabase.provider ||
              route.endpointFingerprint !== endpointFingerprint(route.provider, params)
            )
              throw new Error('Vector database endpoint changed since deletion');
            params[route.provider === 'pgvector' ? 'tableName' : 'collectionName'] = route.collectionName;
          }
          await deleteIndexRevision(
            vectorDatabase.provider,
            params,
            route?.knowledgeBaseId ?? String(doc.knowledgeBaseId),
            String(doc.id),
            revisions[cursor % revisions.length],
          );
        }
        succeeded = true;
      } catch (error) {
        this.plugin.app.logger.warn(`[KnowledgeBase] Index cleanup failed for document ${doc.id}; it will be retried.`);
      } finally {
        await this.withDocument(String(doc.id), async (state, update) => {
          const currentRevisions = Array.isArray(state.retiredIndexRevisions) ? state.retiredIndexRevisions : [];
          const unchanged = JSON.stringify(currentRevisions) === JSON.stringify(revisions);
          const wasPending = Boolean(state.indexCleanupPending);
          const progress = wasPending && succeeded && unchanged ? Number(state.indexCleanupProgress ?? 0) + 1 : 0;
          await update({
            indexCleanupAt: new Date(),
            indexCleanupCursor: cursor + 1,
            ...(wasPending && unchanged
              ? {
                  indexCleanupProgress: progress,
                  indexCleanupPending: !succeeded || progress < currentRevisions.length,
                }
              : {}),
          });
        });
      }
    }
  }
}

/** Delete only one explicitly retired revision, within a single KB and document. */
export async function deleteIndexRevision(
  provider: string,
  params: Record<string, unknown>,
  kbId: string,
  documentId: string,
  revision: string,
): Promise<void> {
  if (!kbId || !documentId || !revision) throw new Error('Index cleanup requires KB, document and revision');
  if (provider === 'pgvector') {
    const table = String(params.tableName ?? '');
    if (!table) throw new Error('PostgreSQL vector table is required');
    const client = new Client({
      host: String(params.host),
      port: Number(params.port),
      user: String(params.username),
      password: String(params.password),
      database: String(params.database),
      connectionTimeoutMillis: 10000,
    });
    try {
      await client.connect();
      // Resolve exactly as the writer's unquoted SQL does, including schema and quoted names.
      const resolved = await client.query(
        `SELECT n.nspname, c.relname, c.relkind FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = pg_catalog.to_regclass($1)`,
        [table],
      );
      const target = resolved.rows[0];
      if (!target) return;
      if (!target.nspname || !target.relname || !['r', 'p'].includes(target.relkind)) {
        throw new Error('PostgreSQL vector target is not a table');
      }
      const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
      const resolvedTable = `${quote(target.nspname)}.${quote(target.relname)}`;
      const revisionPredicate =
        revision === LEGACY_INDEX_REVISION
          ? `"metadata"->>'indexRevision' IS NULL`
          : `"metadata"->>'indexRevision' = $3`;
      const bindings = revision === LEGACY_INDEX_REVISION ? [kbId, documentId] : [kbId, documentId, revision];
      await client.query(
        `DELETE FROM ${resolvedTable} WHERE "metadata"->>'knowledgeBaseOuterId' = $1 AND "metadata"->>'documentId' = $2 AND ${revisionPredicate}`,
        bindings,
      );
    } finally {
      await client.end();
    }
    return;
  }
  if (provider === 'qdrant') {
    const collection = String(params.collectionName ?? '');
    if (!collection) throw new Error('Qdrant collection is required');
    const client = new QdrantClient({
      url: String(params.url),
      apiKey: typeof params.apiKey === 'string' ? params.apiKey : undefined,
    });
    const revisionCondition =
      revision === LEGACY_INDEX_REVISION
        ? { is_empty: { key: 'metadata.indexRevision' } }
        : { key: 'metadata.indexRevision', match: { value: revision } };
    try {
      await client.delete(collection, {
        wait: true,
        filter: {
          must: [
            { key: 'metadata.knowledgeBaseOuterId', match: { value: kbId } },
            { key: 'metadata.documentId', match: { value: documentId } },
            revisionCondition,
          ],
        },
      });
    } catch (error) {
      // A 404 alone can come from a proxy or an unsupported endpoint. Confirm the collection is absent.
      if (error instanceof Error && 'status' in error && error.status === 404) {
        const result = await client.collectionExists(collection);
        if (result.exists === false) return;
      }
      throw error;
    }
    return;
  }
  throw new Error(`Unsupported vector cleanup provider: ${provider}`);
}
