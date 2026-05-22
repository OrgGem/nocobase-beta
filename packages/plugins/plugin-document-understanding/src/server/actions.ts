import type { Context } from '@nocobase/actions';
import { DocumentUnderstandingService } from './services/DocumentUnderstandingService';

export const defineActions = (plugin: any) => {
  const service = plugin.service as DocumentUnderstandingService;

  return {
    async getConfig(ctx: Context, next: () => Promise<any>) {
      ctx.body = await service.getConfig();
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
      const { values } = ctx.action.params;
      const pipelineId = values?.pipelineId;
      const input = values?.input || {};
      const userId = ctx.state?.currentUser?.id;

      const multipartFiles: any[] = [];
      const filesObj = (ctx.request as any).files || (ctx.request as any).body?.files;
      if (filesObj) {
        const addFile = (key: string, file: any) => {
          const filePath = file.path || file.filepath;
          const fileName = file.name || file.originalFilename || 'file';
          const mimeType = file.type || file.mimetype || 'application/octet-stream';
          if (filePath) {
            try {
              const buffer = require('fs').readFileSync(filePath);
              multipartFiles.push({
                fieldName: key,
                buffer,
                filename: fileName,
                mimeType,
              });
            } catch (err) {
              console.error('Failed to read uploaded multipart file:', err);
            }
          }
        };

        if (typeof filesObj === 'object') {
          for (const [key, value] of Object.entries(filesObj)) {
            if (Array.isArray(value)) {
              for (const f of value) {
                addFile(key, f);
              }
            } else {
              addFile(key, value);
            }
          }
        }
      }

      ctx.body = await service.executePipeline(pipelineId, input, multipartFiles, userId);
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
        console.error('Webhook callback error:', err.message);
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
