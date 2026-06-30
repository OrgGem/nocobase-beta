/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, type Application } from '@nocobase/server';
import { koaMulter as multer } from '@nocobase/utils';
import { ExcelParserHandler } from './excel-parser-handler';
import { readFile, unlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { col } from 'sequelize';
import {
  FILE_PREVIEW_OCR_QUEUE_REDIS_KEY,
  TesseractWorker,
  WORKER_JOB_FILE_PREVIEW_OCR_PROCESS,
} from './ocr/tesseract-worker';

const FILE_PREVIEW_WORK_CONTEXT_TYPE = 'file-preview';
const MAX_AI_CONTEXT_CHARS = 50000;
const MAX_RAW_PARSE_UPLOAD_BYTES = 200 * 1024 * 1024;
const OFFICE_PREVIEWER_PLUGIN_NAMES = ['file-previewer-office', '@nocobase/plugin-file-previewer-office'];

export class PluginFilePreviewAuthServer extends Plugin {
  private cache: any;
  private ocrWorker: TesseractWorker;

  async beforeLoad() {
    await this.db.import({ directory: path.resolve(__dirname, 'collections') });
  }

  async load() {
    await this.syncOcrResultCollection();
    this.cache = await this.app.cacheManager.createCache({ name: 'file-preview-auth' });
    this.ocrWorker = new TesseractWorker(this.app);
    this.registerExcelParser();
    this.registerAIWorkContext();
    this.registerDownloadApi();

    this.app.on('afterStart', async () => {
      await this.disableBuiltinOfficePreviewer();
      if (this.ocrWorker && isFilePreviewOcrWorker(this.app)) {
        await this.ocrWorker.start();
      } else {
        this.log.debug('[FilePreviewAuth] OCR worker disabled on this node by WORKER_MODE.');
      }
    });
  }

  async afterEnable() {
    await this.disableBuiltinOfficePreviewer();
  }

  async beforeDisable() {
    if (this.ocrWorker) {
      this.ocrWorker.stop();
    }
  }

  async beforeDestroy() {
    if (this.ocrWorker) {
      this.ocrWorker.stop();
    }
  }

  private async syncOcrResultCollection() {
    const collection = this.db.getCollection('attachmentOcrResults');
    if (collection) {
      await collection.sync();
    }
  }

  /**
   * Disable NocoBase's built-in Office previewer after plugins have loaded.
   * This keeps this authenticated previewer as the active Office handler without causing a restart loop.
   */
  private async disableBuiltinOfficePreviewer() {
    try {
      const pluginRepo = this.db.getRepository('applicationPlugins');
      if (!pluginRepo) return;

      for (const name of OFFICE_PREVIEWER_PLUGIN_NAMES) {
        const record = await pluginRepo.findOne({ filter: { name } });
        if (record && record.get('enabled')) {
          await pluginRepo.update({
            filter: { name },
            values: { enabled: false },
          });
          this.log.info(`[FilePreviewAuth] Disabled built-in plugin "${name}" to avoid previewer conflicts.`);
        }
      }
    } catch (err: any) {
      this.log.debug(`[FilePreviewAuth] Could not check file-previewer-office status: ${err?.message || err}`);
    }
  }

  private registerDownloadApi() {
    this.app.resourcer.define({
      name: 'filePreviewAuth',
      actions: {
        getContent: async (ctx: any, next: any) => {
          const uploaded = await this.consumeUploadedParseFile(ctx);
          const params = ctx.action.params || {};
          const values = params.values || {};
          // NocoBase strips non-standard query parameters from ctx.action.params, so we check ctx.request.query and ctx.request.body
          const reqQuery = ctx.request.query || {};
          const reqBody = ctx.request.body || {};

          const fileInput =
            uploaded?.attachment || values.file || params.file || reqQuery.file || reqBody.file || params;
          const attachment = uploaded
            ? await this.resolveAttachment(ctx, fileInput).catch(() => fileInput)
            : await this.resolveAttachment(ctx, fileInput);
          this.assertAuthenticated(ctx);

          const cacheKey = `markitdown_parsed_text:${
            attachment.id || attachment.key || attachment.url || attachment.path || uploaded?.cacheKey
          }`;
          let text = await this.cache.get(cacheKey);

          if (text == null) {
            text = uploaded
              ? await this.extractUploadedFileText(uploaded.buffer, attachment)
              : await this.extractAttachmentText(ctx, attachment);
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
          const values = params.values || {};
          const reqQuery = ctx.request.query || {};
          const reqBody = ctx.request.body || {};

          let fileInput = values.file || params.file || reqQuery.file || reqBody.file || {};
          if (typeof fileInput === 'string') {
            try {
              fileInput = JSON.parse(fileInput);
            } catch {
              fileInput = { url: fileInput };
            }
          }

          const rawUrl =
            values.url ||
            params.url ||
            reqQuery.url ||
            reqBody.url ||
            fileInput.url ||
            fileInput.preview ||
            fileInput.path;
          const requestedId = values.id || params.id || reqQuery.id || reqBody.id || fileInput.id || fileInput.uid;
          if (!rawUrl && !requestedId) {
            ctx.throw(400, 'url or id is required');
          }

          let url = rawUrl || '';
          if (rawUrl) {
            try {
              url = decodeURIComponent(rawUrl);
            } catch (e) {
              // ignore
            }
          }

          const collection =
            values.collection ||
            values.collectionName ||
            params.collection ||
            params.collectionName ||
            reqQuery.collection ||
            reqQuery.collectionName ||
            reqBody.collection ||
            reqBody.collectionName ||
            fileInput.collectionName;
          const storageIdInput =
            values.storageId || params.storageId || reqQuery.storageId || reqBody.storageId || fileInput.storageId;
          let storageId = storageIdInput;

          const fileManager = (this.pm.get('@nocobase/plugin-file-manager') || this.pm.get('file-manager')) as any;
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
          let attachmentCollection = collection;
          let isVirtual = false;
          // Prioritize aiFiles since chat attachments are mostly aiFiles
          const collectionsToTry = Array.from(new Set([collection, 'aiFiles', 'attachments'].filter(Boolean)));

          this.log.debug(
            `[FilePreviewAuth] Download input ${safeDebugJson({
              requestedId: toDebugValue(requestedId),
              collection,
              hasRawUrl: Boolean(rawUrl),
              urlPath: getDebugUrlPath(url),
              filterByTk: toDebugValue(filterByTk),
              storageIdInput: toDebugValue(storageIdInput),
              parsedStorageId: toDebugValue(storageId),
              fileInputKeys: getObjectKeys(fileInput),
              storageCache: summarizeStorageCache(fileManager.storagesCache),
            })}`,
          );

          if (requestedId || fileInput?.id || fileInput?.uid) {
            try {
              attachment = await this.resolveAttachment(ctx, {
                ...fileInput,
                id: requestedId || fileInput.id,
                uid: fileInput.uid,
                url,
                preview: fileInput.preview,
                path: fileInput.path,
                storageId,
                collectionName: collection,
                filename:
                  values.filename || params.filename || reqQuery.filename || reqBody.filename || fileInput.filename,
                mimetype:
                  values.mimetype || params.mimetype || reqQuery.mimetype || reqBody.mimetype || fileInput.mimetype,
              });
              attachmentCollection =
                attachment?.constructor?.collection?.name ||
                collection ||
                fileInput.collectionName ||
                attachmentCollection;
            } catch {
              attachment = null;
            }
          }

          if (!attachment && url) {
            try {
              attachment = await this.resolveAttachment(ctx, {
                ...fileInput,
                url,
                preview: fileInput.preview,
                path: fileInput.path,
                storageId,
                collectionName: collection,
                filename:
                  values.filename || params.filename || reqQuery.filename || reqBody.filename || fileInput.filename,
                mimetype:
                  values.mimetype || params.mimetype || reqQuery.mimetype || reqBody.mimetype || fileInput.mimetype,
              });
              attachmentCollection =
                attachment?.constructor?.collection?.name ||
                collection ||
                fileInput.collectionName ||
                attachmentCollection;
            } catch {
              attachment = null;
            }
          }

          if (!attachment) {
            for (const colName of collectionsToTry) {
              const repo = this.db.getRepository(colName);
              if (repo) {
                if (filterByTk) {
                  attachment = await repo.findOne({ filterByTk });
                }
                if (!attachment && requestedId) {
                  attachment = await repo.findOne({ filterByTk: requestedId });
                }
                if (!attachment && url) {
                  attachment = await repo.findOne({ filter: { url } });
                }
                if (attachment) {
                  attachmentCollection = colName;
                  // To prevent finding a record in 'attachments' when it actually belongs to 'aiFiles'
                  // and having permissions fail, if we found it in the wrong collection, we shouldn't break yet if url doesn't match?
                  // Actually, just break.
                  break;
                }
              }
            }
          }

          // Fallback: If DB query fails but we have storageId, construct virtual attachment
          if (!attachment && storageId) {
            attachment = {
              ...fileInput,
              url,
              storageId,
              collectionName: collection || fileInput.collectionName,
              filename:
                values.filename ||
                params.filename ||
                reqQuery.filename ||
                reqBody.filename ||
                fileInput.filename ||
                'file',
              mimetype:
                values.mimetype || params.mimetype || reqQuery.mimetype || reqBody.mimetype || fileInput.mimetype,
            };
            isVirtual = true;
          }

          if (!attachment) {
            ctx.throw(404, 'Attachment not found for this URL');
          }

          this.log.debug(
            `[FilePreviewAuth] Attachment resolved ${safeDebugJson({
              ...summarizeAttachmentForLog(attachment, attachmentCollection),
              isVirtual,
              requestedCollection: collection,
            })}`,
          );

          if (!isVirtual) {
            await this.assertCanAccessAttachment(ctx, attachment);
          }

          let attachmentObj: any;
          let storageModel: any;
          try {
            attachmentObj = await this.prepareAttachmentForFileManager(attachment, fileManager, attachmentCollection);

            storageModel = getStorageFromCache(fileManager.storagesCache, attachmentObj.storageId);
            this.log.debug(
              `[FilePreviewAuth] Attachment prepared for stream ${safeDebugJson({
                ...summarizeAttachmentForLog(attachmentObj, attachmentCollection),
                storageModel: summarizeStorageForLog(storageModel),
                storageCache: summarizeStorageCache(fileManager.storagesCache),
              })}`,
            );
            const { stream, contentType } = await fileManager.getFileStream(attachmentObj);
            ctx.type = contentType || attachmentObj.mimetype || 'application/octet-stream';
            ctx.attachment(attachmentObj.filename);
            ctx.body = stream;
          } catch (err: any) {
            this.log.error(`[FilePreviewAuth] Error fetching stream for URL ${url}: ${err.message}`);
            try {
              require('fs').writeFileSync(
                require('path').join(process.cwd(), 'preview_error.log'),
                `Error fetching stream for URL ${url}:\n` +
                  `Time: ${new Date().toISOString()}\n` +
                  `Message: ${err.message}\n` +
                  `Stack: ${err.stack}\n` +
                  `Attachment: ${JSON.stringify(attachment, null, 2)}\n` +
                  `AttachmentObj: ${JSON.stringify(attachmentObj, null, 2)}\n` +
                  `StorageModel: ${JSON.stringify(storageModel, null, 2)}\n`,
              );
            } catch (fsErr: any) {
              this.log.error(`[FilePreviewAuth] Failed to write preview_error.log: ${fsErr.message}`);
            }
            ctx.throw(500, `Failed to fetch the file from storage: ${err.message}`);
          }

          await next();
        },

        runOcr: async (ctx: any, next: any) => {
          const params = ctx.action.params || {};
          const reqBody = ctx.request.body || {};
          const values = params.values || {};
          const rawAttachmentId = values.attachmentId || reqBody.attachmentId;

          if (!rawAttachmentId) {
            ctx.throw(400, 'attachmentId is required');
          }
          const attachmentId = normalizeOcrAttachmentId(rawAttachmentId);
          if (!attachmentId) {
            ctx.throw(400, 'attachmentId must be a numeric attachment record id');
          }

          this.assertAuthenticated(ctx);

          const repo = ctx.db.getRepository('attachments');
          const attachment = await repo.findOne({ filterByTk: attachmentId });
          if (!attachment) {
            ctx.throw(404, 'Attachment not found');
          }

          await this.assertCanAccessAttachment(ctx, attachment);

          // Cập nhật trạng thái sang pending-ocr
          const ocrRecord = await this.upsertOcrResult(attachmentId, {
            status: 'pending-ocr',
            error: null,
          });

          // Đẩy job vào worker xử lý nền
          await this.ocrWorker.enqueue(attachmentId);

          ctx.body = {
            ok: true,
            data: this.serializeOcrResult(ocrRecord, attachmentId),
          };
          await next();
        },
        getOcrStatus: async (ctx: any, next: any) => {
          const params = ctx.action.params || {};
          const reqQuery = ctx.request.query || {};
          const reqBody = ctx.request.body || {};
          const values = params.values || {};
          const rawAttachmentId =
            values.attachmentId || params.attachmentId || reqQuery.attachmentId || reqBody.attachmentId;

          if (!rawAttachmentId) {
            ctx.throw(400, 'attachmentId is required');
          }
          const attachmentId = normalizeOcrAttachmentId(rawAttachmentId);
          if (!attachmentId) {
            ctx.throw(400, 'attachmentId must be a numeric attachment record id');
          }

          this.assertAuthenticated(ctx);

          const repo = ctx.db.getRepository('attachments');
          const attachment = await repo.findOne({ filterByTk: attachmentId });
          if (!attachment) {
            ctx.throw(404, 'Attachment not found');
          }

          await this.assertCanAccessAttachment(ctx, attachment);

          const ocrRecord = await this.getOcrResultByAttachmentId(attachmentId);
          ctx.body = {
            data: this.serializeOcrResult(ocrRecord, attachmentId),
          };
          await next();
        },
      },
    });
    this.app.acl.allow('filePreviewAuth', ['download', 'getContent', 'runOcr', 'getOcrStatus'], 'loggedIn');
    this.app.acl.allow('attachmentOcrResults', ['get', 'list', 'create', 'update'], 'loggedIn');
    this.log.info('[FilePreviewAuth] Registered /api/filePreviewAuth:download & runOcr endpoints');
  }

  private async getOcrResultByAttachmentId(attachmentId: number | string) {
    const repo = this.db.getRepository('attachmentOcrResults');
    if (!repo) {
      return null;
    }

    return repo.findOne({
      filter: {
        attachmentId,
      },
      appends: ['attachment'],
    });
  }

  private async upsertOcrResult(attachmentId: number | string, values: Record<string, any>) {
    const repo = this.db.getRepository('attachmentOcrResults');
    if (!repo) {
      throw new Error('attachmentOcrResults repository not found');
    }

    const existing = await repo.findOne({
      filter: {
        attachmentId,
      },
    });
    const nextValues = {
      attachmentId,
      ...values,
    };

    if (existing) {
      await repo.update({
        filterByTk: existing.get('id'),
        values: nextValues,
      });
      return repo.findOne({
        filterByTk: existing.get('id'),
        appends: ['attachment'],
      });
    }

    const created = await repo.create({
      values: nextValues,
    });

    return repo.findOne({
      filterByTk: created.get('id'),
      appends: ['attachment'],
    });
  }

  private serializeOcrResult(record: any, attachmentId: number | string) {
    if (!record) {
      return {
        attachmentId,
        status: 'no-ocr',
        data: null,
        error: null,
      };
    }

    const json = typeof record.toJSON === 'function' ? record.toJSON() : record;
    return {
      id: json.id,
      attachmentId: json.attachmentId ?? attachmentId,
      status: json.status || 'no-ocr',
      data: json.data || null,
      error: json.error || null,
    };
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
    const streamParams = getAttachmentStreamParams(file.url || file.preview || file.path);
    const collectionNames = Array.from(
      new Set([streamParams.collection, file.collectionName, 'attachments', 'aiFiles'].filter(Boolean)),
    );

    const ids = [file.id, file.uid, streamParams.filterByTk].filter((value) => isLikelyRecordId(value));
    for (const collectionName of collectionNames) {
      if (!ctx.db.getCollection(collectionName)) continue;
      const repo = ctx.db.getRepository(collectionName);
      for (const id of ids) {
        const record = (await repo.findOne({ filterByTk: id })) || (await repo.findOne({ filter: { id } }));
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

    // Try finding by filename since dynamic virtual url columns may not be searchable in DB
    for (const collectionName of collectionNames) {
      if (!ctx.db.getCollection(collectionName)) continue;
      const repo = ctx.db.getRepository(collectionName);
      for (const urlCandidate of urlCandidates) {
        const cleanUrl = urlCandidate.split('?')[0];
        const filename = path.basename(cleanUrl);
        if (filename && filename !== 'file' && filename.includes('.')) {
          const filter: any = { filename };
          if (file.storageId) {
            filter.storageId = file.storageId;
          }
          const record = await repo.findOne({ filter });
          if (record) return record;
        }
      }
    }

    // Fallback for files from plugin-external-storage (which might not exist in attachments collection)
    if ((file.storageId || file.url?.includes('extStorage:download')) && (file.url || file.path || file.key)) {
      return file;
    }

    ctx.throw(404, 'Attachment not found for this preview file');
  }

  private getParentCollections(fileCollectionName: string) {
    const parents: Array<{
      collectionName: string;
      throughTable: string;
      otherKey: string;
      foreignKey?: string;
    }> = [];

    for (const collection of this.db.collections.values()) {
      if (collection.name === fileCollectionName) continue;

      for (const field of collection.fields.values()) {
        const options = field.options || {};
        if (field.type === 'belongsToMany' && options.target === fileCollectionName && options.through) {
          parents.push({
            collectionName: collection.name,
            throughTable: options.through,
            otherKey: options.otherKey || 'attachmentId',
            foreignKey: options.foreignKey || `${collection.model.name.toLowerCase()}Id`,
          });
        }
      }
    }

    return parents;
  }

  private async checkParentCollectionAccess(
    attachmentId: number | string,
    fileCollectionName: string,
    currentRoles: string[],
    ctx?: any,
  ): Promise<boolean> {
    const parents = this.getParentCollections(fileCollectionName);

    if (parents.length === 0) {
      const canView = this.app.acl.can({
        roles: currentRoles,
        resource: fileCollectionName,
        action: 'view',
      });
      return !!canView;
    }

    for (const parent of parents) {
      const canView = this.app.acl.can({
        roles: currentRoles,
        resource: parent.collectionName,
        action: 'view',
      });

      if (!canView) continue;

      try {
        const throughCollection = this.db.getCollection(parent.throughTable);
        if (throughCollection) {
          const links = await throughCollection.repository.find({
            filter: { [parent.otherKey]: attachmentId },
          });
          if (links.length > 0) {
            const parentIds = links.map((l) => l.get(parent['foreignKey'])).filter(Boolean);
            if (parentIds.length > 0) {
              let dataScopeFilter = canView.params?.filter || {};
              if (ctx && ctx.app.environment) {
                dataScopeFilter = ctx.app.environment.renderJsonTemplate(dataScopeFilter, {
                  $user: ctx.state.currentUser?.toJSON ? ctx.state.currentUser.toJSON() : ctx.state.currentUser,
                  $nRole: ctx.state.currentRole,
                });
              }

              const parentCollection = this.db.getCollection(parent.collectionName);
              const pk = parentCollection?.model?.primaryKeyAttribute || 'id';
              const count = await parentCollection.repository.count({
                filter: {
                  $and: [{ [pk]: { $in: parentIds } }, dataScopeFilter],
                },
              });
              if (count > 0) return true;
            }
          }
        }
      } catch (error) {
        this.log.warn(`[FilePreviewAuth] Failed to query through table "${parent.throughTable}":`, error.message);
      }
    }

    return false;
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
      userRoles.some(
        (role: any) => role === 'root' || role === 'admin' || role?.name === 'root' || role?.name === 'admin',
      );

    if (isOwner || isAdmin) {
      return;
    }

    // Delegate to parent collection ACL checks
    const attachmentId = getAttachmentValue(attachment, 'id');
    if (!attachmentId) {
      ctx.throw(403, 'Permission denied: virtual attachment cannot be accessed');
    }

    const collectionName =
      attachment.constructor?.collection?.name || getAttachmentValue(attachment, 'collectionName') || 'attachments';
    const hasParentAccess = await this.checkParentCollectionAccess(attachmentId, collectionName, currentRoles, ctx);
    if (!hasParentAccess) {
      ctx.throw(403, 'Permission denied: you do not have permission to access this attachment');
    }
  }

  private assertAuthenticated(ctx: any) {
    const currentUser = ctx.state.currentUser;
    if (!currentUser) {
      ctx.throw(401, 'Unauthorized');
    }
    return currentUser;
  }

  private async consumeUploadedParseFile(
    ctx: any,
  ): Promise<{ buffer: Buffer; attachment: any; cacheKey: string } | null> {
    if (!ctx.request?.is?.('multipart/*')) {
      return null;
    }

    const upload = (multer as any)({
      dest: os.tmpdir(),
      limits: { fileSize: MAX_RAW_PARSE_UPLOAD_BYTES },
    }).single('file');

    try {
      await upload(ctx, () => {});
    } catch (err: any) {
      ctx.throw(400, err?.message || 'Upload parsing error');
    }

    const file = ctx.file || ctx.request?.file;
    if (!file?.path) {
      ctx.throw(400, 'file is required');
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(file.path);
    } finally {
      unlink(file.path).catch(() => {});
    }

    const body = ctx.request.body || {};
    let attachment: any = {};
    if (body.attachment) {
      try {
        attachment = JSON.parse(body.attachment);
      } catch {
        attachment = {};
      }
    }

    attachment = {
      ...attachment,
      filename: attachment.filename || file.originalname,
      name: attachment.name || attachment.filename || file.originalname,
      mimetype: attachment.mimetype || file.mimetype,
      size: attachment.size || file.size,
    };

    return {
      buffer,
      attachment,
      cacheKey: [
        attachment.id ||
          attachment.uid ||
          attachment.url ||
          attachment.path ||
          file.originalname ||
          attachment.filename ||
          'file',
        attachment.lastModified || '',
        file.size || buffer.length,
      ].join(':'),
    };
  }

  private async extractUploadedFileText(buffer: Buffer, attachment: any): Promise<string> {
    const markitdownPlugin = this.getMarkItDownParserPlugin();
    const service = markitdownPlugin?.service;
    if (service?.convertBuffer) {
      try {
        if (!service.supports || service.supports(attachment)) {
          const text = await service.convertBuffer(buffer, attachment);
          if (text?.trim()) {
            return text;
          }
        }
      } catch (err) {
        this.log.warn(`[FilePreviewAuth] MarkItDown parser failed: ${err}`);
      }
    } else {
      this.log.warn(
        '[FilePreviewAuth] plugin-markitdown-parser not found; uploaded raw text parsing fallback will be used',
      );
    }

    if (isPlainTextAttachment(attachment)) {
      return buffer.toString('utf-8');
    }

    return '';
  }

  private getMarkItDownParserPlugin(): any | null {
    const candidates = ['@nocobase/plugin-markitdown-parser', 'plugin-markitdown-parser', 'markitdown-parser'];
    for (const name of candidates) {
      try {
        const plugin = this.pm.get(name) as any;
        if (plugin?.service?.convertBuffer) {
          return plugin;
        }
      } catch {
        // Try the next known plugin name.
      }
    }
    return null;
  }

  private async extractAttachmentText(ctx: any, attachment: any): Promise<string> {
    const docParserPlugin = (this.pm.get('@nocobase/plugin-document-parser') ||
      this.pm.get('plugin-document-parser')) as any;
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
    const attachmentObj = await this.prepareAttachmentForFileManager(attachment, fileManager);

    const { stream } = await fileManager.getFileStream(attachmentObj);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks as any[]).toString('utf-8');
  }

  private async prepareAttachmentForFileManager(attachment: any, fileManager: any, recordCollection?: any) {
    const attachmentObj = typeof attachment.toJSON === 'function' ? attachment.toJSON() : { ...attachment };
    const collection = this.resolveCollection(
      recordCollection || attachmentObj.collectionName || attachment.collectionName,
    );
    const storageId = await this.resolveStorageId(attachment, attachmentObj, fileManager, collection);
    if (!isMissingFileValue(storageId)) {
      attachmentObj.storageId = storageId;
    }

    this.copyFileFieldsFromRecord(attachment, attachmentObj);
    await this.ensureFileFields(attachment, attachmentObj, collection);
    this.copyFileFieldsFromRecord(attachment, attachmentObj);

    // Extract filename and path relative to storage.baseUrl if they are missing/invalid in the attachment object.
    // Internal stream URLs are route URLs, not storage object keys.
    if (attachmentObj.storageId && attachmentObj.url && !isInternalStreamUrl(attachmentObj.url)) {
      const storageModel = getStorageFromCache(fileManager.storagesCache, attachmentObj.storageId);
      if (storageModel) {
        const baseUrl = storageModel.baseUrl || '';
        let relativeUrl = attachmentObj.url.split('?')[0];
        if (baseUrl && relativeUrl.includes(baseUrl)) {
          relativeUrl = relativeUrl.substring(relativeUrl.indexOf(baseUrl) + baseUrl.length);
        }
        relativeUrl = relativeUrl.replace(/^\/|\/$/g, '');
        if (relativeUrl) {
          const parts = relativeUrl.split('/');
          const filename = parts.pop();
          const filePath = parts.join('/');
          if (filename && (!attachmentObj.filename || attachmentObj.filename === 'file')) {
            attachmentObj.filename = filename;
          }
          if (filePath && !attachmentObj.path) {
            attachmentObj.path = filePath;
          }
        }
      }
    }

    return attachmentObj;
  }

  private resolveCollection(recordCollection: any) {
    if (!recordCollection) {
      return undefined;
    }
    if (typeof recordCollection === 'string') {
      return this.db.getCollection(recordCollection);
    }
    return recordCollection;
  }

  private async resolveStorageId(record: any, recordObj: any, fileManager: any, recordCollection?: any) {
    const collectionName = recordCollection?.name || recordObj?.collectionName || record?.collectionName;
    const rawStorageId =
      getRecordStorageId(record) ??
      recordObj?.storageId ??
      recordObj?.storage_id ??
      recordObj?.storage?.id ??
      recordObj?.storage?.filterByTk;

    const matchedCacheKey = findStorageCacheKey(fileManager?.storagesCache, rawStorageId);
    if (!isMissingFileValue(matchedCacheKey)) {
      this.log.debug(
        `[FilePreviewAuth] storageId resolved from cache ${safeDebugJson({
          collection: collectionName,
          record: summarizeAttachmentForLog(recordObj, collectionName),
          rawStorageId: toDebugValue(rawStorageId),
          matchedCacheKey: toDebugValue(matchedCacheKey),
        })}`,
      );
      return matchedCacheKey;
    }

    const storageName = recordObj?.storage?.name || recordObj?.storageName;
    if (storageName && fileManager?.storagesCache) {
      for (const [key, storage] of fileManager.storagesCache.entries()) {
        if (storage?.name === storageName) {
          this.log.debug(
            `[FilePreviewAuth] storageId resolved by storage name ${safeDebugJson({
              collection: collectionName,
              storageName,
              matchedCacheKey: toDebugValue(key),
              storage: summarizeStorageForLog(storage),
            })}`,
          );
          return key;
        }
      }
    }

    const dbStorageId = await this.resolveStorageIdFromRecordTable(record, recordCollection);
    const matchedDbCacheKey = findStorageCacheKey(fileManager?.storagesCache, dbStorageId);
    if (!isMissingFileValue(matchedDbCacheKey)) {
      this.log.debug(
        `[FilePreviewAuth] storageId resolved from DB column and cache ${safeDebugJson({
          collection: collectionName,
          dbStorageId: toDebugValue(dbStorageId),
          matchedCacheKey: toDebugValue(matchedDbCacheKey),
        })}`,
      );
      return matchedDbCacheKey;
    }

    const storageId = !isMissingFileValue(dbStorageId) ? dbStorageId : rawStorageId;
    if (isMissingFileValue(storageId)) {
      const defaultStorageKey = findDefaultStorageCacheKey(fileManager?.storagesCache);
      this.log.debug(
        `[FilePreviewAuth] storageId missing; using default storage fallback ${safeDebugJson({
          collection: collectionName,
          defaultStorageKey: toDebugValue(defaultStorageKey),
          storageCache: summarizeStorageCache(fileManager?.storagesCache),
        })}`,
      );
      return defaultStorageKey;
    }

    const storageRepo = this.db.getRepository('storages');
    const storage = await storageRepo.findOne({ filterByTk: storageId });
    if (!storage) {
      this.log.debug(
        `[FilePreviewAuth] storageId not found in storages table; returning raw value ${safeDebugJson({
          collection: collectionName,
          storageId: toDebugValue(storageId),
        })}`,
      );
      return storageId;
    }

    const parsedStorage =
      typeof fileManager?.parseStorage === 'function' ? fileManager.parseStorage(storage) : storage.toJSON();
    fileManager?.storagesCache?.set?.(storage.get('id'), parsedStorage);
    this.log.debug(
      `[FilePreviewAuth] storageId resolved from storages table ${safeDebugJson({
        collection: collectionName,
        requestedStorageId: toDebugValue(storageId),
        resolvedStorageId: toDebugValue(storage.get('id')),
        storage: summarizeStorageForLog(parsedStorage),
      })}`,
    );
    return storage.get('id');
  }

  private async resolveStorageIdFromRecordTable(record: any, recordCollection?: any) {
    const collection = recordCollection || record?.constructor?.collection;
    if (!collection?.model) {
      return undefined;
    }

    const primaryKey = collection.model.primaryKeyAttribute || 'id';
    const recordId = record.get?.(primaryKey) ?? record.get?.('id') ?? record[primaryKey] ?? record.id;
    if (isMissingFileValue(recordId)) {
      return undefined;
    }

    let columns: Record<string, unknown>;
    try {
      columns = await this.db.sequelize.getQueryInterface().describeTable(collection.getTableNameWithSchema());
    } catch (error) {
      this.log.warn(`[FilePreviewAuth] Failed to inspect table "${collection.name}" for storageId:`, error.message);
      return undefined;
    }

    const rawAttributes = collection.model.rawAttributes || {};
    const storageColumn = findExistingColumn(columns, [
      rawAttributes.storageId?.field,
      rawAttributes.storage_id?.field,
      'storageId',
      'storage_id',
      'storageid',
    ]);
    if (!storageColumn) {
      return undefined;
    }

    const result = await collection.model.findOne({
      attributes: [[col(storageColumn), 'storageId']],
      where: { [primaryKey]: recordId },
      raw: true,
    });

    this.log.debug(
      `[FilePreviewAuth] storageId DB lookup ${safeDebugJson({
        collection: collection.name,
        table: String(collection.getTableNameWithSchema()),
        primaryKey,
        recordId: toDebugValue(recordId),
        storageColumn,
        dbStorageId: toDebugValue(result?.['storageId']),
      })}`,
    );

    return result?.['storageId'];
  }

  private async ensureFileFields(record: any, recordObj: any, recordCollection?: any) {
    const fileFields = ['key', 'filename', 'path', 'mimetype', 'title', 'extname', 'url'];
    const needsFileKey = !hasText(recordObj.key) && !hasText(recordObj.filename) && !hasText(recordObj.url);
    const missingFields = fileFields.filter((field) => isMissingFileValue(recordObj[field]));
    if (!needsFileKey && missingFields.length === 0) {
      return;
    }

    const fileData = await this.resolveFileFieldsFromRecordTable(record, fileFields, recordCollection);
    for (const field of fileFields) {
      if (!isMissingFileValue(fileData[field])) {
        recordObj[field] = fileData[field];
      }
    }
  }

  private copyFileFieldsFromRecord(record: any, recordObj: any) {
    for (const field of ['key', 'filename', 'path', 'mimetype', 'title', 'extname', 'url']) {
      if (!isMissingFileValue(recordObj[field])) {
        continue;
      }

      const value = record.get?.(field) ?? record.getDataValue?.(field) ?? record[field];
      if (!isMissingFileValue(value)) {
        recordObj[field] = value;
      }
    }
  }

  private async resolveFileFieldsFromRecordTable(record: any, fields: string[], recordCollection?: any) {
    const collection = recordCollection || record?.constructor?.collection;
    if (!collection?.model) {
      return {};
    }

    const primaryKey = collection.model.primaryKeyAttribute || 'id';
    const recordId = record.get?.(primaryKey) ?? record.get?.('id') ?? record[primaryKey] ?? record.id;
    if (isMissingFileValue(recordId)) {
      return {};
    }

    const rawAttributes = collection.model.rawAttributes || {};
    const attributes = fields
      .filter((field) => rawAttributes[field])
      .map((field) => [col(rawAttributes[field].field || field), field]);

    if (attributes.length === 0) {
      return {};
    }

    const result = await collection.model.findOne({
      attributes,
      where: { [primaryKey]: recordId },
      raw: true,
    });

    return result || {};
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
    const docParserPlugin = (this.pm.get('@nocobase/plugin-document-parser') ||
      this.pm.get('plugin-document-parser')) as any;
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

function isFilePreviewOcrWorker(app: Application) {
  return app.serving(WORKER_JOB_FILE_PREVIEW_OCR_PROCESS) || workerModeServesFilePreviewOcr();
}

function workerModeServesFilePreviewOcr() {
  const workerModes = String(process.env.WORKER_MODE || '')
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean);

  return workerModes.some((mode) => {
    if (mode === '*' || mode === 'worker' || mode === 'task' || mode === WORKER_JOB_FILE_PREVIEW_OCR_PROCESS) {
      return true;
    }
    return mode === FILE_PREVIEW_OCR_QUEUE_REDIS_KEY;
  });
}

function safeDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
  } catch (error) {
    return JSON.stringify({ error: 'failed_to_serialize_debug_payload' });
  }
}

function toDebugValue(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return value;
  }
  return String(value);
}

function getObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.keys(value);
}

