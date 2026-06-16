/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import PluginKnowledgeBaseServer from '../plugin';
import { enqueueKnowledgeBaseDocument } from '../queue/document-vectorization';
import { canManageKnowledgeBase, getAuthUserId, resolveAccessContext } from '../utils/access';

/**
 * API action: aiKnowledgeBase:addDocument
 *
 * Allows workflows to add documents to a knowledge base.
 * Accepts a file ID or text content, creates a document record,
 * and queues the vectorization pipeline asynchronously.
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

  const userId = getAuthUserId(ctx);
  if (!userId) {
    ctx.throw(401, 'Authentication required');
    return;
  }

  const knowledgeBase = await ctx.db.getRepository('aiKnowledgeBases').findOne({
    filter: { id: knowledgeBaseId },
    appends: ['vectorStore', 'vectorStore.vectorDatabase'],
  });

  if (!knowledgeBase) {
    ctx.throw(404, `Knowledge base "${knowledgeBaseId}" not found`);
    return;
  }

  const kbData = knowledgeBase.toJSON ? knowledgeBase.toJSON() : knowledgeBase;
  if (kbData.type === 'EXTERNAL_RAG') {
    ctx.throw(
      400,
      'Cannot add documents to an external RAG knowledge base. Documents are managed by the external service.',
    );
    return;
  }
  const access = await resolveAccessContext(ctx, ctx.db);
  if (!canManageKnowledgeBase(access, kbData)) {
    ctx.throw(403, 'You do not have permission to add documents to this knowledge base');
    return;
  }

  const docRepo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
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
  const documentId = doc.get?.('id') ?? doc.id;

  if (fileId || knowledgeBaseId) {
    await docRepo.update({
      filterByTk: documentId,
      values: {
        knowledgeBaseId,
        ...(fileId ? { fileId } : {}),
      },
    });
  }

  const plugin = ctx.app.pm.get(PluginKnowledgeBaseServer) as PluginKnowledgeBaseServer;
  await enqueueKnowledgeBaseDocument(plugin, {
    documentId: String(documentId),
    reason: 'addDocument',
    requestedById: userId,
  });

  ctx.body = {
    success: true,
    documentId,
    message: 'Document added and queued for vectorization',
  };

  await next();
}
