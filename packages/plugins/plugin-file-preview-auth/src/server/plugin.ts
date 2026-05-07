/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { ExcelParserHandler } from './excel-parser-handler';

const FILE_PREVIEW_WORK_CONTEXT_TYPE = 'file-preview';
const MAX_AI_CONTEXT_CHARS = 50000;
import path from 'path';

export class PluginFilePreviewAuthServer extends Plugin {
  private cache: any;

  async beforeLoad() {
    await this.db.import({ directory: path.resolve(__dirname, 'collections') });
  }

  async load() {
    this.cache = await this.app.cacheManager.createCache({ name: 'file-preview-auth' });
    this.registerExcelParser();
    this.registerAIWorkContext();
    this.registerDownloadApi();
  }

  private registerDownloadApi() {
    this.app.resourcer.define({
      name: 'filePreviewAuth',
      actions: {
        getContent: async (ctx: any, next: any) => {
          const params = ctx.action.params || {};
          const values = params.values || {};
          // NocoBase strips non-standard query parameters from ctx.action.params, so we check ctx.request.query and ctx.request.body
          const reqQuery = ctx.request.query || {};
          const reqBody = ctx.request.body || {};
          
          const fileInput = values.file || params.file || reqQuery.file || reqBody.file || params;
          const attachment = await this.resolveAttachment(ctx, fileInput);
          this.assertAuthenticated(ctx);

          const cacheKey = `parsed_text:${attachment.id || attachment.key || attachment.url || attachment.path}`;
          let text = await this.cache.get(cacheKey);

          if (text == null) {
            text = await this.extractAttachmentText(ctx, attachment);
            // Cache the extracted text for 1 day (86400000 ms)
            // Even if empty string, we cache it so it doesn't repeatedly fail
            await this.cache.set(cacheKey, text, 86400000);
          }

          ctx.body = {
            filename: getAttachmentDisplayName(attachment),
            mimetype: getAttachmentValue(attachment, 'mimetype') || '',
            content: this.formatAttachmentWorkContext(attachment, text),
          };

          await next();
        },

        download: async (ctx: any, next: any) => {
          const params = ctx.action.params || {};
          const reqQuery = ctx.request.query || {};
          const reqBody = ctx.request.body || {};
          
          let rawUrl = params.url || reqQuery.url || reqBody.url;
          if (!rawUrl) {
            ctx.throw(400, 'url is required');
          }
          
          let url = rawUrl;
          try {
            url = decodeURIComponent(rawUrl);
          } catch (e) {
            // ignore
          }

          const collection = params.collection || reqQuery.collection || reqBody.collection;
          const storageIdInput = params.storageId || reqQuery.storageId || reqBody.storageId;
          let storageId = storageIdInput;

          const fileManager = this.pm.get('@nocobase/plugin-file-manager') as any;
          if (!fileManager) {
            ctx.throw(500, 'File manager plugin not found');
          }

          let filterByTk = null;
          try {
            // Parse the decoded URL to extract inner parameters
            const parsedUrl = new URL(url, 'http://local');
            filterByTk = parsedUrl.searchParams.get('filterByTk');
            if (!storageId) {
              storageId = parsedUrl.searchParams.get('storageId') || parsedUrl.searchParams.get('storage_id');
            }
          } catch (e) {
            // ignore
          }

          let attachment = null;
          let isVirtual = false;
          // Prioritize aiFiles since chat attachments are mostly aiFiles
          const collectionsToTry = Array.from(new Set([collection, 'aiFiles', 'attachments'].filter(Boolean)));
          
          for (const colName of collectionsToTry) {
            const repo = this.db.getRepository(colName);
            if (repo) {
              if (filterByTk) {
                attachment = await repo.findOne({ filterByTk });
              }
              if (!attachment) {
                attachment = await repo.findOne({ filter: { url } });
              }
              if (attachment) {
                // To prevent finding a record in 'attachments' when it actually belongs to 'aiFiles' 
                // and having permissions fail, if we found it in the wrong collection, we shouldn't break yet if url doesn't match?
                // Actually, just break.
                break;
              }
            }
          }

          // Fallback: If DB query fails but we have storageId, construct virtual attachment
          if (!attachment && storageId) {
            attachment = { url, storageId, filename: reqQuery.filename || 'file' };
            isVirtual = true;
          }

          if (!attachment) {
            ctx.throw(404, 'Attachment not found for this URL');
          }

          if (!isVirtual) {
            await this.assertCanAccessAttachment(ctx, attachment);
          }

          try {
            const storageModel = fileManager.storagesCache.get(attachment.storageId);
            // S3 Private Bucket Handler
            if (storageModel && (storageModel.type === 's3' || storageModel.type === 'aws-s3')) {
              const StorageTypeClass = fileManager.storageTypes.get(storageModel.type);
              const storageInstance = new StorageTypeClass(storageModel);
              if (storageInstance.client) {
                const { GetObjectCommand } = require('@aws-sdk/client-s3');
                const key = storageInstance.getFileKey(attachment);
                const getCommand = new GetObjectCommand({
                  Bucket: storageModel.options.bucket,
                  Key: key,
                });
                const response = await storageInstance.client.send(getCommand);
                ctx.type = response.ContentType || attachment.mimetype || 'application/octet-stream';
                ctx.attachment(attachment.filename);
                // The AWS SDK Body is a readable stream in Node.js
                ctx.body = response.Body;
                await next();
                return;
              }
            }

            // Local storage / Other storage fallback
            const { stream, contentType } = await fileManager.getFileStream(attachment);
            ctx.type = contentType || attachment.mimetype || 'application/octet-stream';
            ctx.attachment(attachment.filename);
            ctx.body = stream;
          } catch (err) {
            this.log.error(`[FilePreviewAuth] Error fetching stream for URL ${url}: ${err.message}`);
            ctx.throw(500, 'Failed to fetch the file from storage');
          }

          await next();
        },
      },
    });
    this.app.acl.allow('filePreviewAuth', ['download', 'getContent'], 'loggedIn');
    this.log.info('[FilePreviewAuth] Registered /api/filePreviewAuth:download endpoint');
  }