function getDebugUrlPath(url: string) {
  if (!url) {
    return '';
  }
  try {
    return new URL(url, 'http://local').pathname;
  } catch {
    return 'unparseable';
  }
}

function summarizeAttachmentForLog(attachment: any, collectionName?: any) {
  return {
    id: toDebugValue(getAttachmentValue(attachment, 'id')),
    uid: toDebugValue(getAttachmentValue(attachment, 'uid')),
    collectionName: String(collectionName || getAttachmentValue(attachment, 'collectionName') || ''),
    storageId: toDebugValue(getAttachmentValue(attachment, 'storageId')),
    storageIdColumn: toDebugValue(getAttachmentValue(attachment, 'storage_id')),
    storageName: getAttachmentValue(attachment, 'storage')?.name || getAttachmentValue(attachment, 'storageName'),
    fieldsPresent: {
      key: hasText(getAttachmentValue(attachment, 'key')),
      filename: hasText(getAttachmentValue(attachment, 'filename')),
      path: hasText(getAttachmentValue(attachment, 'path')),
      url: hasText(getAttachmentValue(attachment, 'url')),
      preview: hasText(getAttachmentValue(attachment, 'preview')),
      mimetype: hasText(getAttachmentValue(attachment, 'mimetype')),
      title: hasText(getAttachmentValue(attachment, 'title')),
      extname: hasText(getAttachmentValue(attachment, 'extname')),
    },
  };
}

