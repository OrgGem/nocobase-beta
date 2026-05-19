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
import { enqueueKnowledgeBaseDocument } from '../queue/document-vectorization';
import {
  buildAccessibleKnowledgeBaseFilter,
  canManageKnowledgeBase,
  canReadKnowledgeBase,
  getAuthUserId,
  getCurrentRoles,
  isAdminRole,
} from '../utils/access';

/**
 * Helper: get plugin instance via class reference (avoids fragile string-based lookup).
 */
function getPlugin(ctx: Context): PluginKnowledgeBaseServer | null {
  try {
    return ctx.app.pm.get(PluginKnowledgeBaseServer) as PluginKnowledgeBaseServer;
  } catch {
    return null;
  }
}

/**
 * Helper: check if user can access a KB based on accessLevel
 */
async function checkKBAccess(
  ctx: Context,
  knowledgeBaseId: string,
): Promise<{ hasAccess: boolean; isAdmin: boolean; kbData?: any }> {
  const roles = getCurrentRoles(ctx);
  const isAdmin = isAdminRole(roles);

  if (isAdmin) {
    return { hasAccess: true, isAdmin };
  }

  const kbRepo = ctx.db.getRepository('aiKnowledgeBases');
  const kb = await kbRepo.findOne({ filter: { id: knowledgeBaseId } });
  if (!kb) {
    return { hasAccess: false, isAdmin };
  }

  const kbData = kb.toJSON();
  return { hasAccess: canReadKnowledgeBase(ctx, kbData), isAdmin, kbData };
}

export default {
  // IMPORTANT: resource name must differ from collection name 'aiKnowledgeBaseDocuments'
  // otherwise NocoBase's auto-registered collection CRUD overrides our custom handlers.
  name: 'aiKnowledgeBaseDoc',
  actions: {
    async list(ctx: Context, next: Function) {
      const { filter = {}, sort, page, pageSize } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const roles = getCurrentRoles(ctx);
      const isAdmin = isAdminRole(roles);

      // If filtering by knowledgeBaseId, check KB access first
      if (filter.knowledgeBaseId && !isAdmin) {
        const { hasAccess } = await checkKBAccess(ctx, filter.knowledgeBaseId);
        if (!hasAccess) {
          ctx.body = [];
          await next();
          return;
        }
      }

      // For non-admin users without specific KB filter, join with KB access check
      if (!filter.knowledgeBaseId && !isAdmin) {
        // Get all accessible KB IDs for this user
        const kbRepo = ctx.db.getRepository('aiKnowledgeBases');
        const accessibleKBs = await kbRepo.find({
          filter: buildAccessibleKnowledgeBaseFilter(ctx),
          fields: ['id'],
        });
        const accessibleIds = accessibleKBs.map((kb: any) => kb.id || kb.get('id'));
        filter.knowledgeBaseId = { $in: accessibleIds };
      }

      ctx.body = await repo.find({
        filter,
        sort: sort ?? ['-createdAt'],
        limit: pageSize,
        offset: page ? (page - 1) * (pageSize || 20) : 0,
        appends: ['file'],
      });

      await next();
    },

    async create(ctx: Context, next: Function) {
      // Client sends data: { values: {...} }, NocoBase puts body into params.values,
      // resulting in params.values = { values: {...actual data...} }. Unwrap this.
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;

      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      let kbData: any;
      // Always derive userId from the authenticated session — never trust client-provided userId
      const userId = getAuthUserId(ctx);

      if (!values.knowledgeBaseId) {
        ctx.throw(400, 'knowledgeBaseId is required');
        return;
      }

      // Check upload permission based on KB access level
      const kbRepo = ctx.db.getRepository('aiKnowledgeBases');
      const kb = await kbRepo.findOne({ filter: { id: values.knowledgeBaseId } });

      if (!kb) {
        ctx.throw(404, 'Knowledge base not found');
        return;
      }

      kbData = kb.toJSON();

      // EXTERNAL_RAG KBs are managed by external services — no local document uploads
      if (kbData.type === 'EXTERNAL_RAG') {
        ctx.throw(400, 'Cannot upload documents to an external RAG knowledge base');
        return;
      }

      if (!canManageKnowledgeBase(ctx, kbData)) {
        ctx.throw(403, 'You do not have permission to upload documents to this knowledge base');
        return;
      }

      // Always use server-side userId — never accept from client
      values.uploadedById = userId;

      // Create the document record
      const doc = await repo.create({ values });

      // NocoBase repository strips belongsTo FK fields during create/update on
      // custom resources. Use a targeted repo.update() to set FKs after creation.
      const fkUpdates: Record<string, any> = {};
      if (values.knowledgeBaseId) fkUpdates.knowledgeBaseId = values.knowledgeBaseId;
      if (values.fileId) fkUpdates.fileId = values.fileId;

      if (Object.keys(fkUpdates).length > 0) {
        await repo.update({
          filterByTk: doc.get('id'),
          values: fkUpdates,
        });
        // Reflect the changes on the in-memory model for the response
        for (const [k, v] of Object.entries(fkUpdates)) {
          doc.set(k, v);
        }
      }

      const plugin = getPlugin(ctx);
      if (!plugin) {
        ctx.throw(500, 'Knowledge Base plugin is not available');
        return;
      }
      await enqueueKnowledgeBaseDocument(plugin, {
        documentId: String(doc.id),
        reason: 'create',
        requestedById: userId,
      });

      ctx.body = doc;
      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');

      const roles = getCurrentRoles(ctx);
      const isAdmin = isAdminRole(roles);

      // Find the document to check its KB's access level
      const doc = await repo.findOne({ filterByTk });
      if (!doc) {
        ctx.throw(404, 'Document not found');
        return;
      }

      const docData = doc.toJSON();
      if (docData.knowledgeBaseId && !isAdmin) {
        const { hasAccess, kbData } = await checkKBAccess(ctx, docData.knowledgeBaseId);
        if (!hasAccess || !canManageKnowledgeBase(ctx, kbData)) {
          ctx.throw(403, 'You do not have permission to delete this document');
          return;
        }
      }

      await repo.destroy({ filterByTk });
      ctx.body = { success: true };

      await next();
    },

    async reprocess(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');

      const roles = getCurrentRoles(ctx);
      const isAdmin = isAdminRole(roles);

      // Check permission: same as upload (need write access to the KB)
      if (!isAdmin) {
        const doc = await repo.findOne({ filterByTk });
        if (doc) {
          const docData = doc.toJSON();
          if (docData.knowledgeBaseId) {
            const { hasAccess, kbData } = await checkKBAccess(ctx, docData.knowledgeBaseId);
            if (!hasAccess || !canManageKnowledgeBase(ctx, kbData)) {
              ctx.throw(403, 'You do not have permission to reprocess this document');
              return;
            }
          }
        }
      }

      const doc = await repo.findOne({ filterByTk, appends: ['knowledgeBase'] });
      if (!doc) {
        ctx.throw(404, 'Document not found');
        return;
      }
      await repo.update({
        filterByTk,
        values: { status: 'pending', error: null, chunkCount: 0, retryCount: 0 },
      });

      const plugin = getPlugin(ctx);
      if (!plugin) {
        ctx.throw(500, 'Knowledge Base plugin is not available');
        return;
      }
      await enqueueKnowledgeBaseDocument(plugin, {
        documentId: String(filterByTk),
        reason: 'reprocess',
        requestedById: getAuthUserId(ctx),
      });

      ctx.body = { success: true };
      await next();
    },
  },
};
