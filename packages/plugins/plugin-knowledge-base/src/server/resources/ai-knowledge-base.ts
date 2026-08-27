/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import PluginKnowledgeBaseServer from '../plugin';
import {
  buildAccessibleKnowledgeBaseFilter,
  getAuthUserId,
  canManageKnowledgeBase,
  canReadKnowledgeBase,
  normalizeAgents,
  normalizeRoles,
  resolveAccessContext,
} from '../utils/access';
import { usesForwardedEmbeddingCredentials } from '../providers/external-rag';
import { addDocumentAction } from '../actions/add-document';

/**
 * Helper to get the knowledge base plugin instance via class reference (not string name).
 * Using the class reference is guaranteed to work regardless of how the plugin was registered.
 */
function getPlugin(ctx: Context): PluginKnowledgeBaseServer {
  return ctx.app.pm.get(PluginKnowledgeBaseServer) as PluginKnowledgeBaseServer;
}

const SUPPORTED_KNOWLEDGE_BASE_TYPES = new Set(['LOCAL', 'READONLY', 'EXTERNAL', 'EXTERNAL_RAG']);
const SUPPORTED_ACCESS_LEVELS = new Set(['BASIC', 'SHARED', 'PUBLIC']);
const SUPPORTED_AGENT_ACCESS = new Set(['inherit', 'explicit', 'none']);
const LEGACY_KNOWLEDGE_BASE_FIELDS = ['embed' + 'ModelId', 'embed' + 'Mode'];

function normalizeKnowledgeBaseValues(ctx: Context, values: any, existing?: any) {
  for (const field of LEGACY_KNOWLEDGE_BASE_FIELDS) {
    delete values[field];
  }
  if (values.type && !SUPPORTED_KNOWLEDGE_BASE_TYPES.has(values.type)) {
    ctx.throw(400, `Unsupported knowledge base type "${values.type}"`);
  }
  if (values.accessLevel && !SUPPORTED_ACCESS_LEVELS.has(values.accessLevel)) {
    ctx.throw(400, `Unsupported knowledge base access level "${values.accessLevel}"`);
  }
  if (values.agentAccess && !SUPPORTED_AGENT_ACCESS.has(values.agentAccess)) {
    ctx.throw(400, `Unsupported knowledge base agent access "${values.agentAccess}"`);
  }

  if (values.allowedRoles !== undefined) {
    values.allowedRoles = normalizeRoles(values.allowedRoles);
  }
  if (values.allowedAgents !== undefined) {
    values.allowedAgents = normalizeAgents(values.allowedAgents);
  }

  // SHARED KBs use one role list for read/use/manage. Accept uploadRoles only
  // as legacy input and normalize it into allowedRoles.
  if (values.uploadRoles !== undefined && values.allowedRoles === undefined) {
    values.allowedRoles = normalizeRoles(values.uploadRoles);
  }
  delete values.uploadRoles;

  const effective = {
    ...(existing?.toJSON ? existing.toJSON() : existing ?? {}),
    ...values,
  };
  if (effective.accessLevel === 'SHARED' && normalizeRoles(effective.allowedRoles).length === 0) {
    ctx.throw(400, 'allowedRoles is required for role-based knowledge bases');
  }
  // explicit agent access needs at least one grant (named agent or listed role)
  if (
    effective.agentAccess === 'explicit' &&
    normalizeAgents(effective.allowedAgents).length === 0 &&
    normalizeRoles(effective.allowedRoles).length === 0
  ) {
    ctx.throw(400, 'allowedAgents or allowedRoles is required when agentAccess is "explicit"');
  }
}

function isCredentialForwardingExternalRag(values: Record<string, unknown>, existing?: unknown) {
  const effective = {
    ...(existing && typeof existing === 'object' && 'toJSON' in existing && typeof existing.toJSON === 'function'
      ? existing.toJSON()
      : existing ?? {}),
    ...values,
  };
  return effective.type === 'EXTERNAL_RAG' && usesForwardedEmbeddingCredentials(effective);
}

