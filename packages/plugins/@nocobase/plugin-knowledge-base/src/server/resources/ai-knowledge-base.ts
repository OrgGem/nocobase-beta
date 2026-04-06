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
async function checkKBPermission(ctx: Context, filterByTk: string, action: 'update' | 'destroy'): Promise<boolean> {
  const repo = ctx.db.getRepository('aiKnowledgeBases');
  const record = await repo.findOne({ filterByTk });

  if (!record) {
    return true; // Let the action handle not-found naturally
  }

  const data = record.toJSON();
  const userId = ctx.auth?.user?.id;
  const roles = ctx.state.currentRoles ?? [];
  const isAdmin = roles.includes('root') || roles.includes('admin');

  if (isAdmin) {
    return true;
  }

  if (data.accessLevel === 'BASIC') {
    // Only owner can update/destroy their own BASIC KB
    return data.ownerId === userId;
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
      const userId = ctx.auth?.user?.id;
      const roles = ctx.state.currentRoles ?? [];
      const isAdmin = roles.includes('root') || roles.includes('admin');

      if (!isAdmin) {
        // Non-root users can only see KBs they have access to
        filter.$or = [
          { accessLevel: 'PUBLIC' },
          ...(userId ? [{ accessLevel: 'BASIC', ownerId: userId }] : []),
          ...(roles.length ? [{ accessLevel: 'SHARED', 'allowedRoles.$anyOf': roles }] : []),
        ];
      }

      ctx.body = await repo.find({
        filter,
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
      const userId = ctx.auth?.user?.id;
      const roles = ctx.state.currentRoles ?? [];
      const isAdmin = roles.includes('root') || roles.includes('admin');

      // Check access
      if (!isAdmin) {
        const hasAccess =
          data.accessLevel === 'PUBLIC' ||
          (data.accessLevel === 'BASIC' && data.ownerId === userId) ||
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
      const userId = ctx.auth?.user?.id;
      const roles = ctx.state.currentRoles ?? [];
      const isAdmin = roles.includes('root') || roles.includes('admin');

      // Only admin/root can create PUBLIC KBs
      if (values.accessLevel === 'PUBLIC' && !isAdmin) {
        ctx.throw(403, 'Only administrators can create public knowledge bases');
        return;
      }

      // For BASIC KBs, automatically set the owner
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
  },
};