  private registerAIWorkContext() {
    let aiPlugin: any;
    try {
      aiPlugin = this.pm.get('ai') || this.pm.get('@nocobase/plugin-ai');
    } catch {
      aiPlugin = null;
    }
    if (!aiPlugin?.workContextHandler?.registerStrategy) {
      this.log.debug('[FilePreviewAuth] plugin-ai not found - file preview AI context skipped');
      return;
    }

    try {
      aiPlugin.workContextHandler.registerStrategy(FILE_PREVIEW_WORK_CONTEXT_TYPE, {
        resolve: async (ctx: any, contextItem: any) => {
          const file = contextItem?.content?.file || contextItem?.content || contextItem;
          const attachment = await this.resolveAttachment(ctx, file);
          this.assertAuthenticated(ctx);
          const text = await this.extractAttachmentText(ctx, attachment);
          return this.formatAttachmentWorkContext(attachment, text);
        },
      });
      this.log.info('[FilePreviewAuth] AI file-preview work context registered');
    } catch (err) {
      this.log.warn(`[FilePreviewAuth] AI file-preview work context registration skipped: ${err}`);
    }
  }

  private async resolveAttachment(ctx: any, input: any) {
    const file = input?.file || input || {};
    const collectionNames = [
      file.collectionName,
      'attachments',
      'aiFiles',
    ].filter(Boolean);

    const ids = [file.id, file.uid].filter((value) => isLikelyRecordId(value));
    for (const collectionName of collectionNames) {
      if (!ctx.db.getCollection(collectionName)) continue;
      const repo = ctx.db.getRepository(collectionName);
      for (const id of ids) {
        const record = await repo.findOne({ filter: { id } });
        if (record) return record;
      }
    }

    const urlCandidates = getUrlCandidates(file.url || file.preview || file.path);
    for (const collectionName of collectionNames) {
      if (!ctx.db.getCollection(collectionName)) continue;
      const repo = ctx.db.getRepository(collectionName);
      for (const url of urlCandidates) {
        const record = await repo.findOne({ filter: { url } });
        if (record) return record;
      }
    }

    // Fallback for files from plugin-external-storage (which might not exist in attachments collection)
    if ((file.storageId || file.url?.includes('extStorage:download')) && (file.url || file.path || file.key)) {
      return file;
    }

    ctx.throw(404, 'Attachment not found for this preview file');
  }

  private async assertCanAccessAttachment(ctx: any, attachment: any) {
    const currentUser = this.assertAuthenticated(ctx);

    const createdById = getAttachmentValue(attachment, 'createdById');
    const currentRoles = ctx.state.currentRoles || [];
    const userRoles = currentUser.roles || [];
    const isOwner = createdById != null && String(createdById) === String(currentUser.id);
    const isAdmin =
      currentRoles.includes('root') ||
      currentRoles.includes('admin') ||
      userRoles.some((role: any) => role === 'root' || role === 'admin' || role?.name === 'root' || role?.name === 'admin');

    if (!isOwner && !isAdmin) {
      ctx.throw(403, 'Permission denied: you cannot view other users\' files');
    }
  }

  private assertAuthenticated(ctx: any) {
    const currentUser = ctx.state.currentUser;
    if (!currentUser) {
      ctx.throw(401, 'Unauthorized');
    }
    return currentUser;
  }

  private async extractAttachmentText(ctx: any, attachment: any): Promise<string> {
    const docParserPlugin = (this.pm.get('@nocobase/plugin-document-parser') || this.pm.get('plugin-document-parser')) as any;
    if (docParserPlugin?.internalParserRegistry) {
      try {
        const result = await docParserPlugin.internalParserRegistry.parse(attachment, ctx);
        if (result?.handled && result.text?.trim()) {
          return result.text;
        }
      } catch (err) {
        this.log.warn(`[FilePreviewAuth] Document parser failed: ${err}`);
      }
    }

    if (isPlainTextAttachment(attachment)) {
      return await this.readAttachmentAsText(attachment);
    }

    return '';
  }

