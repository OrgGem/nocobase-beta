/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import PluginKnowledgeBaseServer from '../plugin';
import { getServerEmbeddingPipeline } from '../utils/embed-web-client';

/**
 * API action: aiKnowledgeBase:addDocument
 *
 * Allows workflows to add documents to a knowledge base.
 * Accepts a file URL or text content, creates a document record,
 * and triggers the vectorization pipeline asynchronously.
 *
 * POST /api/aiKnowledgeBase:addDocument
 * Body: {
 *   knowledgeBaseId: string,
 *   fileId?: string,
 *   textContent?: string,
 *   filename?: string
 * }
 *
 * Note: userId is ALWAYS derived from the authenticated session (ctx.auth.user.id).
 * Any client-provided userId in the request body is ignored to prevent spoofing.
 */
export async function addDocumentAction(ctx: any, next: any) {
  const { knowledgeBaseId, fileId, fileUrl, textContent, filename } = ctx.action.params.values ?? {};

  if (!knowledgeBaseId) {
    ctx.throw(400, 'knowledgeBaseId is required');
    return;
  }

  if (fileUrl && !fileId) {
    ctx.throw(400, 'fileUrl is not supported by this action. Upload the file to aiFiles first and pass fileId.');
    return;
  }

  if (!fileId && !textContent) {
    ctx.throw(400, 'fileId or textContent is required');
    return;
  }

  // Always derive userId from the authenticated session — never trust client-provided userId
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    ctx.throw(401, 'Authentication required');
    return;
  }

  // Validate knowledge base exists
  const knowledgeBase = await ctx.db.getRepository('aiKnowledgeBases').findOne({
    filter: { id: knowledgeBaseId },
    appends: ['vectorStore', 'vectorStore.vectorDatabase'],
  });

  if (!knowledgeBase) {
    ctx.throw(404, `Knowledge base "${knowledgeBaseId}" not found`);
    return;
  }

  // EXTERNAL_RAG KBs are managed by external services — documents cannot be added locally
  const kbData = knowledgeBase.toJSON ? knowledgeBase.toJSON() : knowledgeBase;
  if (kbData.type === 'EXTERNAL_RAG') {
    ctx.throw(
      400,
      'Cannot add documents to an external RAG knowledge base. Documents are managed by the external service.',
    );
    return;
  }
  if (kbData.type === 'WEB_CLIENT_EMBED' && kbData.embedMode !== 'server') {
    ctx.throw(400, 'WEB_CLIENT_EMBED client mode requires browser upload via plugin-embed-web-client');
    return;
  }

  const docRepo = ctx.db.getRepository('aiKnowledgeBaseDocuments');

  // Create document record
  const docValues: any = {
    knowledgeBaseId,
    uploadedById: userId,
    status: 'pending',
    filename: filename || 'pasted-text',
  };

  if (textContent) {
    docValues.textContent = textContent;
    docValues.filename = filename || 'pasted-text';
  }

  if (fileId) {
    const file = await ctx.db.getRepository('aiFiles').findOne({ filter: { id: fileId } });
    if (!file) {
      ctx.throw(404, `File "${fileId}" not found`);
      return;
    }
    docValues.fileId = fileId;
    docValues.filename = filename || file.filename || file.get?.('filename') || 'uploaded-file';
  }

  const doc = await docRepo.create({ values: docValues });

  if (fileId || knowledgeBaseId) {
    await docRepo.update({
      filterByTk: doc.get?.('id') ?? doc.id,
      values: {
        knowledgeBaseId,
        ...(fileId ? { fileId } : {}),
      },
    });
  }

  // Trigger vectorization via class-reference plugin lookup (avoids fragile string matching)
  try {
    const plugin = ctx.app.pm.get(PluginKnowledgeBaseServer) as PluginKnowledgeBaseServer;
    if (kbData.type === 'WEB_CLIENT_EMBED') {
      getServerEmbeddingPipeline(plugin)
        .processDocument(doc.id)
        .catch((err: any) => {
          ctx.app.logger.error(`[addDocument] Server embedding failed for doc ${doc.id}:`, err);
        });
    } else if (plugin?.vectorizationPipeline) {
      // Don't await — let it run in the background
      plugin.vectorizationPipeline.processDocument(doc.id).catch((err: any) => {
        ctx.app.logger.error(`[addDocument] Vectorization failed for doc ${doc.id}:`, err);
      });
    }
  } catch (err: any) {
    ctx.app.logger.error('[addDocument] Failed to trigger vectorization:', err);
  }

  ctx.body = {
    success: true,
    documentId: doc.id,
    message: 'Document added and vectorization triggered',
  };

  await next();
}