export default {
  name: 'aiKnowledgeBase',
  actions: {
    async addDocument(ctx: Context, next: Function) {
      // Do not assign addDocumentAction directly here. That action imports the
      // server plugin, which imports this resource; reading the CommonJS export
      // during module initialization would otherwise capture `undefined`.
      await addDocumentAction(ctx, next);
    },

    async list(ctx: Context, next: Function) {
      const repo = ctx.db.getRepository('aiKnowledgeBases');
      const { filter = {}, fields, sort, page, pageSize, appends = [] } = ctx.action.params;

      // Apply permission-based filtering
      const access = await resolveAccessContext(ctx, ctx.db);
      const effectiveFilter = access.isAdmin
        ? filter
        : {
            $and: [{ ...filter }, buildAccessibleKnowledgeBaseFilter(access)],
          };

      // Intercept 'key' field request since it is virtual and not in the DB
      let queryFields = fields;
      if (Array.isArray(fields)) {
        if (fields.includes('key')) {
          queryFields = fields.filter((f) => f !== 'key');
          if (!queryFields.includes('id')) {
            queryFields.push('id');
          }
        }
      }

      const records = await repo.find({
        filter: effectiveFilter,
        fields: queryFields,
        sort: sort ?? ['-createdAt'],
        limit: pageSize,
        offset: page ? (page - 1) * (pageSize || 20) : 0,
        // The navigator requests the documents association to render the
        // per-knowledge-base document count. Preserve the default relation
        // and accept only known associations from the request.
        appends: Array.from(new Set(['vectorStore', ...(Array.isArray(appends) ? appends : [])])).filter((append) =>
          ['vectorStore', 'documents'].includes(append),
        ),
      });

      if (Array.isArray(records)) {
        const includesDocuments = Array.isArray(appends) && appends.includes('documents');
        const documentCounts = new Map<string, number>();

        // Repository appends are not reliable for custom resources in all
        // installed NocoBase versions. Aggregate the count explicitly so the
        // navigator always receives an accurate value without loading every
        // document record into the response.
        if (includesDocuments && records.length > 0) {
          const documentRepo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
          const knowledgeBaseIds = records.map((record) => String(record.get?.('id') ?? record.id));
          const documents = await documentRepo.find({
            filter: { knowledgeBaseId: { $in: knowledgeBaseIds } },
            fields: ['knowledgeBaseId'],
          });
          for (const document of documents) {
            const knowledgeBaseId = String(document.get?.('knowledgeBaseId') ?? document.knowledgeBaseId ?? '');
            if (knowledgeBaseId) {
              documentCounts.set(knowledgeBaseId, (documentCounts.get(knowledgeBaseId) ?? 0) + 1);
            }
          }
        }

        ctx.body = records.map((record) => {
          const data = record.toJSON ? record.toJSON() : record;
          if (includesDocuments) {
            // The client needs only the count; a compact placeholder array
            // preserves the current response contract without exposing the
            // documents' file content and metadata in the navigator request.
            data.documents = Array.from({ length: documentCounts.get(String(data.id)) ?? 0 }, () => ({}));
          }
          data.key = String(data.id);
          return data;
        });
      } else {
        ctx.body = records;
      }

      await next();
    },

    async get(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBases');

      const record = await repo.findOne({
        filterByTk,
        appends: ['vectorStore', 'documents'],
      });

      // Fix #3: Return 404 when record is not found instead of silent null body
      if (!record) {
        ctx.throw(404, 'Knowledge base not found');
        return;
      }

      const access = await resolveAccessContext(ctx, ctx.db);
      if (!canReadKnowledgeBase(access, record.toJSON())) {
        ctx.throw(403, 'Access denied');
        return;
      }

      const data = record.toJSON ? record.toJSON() : record;
      data.key = String(data.id);
      ctx.body = data;
      await next();
    },

    async create(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const repo = ctx.db.getRepository('aiKnowledgeBases');
      const access = await resolveAccessContext(ctx, ctx.db);

      if (!access.isAdmin) {
        if (values.accessLevel && values.accessLevel !== 'BASIC') {
          ctx.throw(403, 'Only administrators can create shared or public knowledge bases');
          return;
        }
        values.accessLevel = 'BASIC';
        delete values.allowedRoles;
        // Non-admins cannot configure agent exposure policy.
        delete values.agentAccess;
        delete values.allowedAgents;
      }
      normalizeKnowledgeBaseValues(ctx, values);
      if (!access.isAdmin && isCredentialForwardingExternalRag(values)) {
        ctx.throw(
          403,
          ctx.t('Only administrators can configure External RAG providers that forward LLM credentials.', {
            ns: 'plugin-knowledge-base',
          }),
        );
        return;
      }

      // For BASIC KBs, automatically set the owner.
      if (values.accessLevel === 'BASIC') {
        values.ownerId = access.userId;
      }

      const record = await repo.create({ values });

      // NocoBase repository strips belongsTo FK fields during create/update on
      // custom resources (not routed through the NocoBase data manager). We use
      // a targeted update via the repository to set the FK after creation.
      // This is preferable to raw Sequelize SQL as it goes through ORM hooks.
      if (values.vectorStoreId) {
        await repo.update({
          filterByTk: record.get('id'),
          values: { vectorStoreId: values.vectorStoreId },
        });
      }

      const data = record.toJSON ? record.toJSON() : record;
      data.key = String(data.id);
      ctx.body = data;
      await next();
    },

    async update(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const repo = ctx.db.getRepository('aiKnowledgeBases');

      const access = await resolveAccessContext(ctx, ctx.db);
      const existing = await repo.findOne({ filterByTk });
      if (!existing) {
        ctx.throw(404, 'Knowledge base not found');
        return;
      }
      if (!canManageKnowledgeBase(access, existing.toJSON())) {
        ctx.throw(403, 'You do not have permission to update this knowledge base');
        return;
      }

      normalizeKnowledgeBaseValues(ctx, values, existing);
      if (!access.isAdmin && isCredentialForwardingExternalRag(values, existing)) {
        ctx.throw(
          403,
          ctx.t('Only administrators can configure External RAG providers that forward LLM credentials.', {
            ns: 'plugin-knowledge-base',
          }),
        );
        return;
      }
      if (!access.isAdmin) {
        // Members may manage KB content/settings, but changing the row-level
        // access policy (user or agent) remains an admin concern.
        delete values.ownerId;
        delete values.allowedRoles;
        delete values.accessLevel;
        delete values.agentAccess;
        delete values.allowedAgents;
      }

      const updated = await repo.update({
        filterByTk,
        values,
      });

      if (updated) {
        const data = updated.toJSON ? updated.toJSON() : updated;
        data.key = String(data.id);
        ctx.body = data;
      } else {
        ctx.body = updated;
      }

      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBases');

      const access = await resolveAccessContext(ctx, ctx.db);
      const existing = await repo.findOne({ filterByTk });
      if (existing && !canManageKnowledgeBase(access, existing.toJSON())) {
        ctx.throw(403, 'You do not have permission to delete this knowledge base');
        return;
      }

      await repo.destroy({ filterByTk });
      ctx.body = { success: true };

      await next();
    },

    async searchAnalytics(ctx: Context, next: Function) {
      const access = await resolveAccessContext(ctx, ctx.db);
      if (!access.isAdmin) {
        ctx.throw(403, 'Only administrators can view search analytics');
        return;
      }

      const { filter = {} } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseSearchAnalytics');
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const records: any[] = await repo.find({
        filter: { ...filter, createdAt: { $dateNotBefore: since.toISOString() } },
        fields: ['knowledgeBaseId', 'query', 'resultCount', 'searchLatencyMs', 'createdAt'],
        limit: 10_000,
      });

      const queryCounts = new Map<string, number>();
      let totalLatency = 0;
      let latencySamples = 0;

      for (const record of records) {
        const data = record.toJSON ? record.toJSON() : record;
        const q = String(data.query ?? '')
          .trim()
          .toLowerCase();
        if (q) {
          queryCounts.set(q, (queryCounts.get(q) ?? 0) + 1);
        }
        if (Number.isFinite(Number(data.searchLatencyMs))) {
          totalLatency += Number(data.searchLatencyMs);
          latencySamples += 1;
        }
      }

      const topQueries = Array.from(queryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([query, count]) => ({ query, count }));

      ctx.body = {
        periodDays: 30,
        totalSearches: records.length,
        averageLatencyMs: latencySamples > 0 ? Math.round(totalLatency / latencySamples) : 0,
        uniqueQueries: queryCounts.size,
        topQueries,
      };
      await next();
    },

    async submitSearchFeedback(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const query = typeof values.query === 'string' ? values.query.trim().slice(0, 2000) : '';
      const feedback = values.feedback === 'positive' || values.feedback === 'negative' ? values.feedback : '';
      const documentId = values.documentId ? String(values.documentId).slice(0, 100) : '';
      const knowledgeBaseId = values.knowledgeBaseId ? String(values.knowledgeBaseId) : '';

      if (!query || !knowledgeBaseId || (!documentId && !feedback)) {
        ctx.throw(400, 'query, knowledgeBaseId and feedback are required');
        return;
      }

      // Only allow positive/negative feedback on accessible KBs
      const access = await resolveAccessContext(ctx, ctx.db);
      const kbRepo = ctx.db.getRepository('aiKnowledgeBases');
      if (access.isAdmin) {
        const kb = await kbRepo.findOne({ filter: { id: knowledgeBaseId }, fields: ['id'] });
        if (!kb) {
          ctx.throw(404, 'Knowledge base not found');
          return;
        }
      } else {
        const kbRecords = await kbRepo.find({
          filter: buildAccessibleKnowledgeBaseFilter(access, [knowledgeBaseId]),
          fields: ['id'],
        });
        if (!kbRecords.length) {
          ctx.throw(404, 'Knowledge base not found');
          return;
        }
      }

      const userId = getAuthUserId(ctx);
      await ctx.db.getRepository('aiKnowledgeBaseSearchFeedback').create({
        values: {
          knowledgeBaseId,
          query,
          documentId,
          feedback: feedback || 'negative',
          rerankScore: Number.isFinite(Number(values.rerankScore)) ? Number(values.rerankScore) : null,
          userId: userId ?? null,
          createdAt: new Date(),
        },
      });

      ctx.body = { success: true };
      await next();
    },

    async export(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBases');
      const kb = await repo.findOne({ filterByTk, appends: ['vectorStore'] });
      if (!kb) {
        ctx.throw(404, 'Knowledge base not found');
        return;
      }

      const access = await resolveAccessContext(ctx, ctx.db);
      if (!canManageKnowledgeBase(access, kb.toJSON())) {
        ctx.throw(403, 'You do not have permission to export this knowledge base');
        return;
      }

      const docRepo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const documents = await docRepo.find({ filter: { knowledgeBaseId: String(filterByTk) } });

      // Strip secrets and internal ids; keep structure + text content
      const kbData = (kb.toJSON ? kb.toJSON() : kb) as Record<string, any>;
      const exportPayload = {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        knowledgeBase: {
          name: kbData.name,
          description: kbData.description,
          type: kbData.type,
          accessLevel: kbData.accessLevel,
          agentAccess: kbData.agentAccess,
          allowedRoles: kbData.allowedRoles,
          allowedAgents: kbData.allowedAgents,
          enabled: kbData.enabled,
          deleteSourceFile: kbData.deleteSourceFile,
          useDocpixie: kbData.useDocpixie,
        },
        documents: documents.map((doc: any) => {
          const d = doc.toJSON ? doc.toJSON() : doc;
          return {
            filename: d.filename,
            textContent: d.textContent ?? null,
            status: d.status === 'success' || d.status === 'failed' ? 'pending' : 'pending',
            chunkCount: 0,
          };
        }),
      };

      ctx.body = exportPayload;
      ctx.set('Content-Disposition', `attachment; filename=knowledge-base-${String(filterByTk)}.json`);
      await next();
    },

    async import(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const payload = values.payload ?? values;

      if (!payload || typeof payload !== 'object') {
        ctx.throw(400, 'Import payload is required');
        return;
      }
      if (payload.formatVersion !== 1) {
        ctx.throw(400, 'Unsupported export format version');
        return;
      }
      const sourceKb = payload.knowledgeBase;
      if (!sourceKb?.name) {
        ctx.throw(400, 'payload.knowledgeBase.name is required');
        return;
      }

      const access = await resolveAccessContext(ctx, ctx.db);
      if (!access.isAdmin && sourceKb.accessLevel && sourceKb.accessLevel !== 'BASIC') {
        ctx.throw(403, 'Only administrators can import shared or public knowledge bases');
        return;
      }

      const repo = ctx.db.getRepository('aiKnowledgeBases');
      const createValues: Record<string, any> = {
        name: String(sourceKb.name),
        description: sourceKb.description ?? '',
        type: ['LOCAL', 'READONLY', 'EXTERNAL', 'EXTERNAL_RAG'].includes(sourceKb.type) ? sourceKb.type : 'LOCAL',
        accessLevel:
          access.isAdmin && ['BASIC', 'SHARED', 'PUBLIC'].includes(sourceKb.accessLevel)
            ? sourceKb.accessLevel
            : 'BASIC',
        enabled: sourceKb.enabled !== false,
        deleteSourceFile: Boolean(sourceKb.deleteSourceFile),
        useDocpixie: Boolean(sourceKb.useDocpixie),
      };
      if (createValues.accessLevel === 'SHARED' && Array.isArray(sourceKb.allowedRoles)) {
        createValues.allowedRoles = normalizeRoles(sourceKb.allowedRoles);
      }

      const record = await repo.create({ values: createValues });
      const kbId = record.get?.('id') ?? (record as any).id;

      // BASIC KBs are owned by the importer
      if (createValues.accessLevel === 'BASIC') {
        await repo.update({ filterByTk: kbId, values: { ownerId: access.userId } });
      }

      const docRepo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const importedDocs: string[] = [];
      for (const doc of Array.isArray(payload.documents) ? payload.documents : []) {
        if (!doc?.textContent) continue;
        const created = await docRepo.create({
          values: {
            knowledgeBaseId: kbId,
            filename: String(doc.filename ?? 'imported'),
            textContent: String(doc.textContent),
            status: 'pending',
            uploadedById: access.userId,
          },
        });
        const docId = created.get?.('id') ?? (created as any).id;
        await docRepo.update({ filterByTk: docId, values: { knowledgeBaseId: kbId } });
        importedDocs.push(String(docId));
      }

      ctx.body = { success: true, knowledgeBaseId: kbId, importedDocuments: importedDocs.length };
      await next();
    },

    async search(ctx: Context, next: Function) {
      const plugin = getPlugin(ctx);
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const query = ctx.action.params.query ?? values.query;
      const knowledgeBaseIds =
        ctx.action.params.knowledgeBaseIds ??
        values.knowledgeBaseIds ??
        (ctx.action.params.filterByTk ? [ctx.action.params.filterByTk] : undefined);

      if (!query || typeof query !== 'string' || !query.trim()) {
        ctx.throw(400, 'Search query is required');
        return;
      }

      const startedAt = Date.now();
      const results = await plugin.searchKnowledgeBases(ctx, query, {
        knowledgeBaseIds: Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds.map(String) : undefined,
        topK: ctx.action.params.topK ?? values.topK,
        candidateK: ctx.action.params.candidateK ?? values.candidateK,
        scoreThreshold: ctx.action.params.scoreThreshold ?? values.scoreThreshold,
        rerank: ctx.action.params.rerank ?? values.rerank,
      });
      const latencyMs = Date.now() - startedAt;

      // Record analytics (best-effort — never fail the search response)
      try {
        const analyticsRepo = ctx.db.getRepository('aiKnowledgeBaseSearchAnalytics');
        if (analyticsRepo) {
          const kbIdForAnalytics =
            Array.isArray(knowledgeBaseIds) && knowledgeBaseIds.length === 1 ? String(knowledgeBaseIds[0]) : null;
          await analyticsRepo.create({
            values: {
              knowledgeBaseId: kbIdForAnalytics,
              query: query.slice(0, 2000),
              resultCount: results.length,
              searchLatencyMs: latencyMs,
              userId: getAuthUserId(ctx) ?? null,
              createdAt: new Date(),
            },
          });
        }
      } catch {
        // analytics must never break search
      }

      ctx.body = {
        query,
        data: results,
      };

      await next();
    },
  },
};
