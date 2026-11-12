// SPDX-License-Identifier: Apache-2.0

import { Context } from '@nocobase/actions';
import { requireRecordId } from '../utils/record-id';
import type { Transaction } from 'sequelize';
import { pickAllowedValues, serializeVectorStore } from '../utils/credentials';

const WRITABLE_VECTOR_STORE_FIELDS = ['name', 'vectorDatabaseId', 'llmService', 'embeddingModel', 'options', 'enabled'];
const STORAGE_IN_USE_ERROR =
  'Vector database storage location is in use; create a new vector database and migrate documents first';

async function vectorStoreInUse(ctx: Context, vectorStoreId: string, transaction: Transaction): Promise<boolean> {
  const docs = await ctx.db.getRepository('aiKnowledgeBaseDocuments').find({
    filter: { $or: [{ indexDeleted: { $isFalsy: true } }, { indexCleanupPending: true }] },
    appends: ['knowledgeBase'],
    transaction,
  });
  return docs.some((doc) => String(doc.toJSON().knowledgeBase?.vectorStoreId ?? '') === vectorStoreId);
}

function normalizeSingleValue(value: any): any {
  return Array.isArray(value) ? value[0] : value;
}

const LEGACY_VECTOR_STORE_FIELDS = ['embedding' + 'Provider', 'local' + 'EmbedModelId', 'local' + 'EmbedDtype'];

async function validateVectorStoreValues(ctx: Context, values: any, existing?: any) {
  if (values.vectorDatabaseId != null) values.vectorDatabaseId = requireRecordId(ctx, values.vectorDatabaseId);
  const effective = {
    ...(existing?.toJSON ? existing.toJSON() : existing ?? {}),
    ...values,
  };

  for (const field of LEGACY_VECTOR_STORE_FIELDS) {
    delete values[field];
  }

  values.llmService = normalizeSingleValue(effective.llmService);
  values.embeddingModel = normalizeSingleValue(effective.embeddingModel);

  if (
    !effective.vectorDatabaseId ||
    (typeof effective.vectorDatabaseId !== 'string' && typeof effective.vectorDatabaseId !== 'number')
  ) {
    ctx.throw(400, 'vectorDatabaseId is required');
    return;
  }
  if (!values.llmService) {
    ctx.throw(400, 'llmService is required');
    return;
  }
  if (!values.embeddingModel) {
    ctx.throw(400, 'embeddingModel is required');
    return;
  }

  const vectorDatabase = await ctx.db.getRepository('aiVectorDatabases').findOne({
    filter: { id: effective.vectorDatabaseId },
  });
  if (!vectorDatabase) {
    ctx.throw(400, `Vector database "${effective.vectorDatabaseId}" not found`);
    return;
  }

  const llmService = await ctx.db.getRepository('llmServices').findOne({
    filter: { name: values.llmService },
  });
  if (!llmService) {
    ctx.throw(400, `LLM service "${values.llmService}" not found`);
    return;
  }
  if (llmService.enabled === false || llmService.get?.('enabled') === false) {
    ctx.throw(400, `LLM service "${values.llmService}" is disabled`);
    return;
  }

  const providerName = llmService.provider ?? llmService.get?.('provider');
  const aiPlugin = ctx.app.pm.get('ai') as any;
  const providerMeta = aiPlugin?.aiManager?.llmProviders?.get(providerName);
  if (!providerMeta?.embedding) {
    ctx.throw(400, `LLM service provider "${providerName}" does not support embeddings`);
  }
}

export default {
  name: 'aiVectorStore',
  actions: {
    async list(ctx: Context, next: Function) {
      const { filter, fields, sort, page, pageSize } = ctx.action.params;
      const repo = ctx.db.getRepository('aiVectorStores');

      const records = await repo.find({
        filter,
        fields,
        sort: sort ?? ['-createdAt'],
        limit: pageSize,
        offset: page ? (page - 1) * (pageSize || 20) : 0,
        appends: ['vectorDatabase'],
      });
      ctx.body = serializeVectorStore(records);

      await next();
    },

    async get(ctx: Context, next: Function) {
      const filterByTk = requireRecordId(ctx, ctx.action.params.filterByTk);
      const repo = ctx.db.getRepository('aiVectorStores');

      const record = await repo.findOne({
        filterByTk,
        appends: ['vectorDatabase'],
      });
      ctx.body = serializeVectorStore(record);

      await next();
    },

    async create(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = pickAllowedValues(rawValues.values || rawValues, WRITABLE_VECTOR_STORE_FIELDS);
      const repo = ctx.db.getRepository('aiVectorStores');

      await validateVectorStoreValues(ctx, values);
      const record = await repo.create({ values });

      // NocoBase repository strips belongsTo FK fields on custom resources.
      // Use a targeted repo.update() to persist the FK after creation.
      if (values.vectorDatabaseId) {
        await repo.update({
          filterByTk: record.get('id'),
          values: { vectorDatabaseId: values.vectorDatabaseId },
        });
      }

      ctx.body = serializeVectorStore(record);
      await next();
    },

    async update(ctx: Context, next: Function) {
      const filterByTk = requireRecordId(ctx, ctx.action.params.filterByTk);
      const rawValues = ctx.action.params.values || {};
      const values = pickAllowedValues(rawValues.values || rawValues, WRITABLE_VECTOR_STORE_FIELDS);
      const repo = ctx.db.getRepository('aiVectorStores');

      const updated = await ctx.db.sequelize.transaction(async (transaction) => {
        const existing = await repo.collection.model.findOne({
          where: { id: filterByTk },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!existing) ctx.throw(404, 'Vector store not found');
        const previous = existing.toJSON();
        if (
          'vectorDatabaseId' in values &&
          String(values.vectorDatabaseId ?? '') !== String(previous.vectorDatabaseId ?? '') &&
          (await vectorStoreInUse(ctx, String(filterByTk), transaction))
        ) {
          ctx.throw(409, ctx.t(STORAGE_IN_USE_ERROR, { ns: 'plugin-knowledge-base' }));
        }
        await validateVectorStoreValues(ctx, values, existing);
        return repo.update({ filterByTk, values, transaction });
      });
      ctx.body = serializeVectorStore(updated);

      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const filterByTk = requireRecordId(ctx, ctx.action.params.filterByTk);
      const repo = ctx.db.getRepository('aiVectorStores');

      await ctx.db.sequelize.transaction(async (transaction) => {
        await repo.collection.model.findOne({ where: { id: filterByTk }, transaction, lock: transaction.LOCK.UPDATE });
        if (await vectorStoreInUse(ctx, String(filterByTk), transaction)) {
          ctx.throw(409, ctx.t(STORAGE_IN_USE_ERROR, { ns: 'plugin-knowledge-base' }));
        }
        await repo.destroy({ filterByTk, transaction });
      });
      ctx.body = { success: true };

      await next();
    },
  },
};