function summarizeStorageForLog(storage: any) {
  if (!storage) {
    return null;
  }
  return {
    id: toDebugValue(storage.id),
    name: storage.name,
    type: storage.type,
    default: Boolean(storage.default),
    public: Boolean(storage.options?.public),
    paranoid: Boolean(storage.paranoid),
    hasBucket: hasText(storage.options?.bucket),
    hasEndpoint: hasText(storage.options?.endpoint),
  };
}

function summarizeStorageCache(cache: Map<any, any> | undefined) {
  if (!cache) {
    return { size: 0, storages: [] };
  }

  return {
    size: cache.size,
    storages: Array.from(cache.entries())
      .slice(0, 20)
      .map(([key, storage]) => ({
        cacheKey: toDebugValue(key),
        ...summarizeStorageForLog(storage),
      })),
  };
}

function getStorageFromCache(cache: Map<any, any>, storageId: any) {
  if (storageId === undefined || storageId === null) return undefined;
  let res = cache.get(storageId);
  if (res) return res;
  const strId = String(storageId);
  res = cache.get(strId);
  if (res) return res;
  const numId = Number(storageId);
  if (!isNaN(numId)) {
    res = cache.get(numId);
    if (res) return res;
  }
  for (const [k, v] of cache.entries()) {
    if (String(k) === strId) {
      return v;
    }
  }
  return undefined;
}

