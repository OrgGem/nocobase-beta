/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Client } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Context } from '@nocobase/actions';

export default {
  name: 'aiVectorDatabase',
  actions: {
    async list(ctx: Context, next: Function) {
      const { filter, fields, sort, page, pageSize } = ctx.action.params;
      const repo = ctx.db.getRepository('aiVectorDatabases');

      const records = await repo.find({
        filter,
        fields,
        sort: sort ?? ['-createdAt'],
        limit: pageSize,
        offset: page ? (page - 1) * (pageSize || 20) : 0,
      });

      // Strip sensitive credentials from API responses (Fix P0-1)
      ctx.body = records.map((r: any) => {
        const data = r.toJSON ? r.toJSON() : r;
        if (data.connectParams) {
          data.connectParams = { ...data.connectParams, password: '***', apiKey: data.connectParams.apiKey ? '***' : undefined };
        }
        return data;
      });

      await next();
    },

    async get(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiVectorDatabases');

      const record = await repo.findOne({ filterByTk });
      if (record) {
        // Strip sensitive credentials from API responses (Fix P0-1)
        const data = record.toJSON ? record.toJSON() : record;
        if (data.connectParams) {
          data.connectParams = { ...data.connectParams, password: '***', apiKey: data.connectParams.apiKey ? '***' : undefined };
        }
        ctx.body = data;
      } else {
        ctx.body = null;
      }

      await next();
    },

    async create(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const repo = ctx.db.getRepository('aiVectorDatabases');

      ctx.body = await repo.create({ values });

      await next();
    },

    async update(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const repo = ctx.db.getRepository('aiVectorDatabases');

      ctx.body = await repo.update({
        filterByTk,
        values,
      });

      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiVectorDatabases');

      await repo.destroy({ filterByTk });
      ctx.body = { success: true };

      await next();
    },

    async test(ctx: Context, next: Function) {
      // Unwrap double-nested values: client sends data:{values:{...}},
      // NocoBase puts body into params.values = {values:{...actual data...}}
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const { provider, connectParams } = values;

      if (!provider || !connectParams) {
        ctx.body = { success: false, error: 'Provider and connectParams are required' };
        await next();
        return;
      }

      try {
        if (provider === 'qdrant') {
          if (!connectParams.url) {
            ctx.body = { success: false, error: 'Qdrant URL is required' };
            await next();
            return;
          }
          if (!connectParams.collectionName) {
            ctx.body = { success: false, error: 'Collection name is required' };
            await next();
            return;
          }

          const client = new QdrantClient({
            url: connectParams.url,
            apiKey: connectParams.apiKey,
          });
          await client.getCollections();
          ctx.body = { success: true };
          await next();
          return;
        }

        const client = new Client({
          host: connectParams.host,
          port: connectParams.port || 5432,
          user: connectParams.username,
          password: connectParams.password,
          database: connectParams.database,
          connectionTimeoutMillis: 10_000, // Fix P0-2: prevent indefinite hang on non-responsive hosts
          query_timeout: 10_000,
        });

        await client.connect();
        await client.query('SELECT 1');

        // Check if pgvector extension is available
        const extResult = await client.query("SELECT * FROM pg_available_extensions WHERE name = 'vector'");

        await client.end();

        if (extResult.rows.length === 0) {
          ctx.body = {
            success: false,
            error: 'pgvector extension is not available. Use pgvector/pgvector Docker image.',
          };
        } else {
          ctx.body = { success: true };
        }
      } catch (error: any) {
        ctx.body = { success: false, error: error.message };
      }

      await next();
    },
  },
};
