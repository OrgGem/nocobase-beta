/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';

function normalizeSingleValue(value: any): any {
  return Array.isArray(value) ? value[0] : value;
}

const LEGACY_VECTOR_STORE_FIELDS = ['embedding' + 'Provider', 'local' + 'EmbedModelId', 'local' + 'EmbedDtype'];

async function validateVectorStoreValues(ctx: Context, values: any, existing?: any) {
  const effective = {
    ...(existing?.toJSON ? existing.toJSON() : existing ?? {}),
    ...values,
  };

  for (const field of LEGACY_VECTOR_STORE_FIELDS) {
    delete values[field];
  }

  values.llmService = normalizeSingleValue(effective.llmService);
  values.embeddingModel = normalizeSingleValue(effective.embeddingModel);

  if (!effective.vectorDatabaseId) {
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

      ctx.body = await repo.find({
        filter,
        fields,
        sort: sort ?? ['-createdAt'],
        limit: pageSize,
        offset: page ? (page - 1) * (pageSize || 20) : 0,
        appends: ['vectorDatabase'],
      });

      await next();
    },

    async get(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiVectorStores');

      ctx.body = await repo.findOne({
        filterByTk,
        appends: ['vectorDatabase'],
      });

      await next();
    },

    async create(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
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

      ctx.body = record;
      await next();
    },

    async update(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const repo = ctx.db.getRepository('aiVectorStores');

      const existing = await repo.findOne({ filterByTk });
      if (!existing) {
        ctx.throw(404, 'Vector store not found');
        return;
      }
      await validateVectorStoreValues(ctx, values, existing);

      ctx.body = await repo.update({
        filterByTk,
        values,
      });

      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiVectorStores');

      await repo.destroy({ filterByTk });
      ctx.body = { success: true };

      await next();
    },
  },
};
