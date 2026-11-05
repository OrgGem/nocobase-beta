/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { koaMulter } from '@nocobase/utils';
import { DocumentUnderstandingService } from './services/DocumentUnderstandingService';
import { FileInput } from './services/ExternalApiClient';

interface LoggerLike {
  warn: (...args: unknown[]) => void;
}

interface DocumentUnderstandingPluginLike {
  service: DocumentUnderstandingService;
  app: {
    logger: LoggerLike;
  };
}

// Parse uploads after resource ACL. Memory storage never accepts or opens a client-supplied local path.
const uploadDocuments = koaMulter({
  storage: koaMulter.memoryStorage(),
  limits: { files: 5, fileSize: 20 * 1024 * 1024, fields: 2, fieldSize: 1024 * 1024, parts: 8 },
}).any();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const defineActions = (plugin: DocumentUnderstandingPluginLike) => {
  const service = plugin.service;

  return {
    async getConfig(ctx: Context, next: () => Promise<any>) {
      ctx.body = await service.getConfigForClient();
      await next();
    },

    async updateConfig(ctx: Context, next: () => Promise<any>) {
      const { values } = ctx.action.params;
      await service.updateConfig(values);
      ctx.body = await service.getConfig();
      await next();
    },

    async listEndpoints(ctx: Context, next: () => Promise<any>) {
      ctx.body = await service.listEndpoints();
      await next();
    },

    async createEndpoint(ctx: Context, next: () => Promise<any>) {
      const { values } = ctx.action.params;
      ctx.body = await service.createEndpoint(values);
      await next();
    },

    async updateEndpoint(ctx: Context, next: () => Promise<any>) {
      const { filterByTk, values } = ctx.action.params;
      await service.updateEndpoint(Number(filterByTk), values);
      ctx.body = { message: 'ok' };
      await next();
    },

    async deleteEndpoint(ctx: Context, next: () => Promise<any>) {
      const { filterByTk } = ctx.action.params;
      await service.deleteEndpoint(Number(filterByTk));
      ctx.body = { message: 'ok' };
      await next();
    },

    async listPipelines(ctx: Context, next: () => Promise<any>) {
      ctx.body = await service.listPipelines();
      await next();
    },

    async createPipeline(ctx: Context, next: () => Promise<any>) {
      const { values } = ctx.action.params;
      ctx.body = await service.createPipeline(values);
      await next();
    },

    async updatePipeline(ctx: Context, next: () => Promise<any>) {
      const { filterByTk, values } = ctx.action.params;
      await service.updatePipeline(Number(filterByTk), values);
      ctx.body = { message: 'ok' };
      await next();
    },

    async deletePipeline(ctx: Context, next: () => Promise<any>) {
      const { filterByTk } = ctx.action.params;
      await service.deletePipeline(Number(filterByTk));
      ctx.body = { message: 'ok' };
      await next();
    },

    async executePipeline(ctx: Context, next: () => Promise<any>) {
      let values: unknown = ctx.action.params.values;
      const multipartFiles: FileInput[] = [];
      if (ctx.request.is('multipart/form-data')) {
        try {
          await uploadDocuments(ctx, async () => undefined);
        } catch (error: unknown) {
          const limited = isRecord(error) && typeof error.code === 'string' && error.code.startsWith('LIMIT_');
          ctx.throw(limited ? 413 : 400, ctx.t('Invalid document upload.', { ns: 'plugin-document-understanding' }));
        }
        values = ctx.request.body;
        const files: unknown = (ctx.request as typeof ctx.request & { files?: unknown }).files;
        if (Array.isArray(files)) {
          for (const file of files) {
            if (!isRecord(file) || !Buffer.isBuffer(file.buffer)) {
              ctx.throw(400, ctx.t('Invalid document upload.', { ns: 'plugin-document-understanding' }));
            }
            multipartFiles.push({
              fieldName: String(file.fieldname),
              buffer: file.buffer,
              filename: String(file.originalname),
              mimeType: String(file.mimetype),
            });
          }
        }
      }
      if (!isRecord(values) || Object.prototype.hasOwnProperty.call(values, 'files')) {
        ctx.throw(400, ctx.t('Invalid pipeline input.', { ns: 'plugin-document-understanding' }));
      }
      const pipelineId = Number(values.pipelineId);
      let input: unknown = values.input ?? {};
      if (ctx.request.is('multipart/form-data') && typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          ctx.throw(400, ctx.t('Invalid pipeline input.', { ns: 'plugin-document-understanding' }));
        }
      }
      if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0 || !isRecord(input)) {
        ctx.throw(400, ctx.t('Invalid pipeline input.', { ns: 'plugin-document-understanding' }));
      }
      ctx.body = await service.executePipeline(pipelineId, input, multipartFiles, ctx.state?.currentUser?.id);
      await next();
    },

    async getJobStatus(ctx: Context, next: () => Promise<any>) {
      const { filterByTk } = ctx.action.params;
      ctx.body = await service.getJobStatus(Number(filterByTk));
      await next();
    },

    async listJobs(ctx: Context, next: () => Promise<any>) {
      const { filter } = ctx.action.params;
      ctx.body = await service.listJobs(filter);
      await next();
    },

    async webhookCallback(ctx: Context, next: () => Promise<any>) {
      const signature = ctx.request.headers['x-webhook-signature'] as string;
      const { values } = ctx.action.params;
      try {
        await service.handleWebhook(values || ctx.request.body, signature);
        ctx.body = { received: true };
      } catch (err: any) {
        plugin.app.logger.warn(`Webhook callback error: ${err.message}`);
        if (err.message.includes('signature')) {
          ctx.status = 401;
          ctx.body = { error: err.message };
        } else {
          ctx.status = 400;
          ctx.body = { error: err.message };
        }
      }
      await next();
    },
  };
};
