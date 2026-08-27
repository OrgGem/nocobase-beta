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
import { KnowledgeSearchService } from '../services/knowledge-search';
import { DuplicateDetectionService, analyzeDocumentText } from '../services/document-analysis';
import { EmbeddingVisualizationService } from '../services/embedding-visualization';
import {
  buildAccessibleKnowledgeBaseFilter,
  canManageKnowledgeBase,
  canReadKnowledgeBase,
  getAuthUserId,
  resolveAccessContext,
  type KbAccessContext,
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
 * Helper: load a KB and evaluate read access against an already-resolved context.
 */
async function loadKbForRead(
  ctx: Context,
  access: KbAccessContext,
  knowledgeBaseId: string,
): Promise<{ hasAccess: boolean; kbData?: any }> {
  if (access.isAdmin) {
    return { hasAccess: true };
  }
  const kbRepo = ctx.db.getRepository('aiKnowledgeBases');
  const kb = await kbRepo.findOne({ filter: { id: knowledgeBaseId } });
  if (!kb) {
    return { hasAccess: false };
  }
  const kbData = kb.toJSON();
  return { hasAccess: canReadKnowledgeBase(access, kbData), kbData };
}

export default {
  // IMPORTANT: resource name must differ from collection name 'aiKnowledgeBaseDocuments'
  // otherwise NocoBase's auto-registered collection CRUD overrides our custom handlers.
  name: 'aiKnowledgeBaseDoc',
  actions: {
    async list(ctx: Context, next: Function) {
      const { filter = {}, sort, page, pageSize } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const access = await resolveAccessContext(ctx, ctx.db);

      // If filtering by knowledgeBaseId, check KB access first
      if (filter.knowledgeBaseId && !access.isAdmin) {
        const { hasAccess } = await loadKbForRead(ctx, access, filter.knowledgeBaseId);
        if (!hasAccess) {
          ctx.body = [];
          await next();
          return;
        }
      }

      // For non-admin users without specific KB filter, join with KB access check
      if (!filter.knowledgeBaseId && !access.isAdmin) {
        // Get all accessible KB IDs for this principal
        const kbRepo = ctx.db.getRepository('aiKnowledgeBases');
        const accessibleKBs = await kbRepo.find({
          filter: buildAccessibleKnowledgeBaseFilter(access),
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

      const kbData = kb.toJSON();

      // EXTERNAL_RAG KBs are managed by external services — no local document uploads
      if (kbData.type === 'EXTERNAL_RAG') {
        ctx.throw(400, 'Cannot upload documents to an external RAG knowledge base');
        return;
      }

      const access = await resolveAccessContext(ctx, ctx.db);
      if (!canManageKnowledgeBase(access, kbData)) {
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

      const access = await resolveAccessContext(ctx, ctx.db);

      // Find the document to check its KB's access level
      const doc = await repo.findOne({ filterByTk });
      if (!doc) {
        ctx.throw(404, 'Document not found');
        return;
      }

      const docData = doc.toJSON();
      if (docData.knowledgeBaseId && !access.isAdmin) {
        const { hasAccess, kbData } = await loadKbForRead(ctx, access, docData.knowledgeBaseId);
        if (!hasAccess || !canManageKnowledgeBase(access, kbData)) {
          ctx.throw(403, 'You do not have permission to delete this document');
          return;
        }
      }

      await repo.destroy({ filterByTk });
      KnowledgeSearchService.invalidateKnowledgeBase(String(docData.knowledgeBaseId));
      ctx.body = { success: true };

      await next();
    },

    async reprocess(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');

      const access = await resolveAccessContext(ctx, ctx.db);

      // Check permission: same as upload (need write access to the KB)
      if (!access.isAdmin) {
        const doc = await repo.findOne({ filterByTk });
        if (doc) {
          const docData = doc.toJSON();
          if (docData.knowledgeBaseId) {
            const { hasAccess, kbData } = await loadKbForRead(ctx, access, docData.knowledgeBaseId);
            if (!hasAccess || !canManageKnowledgeBase(access, kbData)) {
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

    async stats(ctx: Context, next: Function) {
      const { filter = {} } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const access = await resolveAccessContext(ctx, ctx.db);

      // Restrict to accessible KBs for non-admins
      const effectiveFilter: Record<string, any> = { ...filter };
      if (!access.isAdmin) {
        const kbRepo = ctx.db.getRepository('aiKnowledgeBases');
        const accessibleKBs = await kbRepo.find({
          filter: buildAccessibleKnowledgeBaseFilter(access),
          fields: ['id'],
        });
        const accessibleIds = accessibleKBs.map((kb: any) => kb.id || kb.get('id'));
        if (!accessibleIds.length) {
          ctx.body = { total: 0, pending: 0, processing: 0, success: 0, failed: 0, retrying: 0 };
          await next();
          return;
        }
        effectiveFilter.knowledgeBaseId = effectiveFilter.knowledgeBaseId
          ? effectiveFilter.knowledgeBaseId
          : { $in: accessibleIds };
      }

      const docs = await repo.find({ filter: effectiveFilter, fields: ['status'] });
      const counts = { total: docs.length, pending: 0, processing: 0, success: 0, failed: 0, retrying: 0 };
      for (const doc of docs) {
        const status = doc.get?.('status') ?? (doc as any).status;
        if (status && status in counts) {
          (counts as any)[status] += 1;
        }
      }

      ctx.body = counts;
      await next();
    },

    async listVersions(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const plugin = getPlugin(ctx);
      if (!plugin?.documentVersionService) {
        ctx.throw(500, 'Version service is not available');
        return;
      }
      const versions = await plugin.documentVersionService.listVersions(String(filterByTk));
      ctx.body = versions;
      await next();
    },

    async restoreVersion(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const { filterByTk } = ctx.action.params;
      const version = Number(values.version);
      if (!Number.isFinite(version)) {
        ctx.throw(400, 'version is required');
        return;
      }

      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const access = await resolveAccessContext(ctx, ctx.db);

      // Permission: same as reprocess (manage access on the parent KB)
      const doc = await repo.findOne({ filterByTk });
      if (!doc) {
        ctx.throw(404, 'Document not found');
        return;
      }
      const kbId = doc.toJSON().knowledgeBaseId;
      if (kbId && !access.isAdmin) {
        const { hasAccess, kbData } = await loadKbForRead(ctx, access, kbId);
        if (!hasAccess || !canManageKnowledgeBase(access, kbData)) {
          ctx.throw(403, 'You do not have permission to restore this document');
          return;
        }
      }

      const plugin = getPlugin(ctx);
      if (!plugin?.documentVersionService) {
        ctx.throw(500, 'Version service is not available');
        return;
      }

      const result = await plugin.documentVersionService.restoreVersion(
        String(filterByTk),
        version,
        async (docId) => {
          await enqueueKnowledgeBaseDocument(plugin, {
            documentId: docId,
            reason: 'restore-version',
            requestedById: getAuthUserId(ctx),
          });
        },
        getAuthUserId(ctx),
      );

      if (!result.restored) {
        ctx.throw(400, result.error ?? 'Restore failed');
        return;
      }

      ctx.body = { success: true };
      await next();
    },

    async analyze(ctx: Context, next: Function) {
      const { filterByTk } = ctx.action.params;
      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const access = await resolveAccessContext(ctx, ctx.db);

      const doc = await repo.findOne({ filterByTk, fields: ['id', 'textContent', 'knowledgeBaseId'] });
      if (!doc) {
        ctx.throw(404, 'Document not found');
        return;
      }
      const docData = doc.toJSON();
      if (docData.knowledgeBaseId && !access.isAdmin) {
        const { hasAccess } = await loadKbForRead(ctx, access, String(docData.knowledgeBaseId));
        if (!hasAccess) {
          ctx.throw(403, 'You do not have permission to view this document');
          return;
        }
      }

      const textContent = docData.textContent ?? '';
      if (!textContent) {
        // File-only documents have no local text to analyze
        ctx.body = { keywords: [], wordCount: 0, fingerprint: null, analyzed: false };
        await next();
        return;
      }

      ctx.body = { analyzed: true, ...analyzeDocumentText(textContent) };
      await next();
    },

    async duplicates(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const knowledgeBaseId = values.knowledgeBaseId ?? ctx.action.params.filterByTk;
      if (!knowledgeBaseId) {
        ctx.throw(400, 'knowledgeBaseId is required');
        return;
      }
      const access = await resolveAccessContext(ctx, ctx.db);
      if (!access.isAdmin) {
        const { hasAccess } = await loadKbForRead(ctx, access, String(knowledgeBaseId));
        if (!hasAccess) {
          ctx.throw(403, 'You do not have permission to scan this knowledge base');
          return;
        }
      }

      const thresholdRaw = Number(values.threshold);
      const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 1 ? thresholdRaw : 0.9;

      const plugin = getPlugin(ctx);
      if (!plugin) {
        ctx.throw(500, 'Knowledge Base plugin is not available');
        return;
      }
      const detector = new DuplicateDetectionService(ctx.db);
      const pairs = await detector.findDuplicates(String(knowledgeBaseId), threshold);
      ctx.body = { knowledgeBaseId, threshold, duplicatePairs: pairs };
      await next();
    },

    async visualization(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const knowledgeBaseId = values.knowledgeBaseId ?? ctx.action.params.filterByTk;
      if (!knowledgeBaseId) {
        ctx.throw(400, 'knowledgeBaseId is required');
        return;
      }
      const access = await resolveAccessContext(ctx, ctx.db);
      if (!access.isAdmin) {
        const { hasAccess } = await loadKbForRead(ctx, access, String(knowledgeBaseId));
        if (!hasAccess) {
          ctx.throw(403, 'You do not have permission to view this knowledge base');
          return;
        }
      }
      const service = new EmbeddingVisualizationService(ctx.db);
      const kRaw = Number(values.k);
      const result = await service.buildVisualization(
        String(knowledgeBaseId),
        Number.isFinite(kRaw) && kRaw >= 2 ? Math.min(Math.floor(kRaw), 12) : 5,
      );
      ctx.body = result;
      await next();
    },

    async bulkDestroy(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const documentIds: string[] = Array.isArray(values.documentIds) ? values.documentIds.map(String) : [];

      if (!documentIds.length) {
        ctx.throw(400, 'documentIds is required');
        return;
      }

      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const access = await resolveAccessContext(ctx, ctx.db);

      // Load all documents and verify manage permission on each KB
      const docs = await repo.find({ filter: { id: { $in: documentIds } } });
      if (!docs.length) {
        ctx.throw(404, 'No documents found');
        return;
      }

      const kbIds = [...new Set(docs.map((d: any) => d.toJSON().knowledgeBaseId).filter(Boolean))] as string[];
      for (const kbId of kbIds) {
        const { hasAccess, kbData } = await loadKbForRead(ctx, access, kbId);
        if (!hasAccess || !canManageKnowledgeBase(access, kbData)) {
          ctx.throw(403, `You do not have permission to delete documents in knowledge base "${kbId}"`);
          return;
        }
      }

      await repo.destroy({ filter: { id: { $in: documentIds } } });
      for (const kbId of kbIds) {
        KnowledgeSearchService.invalidateKnowledgeBase(String(kbId));
      }
      ctx.body = { success: true, deletedCount: docs.length };
      await next();
    },

    async bulkReprocess(ctx: Context, next: Function) {
      const rawValues = ctx.action.params.values || {};
      const values = rawValues.values || rawValues;
      const documentIds: string[] = Array.isArray(values.documentIds) ? values.documentIds.map(String) : [];

      if (!documentIds.length) {
        ctx.throw(400, 'documentIds is required');
        return;
      }

      const repo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
      const access = await resolveAccessContext(ctx, ctx.db);
      const plugin = getPlugin(ctx);

      if (!plugin) {
        ctx.throw(500, 'Knowledge Base plugin is not available');
        return;
      }

      // Load all documents and verify manage permission on each KB
      const docs = await repo.find({ filter: { id: { $in: documentIds } }, appends: ['knowledgeBase'] });
      if (!docs.length) {
        ctx.throw(404, 'No documents found');
        return;
      }

      const results: { documentId: string; queued: boolean; error?: string }[] = [];

      for (const doc of docs) {
        const docData = doc.toJSON();
        const kbId = docData.knowledgeBaseId;

        try {
          if (kbId && !access.isAdmin) {
            const { hasAccess, kbData } = await loadKbForRead(ctx, access, kbId);
            if (!hasAccess || !canManageKnowledgeBase(access, kbData)) {
              results.push({ documentId: String(doc.id), queued: false, error: 'Permission denied' });
              continue;
            }
          }

          if (docData.knowledgeBase?.type === 'EXTERNAL_RAG') {
            results.push({
              documentId: String(doc.id),
              queued: false,
              error: 'External RAG documents cannot be reprocessed locally',
            });
            continue;
          }

          await repo.update({
            filterByTk: doc.get('id'),
            values: { status: 'pending', error: null, chunkCount: 0, retryCount: 0 },
          });

          await enqueueKnowledgeBaseDocument(plugin, {
            documentId: String(doc.id),
            reason: 'bulkReprocess',
            requestedById: getAuthUserId(ctx),
          });

          results.push({ documentId: String(doc.id), queued: true });
        } catch (err: any) {
          results.push({ documentId: String(doc.id), queued: false, error: err.message ?? String(err) });
        }
      }

      const queuedCount = results.filter((r) => r.queued).length;
      ctx.body = { success: true, total: results.length, queuedCount, results };
      await next();
    },
  },
};
