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

export class PluginFilePreviewAuthServer extends Plugin {
  async load() {
    this.registerExcelParser();
    this.registerDownloadApi();
  }

  private registerDownloadApi() {
    this.app.resourcer.define({
      name: 'filePreviewAuth',
      actions: {
        download: async (ctx: any, next: any) => {
          const { url } = ctx.action.params;
          if (!url) {
            ctx.throw(400, 'url is required');
          }

          const fileManager = this.pm.get('@nocobase/plugin-file-manager') as any;
          if (!fileManager) {
            ctx.throw(500, 'File manager plugin not found');
          }

          const currentUser = ctx.state.currentUser;
          if (!currentUser) {
            ctx.throw(401, 'Unauthorized');
          }

          const attachmentRepo = this.db.getRepository('attachments');
          const attachment = await attachmentRepo.findOne({
            filter: { url },
          });

          if (!attachment) {
            ctx.throw(404, 'Attachment not found for this URL');
          }

          const isOwner = attachment.createdById === currentUser.id;
          const isAdmin = currentUser.roles?.some((r: any) => r.name === 'root' || r === 'root' || r.name === 'admin');

          if (!isOwner && !isAdmin) {
            ctx.throw(403, 'Permission denied: you cannot view other users\' files');
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
    this.log.info('[FilePreviewAuth] Registered /api/filePreviewAuth:download endpoint');
  }

  /**
   * Register Excel handler into plugin-document-parser's InternalParserRegistry.
   * Uses prepend:true so SheetJS takes priority over the AI-loader fallback.
   * Silent no-op when plugin-document-parser is not loaded.
   */
  private registerExcelParser() {
    const docParserPlugin = this.pm.get('@nocobase/plugin-document-parser') as any;
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
