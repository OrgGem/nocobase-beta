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
import { getServerEmbeddingPipeline } from '../utils/embed-web-client';
import { getAuthUserId, getCurrentRoles, isAdminRole, sameId } from '../utils/access';

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
  const userId = getAuthUserId(ctx);
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
  const hasAccess =
    kbData.accessLevel === 'PUBLIC' ||
    (kbData.accessLevel === 'BASIC' && sameId(kbData.ownerId, userId)) ||
    (kbData.accessLevel === 'SHARED' && kbData.allowedRoles?.some((r: string) => roles.includes(r)));

  return { hasAccess: !!hasAccess, isAdmin, kbData };
}

export default {
  // IMPORTANT: resource name must differ from collection name 'aiKnowledgeBaseDocuments'
  // otherwise NocoBase's auto-registered collection CRUD overrides our custom handlers.
  name: 'aiKnowledgeBaseDoc',
  actions: {
    async list(ctx: Context, next: Function) {
      const { filter = {}, sort, page, pageSize } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const userId = getAuthUserId(ctx);
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
          filter: {
            enabled: true,
            $or: [
              { accessLevel: 'PUBLIC' },
              ...(userId ? [{ accessLevel: 'BASIC', ownerId: userId }] : []),
              ...(roles.length ? [{ accessLevel: 'SHARED', 'allowedRoles.$anyOf': roles }] : []),
            ],
          },
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
      const roles = getCurrentRoles(ctx);
      const isAdmin = isAdminRole(roles);

      if (!values.knowledgeBaseId) {
        ctx.throw(400, 'knowledgeBaseId is required');
        return;
      }

      // Check upload permission based on KB access level
      if (values.knowledgeBaseId) {
        const kbRepo = ctx.db.getRepository('aiKnowledgeBases');
        const kb = await kbRepo.findOne({ filter: { id: values.knowledgeBaseId } });

        if (!kb) {
          ctx.throw(404, 'Knowledge base not found');
          return;
        }

        if (kb) {
          kbData = kb.toJSON();

          // EXTERNAL_RAG KBs are managed by external services — no local document uploads
          if (kbData.type === 'EXTERNAL_RAG') {
            ctx.throw(400, 'Cannot upload documents to an external RAG knowledge base');
            return;
          }

          if (kbData.accessLevel === 'BASIC' && !sameId(kbData.ownerId, userId)) {
            ctx.throw(403, 'Only the owner can upload documents to a personal knowledge base');
            return;
          }

          if (kbData.accessLevel === 'PUBLIC' && !isAdmin) {
            ctx.throw(403, 'Only administrators can upload documents to a public knowledge base');
            return;
          }

          if (kbData.accessLevel === 'SHARED') {
            const canUpload = isAdmin || kbData.uploadRoles?.some((r: string) => roles.includes(r));
            if (!canUpload) {
              ctx.throw(403, 'You do not have permission to upload documents to this knowledge base');
              return;
            }
          }
        }
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

      // Trigger async processing via the right pipeline. Client-mode WEB_CLIENT_EMBED
      // is completed by the browser calling embedWebClient:storeVectors.
      const plugin = getPlugin(ctx);
      if (kbData?.type === 'WEB_CLIENT_EMBED') {
        if (kbData.embedMode === 'server' && plugin) {
          try {
            getServerEmbeddingPipeline(plugin)
              .processDocument(doc.id)
              .catch((err: Error) => {
                ctx.logger.error(`Server embedding failed for document ${doc.id}:`, err);
              });
          } catch (err: any) {
            ctx.logger.error(`Failed to trigger server embedding for document ${doc.id}:`, err);
          }
        }
      } else if (plugin?.vectorizationPipeline) {
        plugin.vectorizationPipeline.processDocument(doc.id).catch((err: Error) => {
          ctx.logger.error(`Vectorization failed for document ${doc.id}:`, err);
        });
      }

      ctx.body = doc;
      await next();
    },

    async destroy(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');

      const userId = getAuthUserId(ctx);
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
        if (!hasAccess) {
          ctx.throw(403, 'You do not have permission to delete this document');
          return;
        }

        // For PUBLIC KBs, only admins can delete. For SHARED KBs, only uploaders
        // can delete their own docs (or users with uploadRoles).
        if (kbData?.accessLevel === 'PUBLIC') {
          ctx.throw(403, 'Only administrators can delete public knowledge base documents');
          return;
        }

        if (kbData?.accessLevel === 'SHARED') {
          const canUpload = kbData.uploadRoles?.some((r: string) => roles.includes(r));
          const isUploader = sameId(docData.uploadedById, userId);
          if (!canUpload && !isUploader) {
            ctx.throw(403, 'You do not have permission to delete this document');
            return;
          }
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
            if (!hasAccess) {
              ctx.throw(403, 'You do not have permission to reprocess this document');
              return;
            }
            if (kbData?.accessLevel === 'PUBLIC') {
              ctx.throw(403, 'Only administrators can reprocess public knowledge base documents');
              return;
            }
            if (kbData?.accessLevel === 'SHARED') {
              const canUpload = kbData.uploadRoles?.some((r: string) => roles.includes(r));
              if (!canUpload) {
                ctx.throw(403, 'You do not have permission to reprocess this document');
                return;
              }
            }
          }
        }
      }

      const doc = await repo.findOne({ filterByTk, appends: ['knowledgeBase'] });
      if (!doc) {
        ctx.throw(404, 'Document not found');
        return;
      }
      const kbData = doc.knowledgeBase?.toJSON ? doc.knowledgeBase.toJSON() : doc.knowledgeBase;
      const nextStatus =
        kbData?.type === 'WEB_CLIENT_EMBED' && kbData.embedMode !== 'server' ? 'pending_client' : 'pending';

      // Reset status for the matching processing mode.
      await repo.update({
        filterByTk,
        values: { status: nextStatus, error: null, chunkCount: 0, retryCount: 0 },
      });

      // Trigger re-processing via the matching pipeline.
      const plugin = getPlugin(ctx);
      if (kbData?.type === 'WEB_CLIENT_EMBED') {
        if (kbData.embedMode === 'server' && plugin) {
          try {
            getServerEmbeddingPipeline(plugin)
              .processDocument(filterByTk)
              .catch((err: Error) => {
                ctx.logger.error(`Server embedding reprocess failed for document ${filterByTk}:`, err);
              });
          } catch (err: any) {
            ctx.throw(400, err.message ?? 'Failed to trigger server embedding');
            return;
          }
        }
      } else if (plugin?.vectorizationPipeline) {
        plugin.vectorizationPipeline.processDocument(filterByTk).catch((err: Error) => {
          ctx.logger.error(`Re-vectorization failed for document ${filterByTk}:`, err);
        });
      }

      ctx.body = { success: true };
      await next();
    },
  },
};
