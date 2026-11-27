// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import { koaMulter } from '@nocobase/utils';
import { DocumentUnderstandingService } from './services/DocumentUnderstandingService';
import { FileInput } from './services/ExternalApiClient';
import { DU_BUSINESS_CATALOG } from './contracts/du-contracts';

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

const uploadOperationDocuments = koaMulter({
  storage: koaMulter.memoryStorage(),
  limits: { files: 20, fileSize: 64 * 1024 * 1024, fields: 10, fieldSize: 2 * 1024 * 1024 },
}).any();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const defineActions = (plugin: DocumentUnderstandingPluginLike) => {
  const service = plugin.service;

  return {
    async getConfig(ctx: Context, next: Next) {
      ctx.body = await service.getConfigForClient();
      await next();
    },

    async updateConfig(ctx: Context, next: Next) {
      const { values } = ctx.action.params;
      await service.updateConfig(values);
      ctx.body = await service.getConfig();
      await next();
    },

    async getHealth(ctx: Context, next: Next) {
      ctx.body = await service.getGatewayHealth();
      await next();
    },

    async listLlmServices(ctx: Context, next: Next) {
      await service.ensureInitialized();
      ctx.body = await service.orchestrator.builtinEngine.listAvailableLlmServices();
      await next();
    },

    async listCatalog(ctx: Context, next: Next) {
      ctx.body = DU_BUSINESS_CATALOG;
      await next();
    },

    async syncCatalog(ctx: Context, next: Next) {
      ctx.body = await service.syncCatalog();
      await next();
    },

    async listApiKeys(ctx: Context, next: Next) {
      await service.ensureInitialized();
      ctx.body = await service.orchestrator.listApiKeys();
      await next();
    },

    async issueApiKey(ctx: Context, next: Next) {
      await service.ensureInitialized();
      const { values } = ctx.action.params;
      if (!isRecord(values)) {
        ctx.throw(400, ctx.t('Invalid API key payload.', { ns: 'plugin-document-understanding' }));
      }
      ctx.set('Cache-Control', 'no-store');
      ctx.body = await service.orchestrator.issueApiKey({
        name: String(values.name || ''),
        tenantId: typeof values.tenantId === 'string' ? values.tenantId : 'default',
        allowedBusinesses: Array.isArray(values.allowedBusinesses) ? values.allowedBusinesses.map(String) : ['*'],
        allowedActions: Array.isArray(values.allowedActions) ? values.allowedActions.map(String) : ['*'],
        requestDefaults: isRecord(values.requestDefaults) ? values.requestDefaults : null,
        lockedFields: Array.isArray(values.lockedFields) ? values.lockedFields.map(String) : null,
        expiresAt: typeof values.expiresAt === 'string' ? values.expiresAt : null,
        userId: ctx.state?.currentUser?.id,
      });
      await next();
    },

    async revokeApiKey(ctx: Context, next: Next) {
      await service.ensureInitialized();
      const { filterByTk } = ctx.action.params;
      await service.orchestrator.revokeApiKey(Number(filterByTk));
      ctx.body = { message: 'ok' };
      await next();
    },

    async listOperations(ctx: Context, next: Next) {
      await service.ensureInitialized();
      const { filter } = ctx.action.params;
      const filterObj = isRecord(filter) ? filter : {};
      const res = await service.orchestrator.listOperations({
        tenantId: typeof filterObj.tenantId === 'string' ? filterObj.tenantId : '*',
        state: typeof filterObj.state === 'string' ? filterObj.state : undefined,
        businessId: typeof filterObj.businessId === 'string' ? filterObj.businessId : undefined,
        action: typeof filterObj.action === 'string' ? filterObj.action : undefined,
        limit: 50,
      });
      ctx.body = res.items;
      await next();
    },

    async getOperation(ctx: Context, next: Next) {
      await service.ensureInitialized();
      const { filterByTk } = ctx.action.params;
      const op = await service.orchestrator.getOperationRecordOrThrow('*', String(filterByTk));
      ctx.body = {
        ...service.orchestrator.toOperationView(op),
        outputPayload: op.outputPayload ?? null,
        resultEnvelope: op.resultEnvelope ?? null,
      };
      await next();
    },

    async submitOperation(ctx: Context, next: Next) {
      await service.ensureInitialized();
      let payload: unknown = ctx.action.params.values;
      const uploadedArtifactIds: string[] = [];

      if (ctx.request.is('multipart/form-data')) {
        await uploadOperationDocuments(ctx, async () => undefined);
        payload = ctx.request.body;
        const files: unknown = (ctx.request as typeof ctx.request & { files?: unknown }).files;
        if (Array.isArray(files)) {
          for (const file of files) {
            if (isRecord(file) && Buffer.isBuffer(file.buffer)) {
              const art = await service.orchestrator.artifactStorage.createReadyArtifactFromBuffer({
                tenantId: 'default',
                fileName: String(file.originalname || 'document.bin'),
                mimeType: String(file.mimetype || 'application/octet-stream'),
                buffer: file.buffer,
                userId: ctx.state?.currentUser?.id,
              });
              uploadedArtifactIds.push(art.artifactId);
            }
          }
        }
      }

      if (!isRecord(payload)) {
        ctx.throw(400, ctx.t('Invalid operation payload.', { ns: 'plugin-document-understanding' }));
      }
      const businessId = String(payload.businessId || 'document-core');
      const action = String(payload.action || 'ingest');
      let inputObj: unknown = payload.input ?? {};
      if (typeof inputObj === 'string') {
        try {
          inputObj = JSON.parse(inputObj);
        } catch {
          ctx.throw(400, ctx.t('Invalid JSON input.', { ns: 'plugin-document-understanding' }));
        }
      }
      let docSel: unknown = payload.documentSelection;
      if (typeof docSel === 'string' && docSel.trim()) {
        try {
          docSel = JSON.parse(docSel);
        } catch {
          ctx.throw(400, ctx.t('Invalid JSON input.', { ns: 'plugin-document-understanding' }));
        }
      }

      const explicitArtifacts = Array.isArray(payload.artifacts)
        ? (payload.artifacts as Array<{ artifactId: string }>)
        : [];
      const mergedArtifacts = [
        ...explicitArtifacts,
        ...uploadedArtifactIds.map((artifactId) => ({ artifactId, role: 'input' as const })),
      ];

      ctx.body = await service.orchestrator.submitOperation({
        principal: {
          kind: 'nocobase_user',
          tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : 'default',
          userId: ctx.state?.currentUser?.id,
          allowedBusinesses: ['*'],
          allowedActions: ['*'],
        },
        businessId,
        action,
        submission: {
          input: isRecord(inputObj) ? inputObj : {},
          artifacts: mergedArtifacts,
          documentSelection: isRecord(docSel) ? (docSel as never) : undefined,
        },
      });
      await next();
    },

    async cancelOperation(ctx: Context, next: Next) {
      await service.ensureInitialized();
      const { filterByTk } = ctx.action.params;
      ctx.body = await service.orchestrator.cancelOperation('*', String(filterByTk));
      await next();
    },

    async resumeOperation(ctx: Context, next: Next) {
      await service.ensureInitialized();
      const { filterByTk, values } = ctx.action.params;
      const body = isRecord(values) ? values : {};
      const input = isRecord(body.input) ? body.input : body;
      const currentUser = ctx.state?.currentUser as
        | { email?: string; username?: string; nickname?: string }
        | undefined;
      const resumedBy = currentUser?.email || currentUser?.username || currentUser?.nickname;
      ctx.body = await service.orchestrator.resumeOperation({
        tenantId: '*',
        operationId: String(filterByTk),
        waitId: typeof body.waitId === 'string' ? body.waitId : undefined,
        expectedStateVersion: body.expectedStateVersion !== undefined ? Number(body.expectedStateVersion) : undefined,
        input,
        resumedBy,
      });
      await next();
    },

    async getUsageSummary(ctx: Context, next: Next) {
      await service.ensureInitialized();
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const from = typeof ctx.action.params.from === 'string' ? ctx.action.params.from : defaultFrom;
      const to =
        typeof ctx.action.params.to === 'string'
          ? ctx.action.params.to
          : new Date(now.getTime() + 60_000).toISOString();
      ctx.body = await service.orchestrator.getUsageSummary({
        tenantId: '*',
        from,
        to,
      });
      await next();
    },

    async listEndpoints(ctx: Context, next: Next) {
      ctx.body = await service.listEndpoints();
      await next();
    },

    async createEndpoint(ctx: Context, next: Next) {
      const { values } = ctx.action.params;
      ctx.body = await service.createEndpoint(values);
      await next();
    },

    async updateEndpoint(ctx: Context, next: Next) {
      const { filterByTk, values } = ctx.action.params;
      await service.updateEndpoint(Number(filterByTk), values);
      ctx.body = { message: 'ok' };
      await next();
    },

    async deleteEndpoint(ctx: Context, next: Next) {
      const { filterByTk } = ctx.action.params;
      await service.deleteEndpoint(Number(filterByTk));
      ctx.body = { message: 'ok' };
      await next();
    },

    async listPipelines(ctx: Context, next: Next) {
      ctx.body = await service.listPipelines();
      await next();
    },

    async createPipeline(ctx: Context, next: Next) {
      const { values } = ctx.action.params;
      ctx.body = await service.createPipeline(values);
      await next();
    },

    async updatePipeline(ctx: Context, next: Next) {
      const { filterByTk, values } = ctx.action.params;
      await service.updatePipeline(Number(filterByTk), values);
      ctx.body = { message: 'ok' };
      await next();
    },

    async deletePipeline(ctx: Context, next: Next) {
      const { filterByTk } = ctx.action.params;
      await service.deletePipeline(Number(filterByTk));
      ctx.body = { message: 'ok' };
      await next();
    },

    async executePipeline(ctx: Context, next: Next) {
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

    async getJobStatus(ctx: Context, next: Next) {
      const { filterByTk } = ctx.action.params;
      ctx.body = await service.getJobStatus(Number(filterByTk));
      await next();
    },

    async listJobs(ctx: Context, next: Next) {
      const { filter } = ctx.action.params;
      ctx.body = await service.listJobs(filter);
      await next();
    },

    async cancelJob(ctx: Context, next: Next) {
      const { filterByTk } = ctx.action.params;
      ctx.body = await service.cancelJob(Number(filterByTk));
      await next();
    },

    async resumeJob(ctx: Context, next: Next) {
      const { filterByTk, values } = ctx.action.params;
      const body = isRecord(values) ? values : {};
      const currentUser = ctx.state?.currentUser as { email?: string; username?: string } | undefined;
      ctx.body = await service.resumeJob(Number(filterByTk), body, currentUser?.email || currentUser?.username);
      await next();
    },

    async webhookCallback(ctx: Context, next: Next) {
      const legacySig = ctx.get('x-webhook-signature') || undefined;
      const duSig = ctx.get('x-du-signature') || undefined;
      const duTimestamp = ctx.get('x-du-timestamp') || undefined;
      const duDeliveryId = ctx.get('x-du-delivery-id') || undefined;
      const rawPayload = ctx.action.params.values || ctx.request.body;
      try {
        await service.handleWebhook(isRecord(rawPayload) ? rawPayload : {}, legacySig, {
          signature: duSig,
          timestamp: duTimestamp,
          deliveryId: duDeliveryId,
        });
        ctx.body = { received: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        plugin.app.logger.warn(`Webhook callback error: ${msg}`);
        ctx.status = msg.includes('signature') ? 401 : 400;
        ctx.body = { error: msg };
      }
      await next();
    },
  };
};
