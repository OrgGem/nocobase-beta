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
  getCurrentRoles,
  isAdminRole,
  sameId,
} from '../utils/access';

/**
 * Helper to get the knowledge base plugin instance via class reference (not string name).
 * Using the class reference is guaranteed to work regardless of how the plugin was registered.
 */
function getPlugin(ctx: Context): PluginKnowledgeBaseServer {
  return ctx.app.pm.get(PluginKnowledgeBaseServer) as PluginKnowledgeBaseServer;
}

/**
 * Permission check helper for KB ownership/role access.
 */
async function checkKBPermission(ctx: Context, filterByTk: string, _action: 'update' | 'destroy'): Promise<boolean> {
  const repo = ctx.db.getRepository('aiKnowledgeBases');
  const record = await repo.findOne({ filterByTk });

  if (!record) {
    return true; // Let the action handle not-found naturally
  }

  const data = record.toJSON();
  const userId = getAuthUserId(ctx);
  const roles = getCurrentRoles(ctx);
  const isAdmin = isAdminRole(roles);

  if (isAdmin) {
    return true;
  }

  if (data.accessLevel === 'BASIC') {
    // Only owner can update/destroy their own BASIC KB
    return sameId(data.ownerId, userId);
  }

  if (data.accessLevel === 'PUBLIC') {
    // Only admin/root can update/destroy PUBLIC KBs
    return false;
  }

  if (data.accessLevel === 'SHARED') {
    // Only admin/root can update/destroy SHARED KBs
    return false;
  }

  return false;
}

export default {
  name: 'aiKnowledgeBase',
  actions: {
    async list(ctx: Context, next: Function) {
      const repo = ctx.db.getRepository('aiKnowledgeBases');
      const { filter = {}, fields, sort, page, pageSize } = ctx.action.params;

      // Apply permission-based filtering
      const roles = getCurrentRoles(ctx);
      const isAdmin = isAdminRole(roles);
      const effectiveFilter = isAdmin
        ? filter
        : {
            $and: [{ ...filter }, buildAccessibleKnowledgeBaseFilter(ctx)],
          };

      ctx.body = await repo.find({
        filter: effectiveFilter,
        fields,
        sort: sort ?? ['-createdAt'],
        limit: pageSize,
        offset: page ? (page - 1) * (pageSize || 20) : 0,
        appends: ['vectorStore'],
      });

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

      const data = record.toJSON();
      const userId = getAuthUserId(ctx);
      const roles = getCurrentRoles(ctx);
      const isAdmin = isAdminRole(roles);

      // Check access
      if (!isAdmin) {
        const hasAccess =
          data.accessLevel === 'PUBLIC' ||
          (data.accessLevel === 'BASIC' && sameId(data.ownerId, userId)) ||
          (data.accessLevel === 'SHARED' && data.allowedRoles?.some((r: string) => roles.includes(r)));

        if (!hasAccess) {
          ctx.throw(403, 'Access denied');
          return;
        }
      }

      ctx.body = record;
      await next();
    },

    async create(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const repo = ctx.db.getRepository('aiKnowledgeBases');
      const userId = getAuthUserId(ctx);
      const roles = getCurrentRoles(ctx);
      const isAdmin = isAdminRole(roles);

      if (!isAdmin) {
        if (values.accessLevel && values.accessLevel !== 'BASIC') {
          ctx.throw(403, 'Only administrators can create shared or public knowledge bases');
          return;
        }
        values.accessLevel = 'BASIC';
        delete values.allowedRoles;
        delete values.uploadRoles;
      }

      // For BASIC KBs, automatically set the owner.
      if (values.accessLevel === 'BASIC') {
        values.ownerId = userId;
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

      ctx.body = record;
      await next();
    },

    async update(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const repo = ctx.db.getRepository('aiKnowledgeBases');

      const allowed = await checkKBPermission(ctx, filterByTk, 'update');
      if (!allowed) {
        ctx.throw(403, 'You do not have permission to update this knowledge base');
        return;
      }

      const roles = getCurrentRoles(ctx);
      const isAdmin = isAdminRole(roles);
      if (!isAdmin) {
        delete values.ownerId;
        delete values.allowedRoles;
        delete values.uploadRoles;
        if (values.accessLevel && values.accessLevel !== 'BASIC') {
          ctx.throw(403, 'Only administrators can change knowledge base access level');
          return;
        }
        values.accessLevel = 'BASIC';
      }

      ctx.body = await repo.update({
        filterByTk,
        values,
      });

      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBases');

      const allowed = await checkKBPermission(ctx, filterByTk, 'destroy');
      if (!allowed) {
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