function getAttachmentValue(attachment: any, key: string) {
  if (!attachment) return undefined;
  if (typeof attachment.get === 'function') return attachment.get(key);
  return attachment[key];
}

function getRecordStorageId(record: any) {
  if (!record) return undefined;
  return (
    record.get?.('storageId') ??
    record.get?.('storage_id') ??
    record.getDataValue?.('storageId') ??
    record.getDataValue?.('storage_id') ??
    record.storageId ??
    record.storage_id ??
    record.get?.('storage')?.id ??
    record.storage?.id
  );
}

function findStorageCacheKey(cache: Map<any, any> | undefined, storageId: any) {
  if (!cache || isMissingFileValue(storageId)) {
    return undefined;
  }

  if (cache.has(storageId)) {
    return storageId;
  }

  const strId = String(storageId);
  if (cache.has(strId)) {
    return strId;
  }

  const numericId = Number(storageId);
  if (Number.isFinite(numericId) && cache.has(numericId)) {
    return numericId;
  }

  for (const key of cache.keys()) {
    if (String(key) === strId) {
      return key;
    }
  }

  return undefined;
}

function findDefaultStorageCacheKey(cache: Map<any, any> | undefined) {
  if (!cache) {
    return undefined;
  }

  for (const [key, storage] of cache.entries()) {
    if (storage?.default) {
      return key;
    }
  }

  if (cache.size === 1) {
    return cache.keys().next().value;
  }

  return undefined;
}

