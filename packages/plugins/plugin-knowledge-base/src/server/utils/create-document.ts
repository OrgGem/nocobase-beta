// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import type { Database } from '@nocobase/database';
import type { Transaction } from 'sequelize';
import { canManageKnowledgeBase, type KbAccessContext } from './access';
import { findOwnedAiFile } from './file-access';
import { NEVER_INDEXED_TOKEN } from '../services/index-lifecycle';

export async function lockVectorStore(db: Database, vectorStoreId: unknown, transaction: Transaction): Promise<void> {
  if (vectorStoreId == null) return;
  const store = await db.getRepository('aiVectorStores').collection.model.findOne({
    where: { id: vectorStoreId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!store) throw new Error('Vector store not found');
  const vectorDatabaseId = store.get('vectorDatabaseId');
  if (vectorDatabaseId == null) throw new Error('Vector database not found');
  const database = await db.getRepository('aiVectorDatabases').collection.model.findOne({
    where: { id: vectorDatabaseId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!database) throw new Error('Vector database not found');
}

/** Create a new document while the KB and its physical storage mapping remain locked. */
export async function createStoredKnowledgeBaseDocument(
  db: Database,
  values: Record<string, unknown>,
  authorize?: (knowledgeBase: Record<string, unknown>) => Promise<void>,
  beforeInsert?: (transaction: Transaction) => Promise<void>,
) {
  const kbRepo = db.getRepository('aiKnowledgeBases');
  const docRepo = db.getRepository('aiKnowledgeBaseDocuments');
  return db.sequelize.transaction(async (transaction) => {
    const kb = await kbRepo.collection.model.findOne({
      where: { id: values.knowledgeBaseId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!kb) throw new Error('Knowledge base not found');
    const kbData = kb.toJSON();
    if (authorize) await authorize(kbData);
    await lockVectorStore(db, kbData.vectorStoreId, transaction);
    if (beforeInsert) await beforeInsert(transaction);
    const doc = await docRepo.create({ values: { ...values, indexWorkerToken: NEVER_INDEXED_TOKEN }, transaction });
    const fkUpdates = {
      knowledgeBaseId: values.knowledgeBaseId,
      ...(values.fileId != null ? { fileId: values.fileId } : {}),
    };
    await docRepo.update({ filterByTk: doc.get('id'), values: fkUpdates, transaction });
    for (const [key, value] of Object.entries(fkUpdates)) doc.set(key, value);
    return doc;
  });
}

/** Keep the parent KB locked until both the document and its foreign keys commit. */
export async function createKnowledgeBaseDocument(
  ctx: Context,
  values: Record<string, unknown>,
  access: KbAccessContext,
) {
  return createStoredKnowledgeBaseDocument(
    ctx.db,
    values,
    async (kbData) => {
      if (!canManageKnowledgeBase(access, kbData)) ctx.throw(403, 'Access denied');
      if (kbData.type === 'EXTERNAL_RAG') {
        ctx.throw(400, 'Cannot upload documents to an external RAG knowledge base');
      }
    },
    async (transaction) => {
      if (values.fileId != null) await findOwnedAiFile(ctx, values.fileId, transaction);
    },
  );
}
