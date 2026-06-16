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
  canManageKnowledgeBase,
  canReadKnowledgeBase,
  normalizeAgents,
  normalizeRoles,
  resolveAccessContext,
} from '../utils/access';

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

export default {
  name: 'aiKnowledgeBase',
  actions: {
    async list(ctx: Context, next: Function) {
      const repo = ctx.db.getRepository('aiKnowledgeBases');
      const { filter = {}, fields, sort, page, pageSize } = ctx.action.params;

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
        appends: ['vectorStore'],
      });

      if (Array.isArray(records)) {
        ctx.body = records.map((record) => {
          const data = record.toJSON ? record.toJSON() : record;
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

      const results = await plugin.searchKnowledgeBases(ctx, query, {
        knowledgeBaseIds: Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds.map(String) : undefined,
        topK: ctx.action.params.topK ?? values.topK,
        candidateK: ctx.action.params.candidateK ?? values.candidateK,
        scoreThreshold: ctx.action.params.scoreThreshold ?? values.scoreThreshold,
        rerank: ctx.action.params.rerank ?? values.rerank,
      });

      ctx.body = {
        query,
        data: results,
      };

      await next();
    },
  },
};
