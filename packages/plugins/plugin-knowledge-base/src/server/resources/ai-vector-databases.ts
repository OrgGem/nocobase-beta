// SPDX-License-Identifier: Apache-2.0

import { Client } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Context } from '@nocobase/actions';
import { requireRecordId } from '../utils/record-id';
import type { Transaction } from 'sequelize';
import { getAuthUserId } from '../utils/access';
import {
  credentialChangeNeedsConfirmation,
  mergeSecretValues,
  pickAllowedValues,
  serializeVectorDatabase,
  vectorCredentialRecipientChanged,
  withoutSecrets,
} from '../utils/credentials';
import { endpointFingerprint } from '../services/index-lifecycle';

const WRITABLE_VECTOR_DATABASE_FIELDS = ['name', 'provider', 'connectParams', 'enabled'];
const SECRET_FIELDS = ['password', 'apiKey'];
const CREDENTIAL_DESTINATION_ERROR =
  'Provide a new credential or clear the saved credential when changing the connection destination';

function prepareConnectionParams(
  ctx: Context,
  previous: Record<string, unknown>,
  incoming: unknown,
  provider: unknown,
) {
  const oldParams = previous.connectParams;
  const candidate = mergeSecretValues(oldParams, incoming, SECRET_FIELDS);
  const changed = vectorCredentialRecipientChanged(previous.provider, oldParams, provider, candidate);
  if (changed && credentialChangeNeedsConfirmation(oldParams, incoming, SECRET_FIELDS)) {
    ctx.throw(400, ctx.t(CREDENTIAL_DESTINATION_ERROR, { ns: 'plugin-knowledge-base' }));
  }
  return mergeSecretValues(changed ? withoutSecrets(oldParams, SECRET_FIELDS) : oldParams, incoming, SECRET_FIELDS);
}

async function storageLocationInUse(
  ctx: Context,
  vectorDatabaseId: string,
  transaction: Transaction,
): Promise<boolean> {
  const docs = await ctx.db.getRepository('aiKnowledgeBaseDocuments').find({
    filter: { $or: [{ indexDeleted: { $isFalsy: true } }, { indexCleanupPending: true }] },
    appends: ['knowledgeBase', 'knowledgeBase.vectorStore'],
    transaction,
  });
  return docs.some((doc) => {
    const data = doc.toJSON();
    const id = data.indexCleanupRoute?.vectorDatabaseId ?? data.knowledgeBase?.vectorStore?.vectorDatabaseId;
    return id != null && String(id) === vectorDatabaseId;
  });
}

function endpointChanged(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const oldProvider = String(previous.provider ?? '');
  const newProvider = String(next.provider ?? '');
  if (oldProvider !== newProvider) return true;
  const oldParams = (previous.connectParams ?? {}) as Record<string, unknown>;
  const newParams = (next.connectParams ?? {}) as Record<string, unknown>;
  const collectionField = oldProvider === 'pgvector' ? 'tableName' : 'collectionName';
  if (oldParams[collectionField] !== newParams[collectionField]) return true;
  try {
    return endpointFingerprint(oldProvider, oldParams) !== endpointFingerprint(newProvider, newParams);
  } catch {
    return true;
  }
}

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

      ctx.body = serializeVectorDatabase(records);

      await next();
    },

    async get(ctx: Context, next: Function) {
      const filterByTk = requireRecordId(ctx, ctx.action.params.filterByTk);
      const repo = ctx.db.getRepository('aiVectorDatabases');

      const record = await repo.findOne({ filterByTk });
      ctx.body = serializeVectorDatabase(record);

      await next();
    },

    async create(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = pickAllowedValues(rawValues.values || rawValues, WRITABLE_VECTOR_DATABASE_FIELDS);
      const repo = ctx.db.getRepository('aiVectorDatabases');
      if ('connectParams' in values) values.connectParams = mergeSecretValues({}, values.connectParams, SECRET_FIELDS);
      ctx.body = serializeVectorDatabase(await repo.create({ values }));

      await next();
    },

    async update(ctx: Context, next: Function) {
      const filterByTk = requireRecordId(ctx, ctx.action.params.filterByTk);
      const rawValues = ctx.action.params.values || {};
      const values = pickAllowedValues(rawValues.values || rawValues, WRITABLE_VECTOR_DATABASE_FIELDS);
      const repo = ctx.db.getRepository('aiVectorDatabases');
      const updated = await ctx.db.sequelize.transaction(async (transaction) => {
        const existing = await repo.collection.model.findOne({
          where: { id: filterByTk },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!existing) ctx.throw(404, 'Vector database not found');
        const previous = existing.toJSON();
        if ('connectParams' in values || 'provider' in values) {
          values.connectParams = prepareConnectionParams(
            ctx,
            previous,
            values.connectParams,
            values.provider ?? previous.provider,
          );
        }
        if (
          endpointChanged(previous, { ...previous, ...values }) &&
          (await storageLocationInUse(ctx, String(filterByTk), transaction))
        ) {
          ctx.throw(
            409,
            ctx.t(
              'Vector database storage location is in use; create a new vector database and migrate documents first',
              {
                ns: 'plugin-knowledge-base',
              },
            ),
          );
        }
        return repo.update({ filterByTk, values, transaction });
      });
      ctx.body = serializeVectorDatabase(updated);

      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const filterByTk = requireRecordId(ctx, ctx.action.params.filterByTk);
      const repo = ctx.db.getRepository('aiVectorDatabases');

      await ctx.db.sequelize.transaction(async (transaction) => {
        await repo.collection.model.findOne({ where: { id: filterByTk }, transaction, lock: transaction.LOCK.UPDATE });
        if (await storageLocationInUse(ctx, String(filterByTk), transaction)) {
          ctx.throw(
            409,
            ctx.t(
              'Vector database storage location is in use; create a new vector database and migrate documents first',
              {
                ns: 'plugin-knowledge-base',
              },
            ),
          );
        }
        await repo.destroy({ filterByTk, transaction });
      });
      ctx.body = { success: true };

      await next();
    },

    async test(ctx: Context, next: Function) {
      // Unwrap double-nested values: client sends data:{values:{...}},
      // NocoBase puts body into params.values = {values:{...actual data...}}
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      let { provider, connectParams } = values;
      if (values.id != null) {
        if (
          !getAuthUserId(ctx) ||
          typeof ctx.can !== 'function' ||
          !ctx.can({ resource: 'aiVectorDatabase', action: 'update' })
        ) {
          ctx.throw(403, 'Access denied');
          return;
        }
        const id = requireRecordId(ctx, values.id);
        const permission = await ctx.acl.resolveActionParams(ctx, {
          resourceName: 'aiVectorDatabase',
          actionName: 'update',
          params: { filterByTk: id },
        });
        const record = await ctx.db.getRepository('aiVectorDatabases').findOne({
          filterByTk: id,
          filter: permission.mergedParams?.filter,
        });
        if (!record) {
          ctx.throw(404, 'Vector database not found');
          return;
        }
        const stored = record.toJSON();
        provider = provider || stored.provider;
        connectParams = prepareConnectionParams(ctx, stored, connectParams, provider);
      }

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
      } catch {
        ctx.body = { success: false, error: ctx.t('Connection test failed', { ns: 'plugin-knowledge-base' }) };
      }

      await next();
    },
  },
};