  private async readAttachmentAsText(attachment: any): Promise<string> {
    const fileManager = (this.pm.get('@nocobase/plugin-file-manager') || this.pm.get('file-manager')) as any;
    if (!fileManager?.getFileStream) {
      return '';
    }
    const { stream } = await fileManager.getFileStream(attachment);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks as any[]).toString('utf-8');
  }

  private formatAttachmentWorkContext(attachment: any, text: string): string {
    const filename = sanitizeXmlAttr(getAttachmentDisplayName(attachment));
    const mimetype = sanitizeXmlAttr(getAttachmentValue(attachment, 'mimetype') || '');
    const extname = sanitizeXmlAttr(getAttachmentValue(attachment, 'extname') || '');
    const size = sanitizeXmlAttr(getAttachmentValue(attachment, 'size') || '');
    const content = truncateForContext(text?.trim() || '');

    if (!content) {
      return [
        `<file_preview filename="${filename}" type="${mimetype}" extname="${extname}" size="${size}">`,
        'The user is previewing this file, but no extractable text content was found by the server parser.',
        '</file_preview>',
      ].join('\n');
    }

    return [
      `<file_preview filename="${filename}" type="${mimetype}" extname="${extname}" size="${size}">`,
      content,
      '</file_preview>',
    ].join('\n');
  }

  /**
   * Register Excel handler into plugin-document-parser's InternalParserRegistry.
   * Uses prepend:true so SheetJS takes priority over the AI-loader fallback.
   * Silent no-op when plugin-document-parser is not loaded.
   */
  private registerExcelParser() {
    const docParserPlugin = (this.pm.get('@nocobase/plugin-document-parser') || this.pm.get('plugin-document-parser')) as any;
    if (!docParserPlugin?.internalParserRegistry) {
      this.log.debug('[FilePreviewAuth] plugin-document-parser not found — Excel parser registration skipped');
      return;
    }

    try {
      docParserPlugin.internalParserRegistry.register(new ExcelParserHandler(), { prepend: true });
      this.log.info('[FilePreviewAuth] Excel parser handler registered into plugin-document-parser');
    } catch (err) {
      // Duplicate registration (e.g. hot-reload) — safe to ignore
      this.log.warn(`[FilePreviewAuth] Excel parser registration skipped: ${err}`);
    }
  }
}

export default PluginFilePreviewAuthServer;

function getAttachmentValue(attachment: any, key: string) {
  if (!attachment) return undefined;
  if (typeof attachment.get === 'function') return attachment.get(key);
  return attachment[key];
}

function getAttachmentDisplayName(attachment: any): string {
  const title = getAttachmentValue(attachment, 'title');
  const extname = getAttachmentValue(attachment, 'extname');
  if (title && extname) return `${title}${extname}`;
  return getAttachmentValue(attachment, 'filename') || getAttachmentValue(attachment, 'name') || 'file';
}

function isLikelyRecordId(value: any): boolean {
  if (value === undefined || value === null || value === '') return false;
  const text = String(value);
  return !text.includes('/') && !text.startsWith('http://') && !text.startsWith('https://');
}

function getUrlCandidates(value: any): string[] {
  if (!value) return [];
  const original = decodePossiblyEncodedUrl(String(value));
  const candidates = new Set<string>();
  const add = (url: string) => {
    if (!url) return;
    candidates.add(url);
    candidates.add(url.split('?')[0]);
    candidates.add(url.replace(/^\//, ''));
    candidates.add(`/${url.replace(/^\//, '')}`);
  };

  add(original);
  try {
    const parsed = new URL(original, 'http://local');
    if (parsed.pathname.includes('/api/filePreviewAuth:download')) {
      add(decodePossiblyEncodedUrl(parsed.searchParams.get('url') || ''));
    } else if (parsed.origin !== 'http://local') {
      add(`${parsed.pathname}${parsed.search}`);
    }
  } catch {
    // Keep the original candidates only.
  }

  return [...candidates].filter(Boolean);
}

function decodePossiblyEncodedUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPlainTextAttachment(attachment: any): boolean {
  const mimetype = String(getAttachmentValue(attachment, 'mimetype') || '').toLowerCase();
  const extname = String(getAttachmentValue(attachment, 'extname') || '').toLowerCase();
  return (
    mimetype.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/x-yaml'].includes(mimetype) ||
    ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log'].includes(extname)
  );
}

function truncateForContext(text: string): string {
  if (!text || text.length <= MAX_AI_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_AI_CONTEXT_CHARS)}\n...[truncated]`;
}

function sanitizeXmlAttr(value: any): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