function findExistingColumn(columns: Record<string, unknown>, candidates: Array<string | undefined>) {
  const columnNames = Object.keys(columns || {});

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Object.prototype.hasOwnProperty.call(columns, candidate)) {
      return candidate;
    }

    const matchedColumn = columnNames.find((columnName) => columnName.toLowerCase() === candidate.toLowerCase());
    if (matchedColumn) {
      return matchedColumn;
    }
  }

  return undefined;
}

function hasText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMissingFileValue(value: unknown) {
  return value === undefined || value === null || value === '';
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

function normalizeOcrAttachmentId(value: unknown): string | number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
  }

  return null;
}

function isInternalStreamUrl(value: any): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(decodePossiblyEncodedUrl(String(value)), 'http://local');
    return parsed.pathname.includes('/api/attachments:stream');
  } catch {
    return false;
  }
}

function getAttachmentStreamParams(value: any): { filterByTk?: string; collection?: string } {
  if (!isInternalStreamUrl(value)) return {};
  try {
    const parsed = new URL(decodePossiblyEncodedUrl(String(value)), 'http://local');
    return {
      filterByTk: parsed.searchParams.get('filterByTk') || undefined,
      collection: parsed.searchParams.get('collection') || undefined,
    };
  } catch {
    return {};
  }
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
