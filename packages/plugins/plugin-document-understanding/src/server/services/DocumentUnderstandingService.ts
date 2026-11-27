// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import type { Application } from '@nocobase/server';
import type { Database } from '@nocobase/database';
import { ExternalApiClient, FileInput } from './ExternalApiClient';
import { AsyncJobManager } from './AsyncJobManager';
import { PipelineExecutor } from './PipelineExecutor';
import { ArtifactStorageService } from './ArtifactStorageService';
import { BuiltinBusinessEngine } from './BuiltinBusinessEngine';
import { ExternalDuReworkClient } from './ExternalDuReworkClient';
import { OperationOrchestrator } from './OperationOrchestrator';
import { seedDugateEndpoints } from '../dugate-seed';
import { ClientServiceConfig, ServiceConfig, EndpointDef, PipelineDef, JobState } from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DocumentUnderstandingService {
  private app: Application;
  private db: Database;
  private apiClient!: ExternalApiClient;
  private pipelineExecutor!: PipelineExecutor;
  private jobManager!: AsyncJobManager;
  public orchestrator!: OperationOrchestrator;
  private initialized = false;
  private startupRecoveryCompleted = false;
  private initializationPromise?: Promise<void>;
  private maintenanceTimer?: NodeJS.Timeout;
  private processedWebhookDeliveries = new Set<string>();
  private readonly nodeId: string;
  private static readonly HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  private static readonly MAINTENANCE_INTERVAL_MS = 30_000;

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;
    this.nodeId = `${app?.name || 'app'}:${process.pid}:${crypto.randomUUID()}`;
  }

  async initialize(options: { recoverJobs?: boolean } = {}): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = this.doInitialize(options.recoverJobs ?? false).finally(() => {
      this.initializationPromise = undefined;
    });
    await this.initializationPromise;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.initialize();
  }

  private async doInitialize(recoverJobs: boolean): Promise<void> {
    const config = await this.ensureConfig();

    this.jobManager?.destroy();
    this.stopMaintenance();

    const artifactStorage = new ArtifactStorageService(this.db);
    const builtinEngine = new BuiltinBusinessEngine(this.app, artifactStorage, async (pipelineRef, input, userId) => {
      const pipelines = await this.listPipelines();
      const target = pipelineRef.pipelineId
        ? pipelines.find((p) => p.id === pipelineRef.pipelineId)
        : pipelines.find((p) => p.name === pipelineRef.pipelineName);
      if (!target) {
        throw new Error(`Referenced pipeline ${pipelineRef.pipelineName || pipelineRef.pipelineId} not found`);
      }
      const { jobId } = await this.executePipeline(target.id, input, [], userId);
      const deadline = Date.now() + (config.pollTimeout || 120_000);
      while (Date.now() < deadline) {
        const j = await this.getJobStatus(jobId);
        if (j.status === 'completed') {
          return isRecord(j.finalResult) ? j.finalResult : { result: j.finalResult };
        }
        if (['failed', 'cancelled', 'timeout'].includes(j.status)) {
          throw new Error(j.error || `Pipeline job #${jobId} ended with ${j.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(`Schema workflow pipeline #${target.id} timed out`);
    });

    this.orchestrator = new OperationOrchestrator({
      app: this.app,
      db: this.db,
      artifactStorage,
      builtinEngine,
      getConfig: () => this.getConfig(),
      nodeId: this.nodeId,
    });

    this.apiClient = new ExternalApiClient(config);
    this.jobManager = new AsyncJobManager(
      this.db,
      this.apiClient,
      {
        onJobComplete: async (jobId, result) => {
          await this.pipelineExecutor.resumeFromStep(jobId, result);
        },
        onJobError: async (jobId, error) => {
          const jobsRepo = this.db.getRepository('doc_understanding_jobs');
          await jobsRepo.update({
            filterByTk: jobId,
            values: { status: 'failed', error, completedAt: new Date() },
          });
        },
      },
      this.app.logger,
      this.nodeId,
    );

    this.pipelineExecutor = new PipelineExecutor(
      this.db,
      this.apiClient,
      this.jobManager,
      this.app.logger,
      this.nodeId,
      this.orchestrator,
    );

    if (recoverJobs && !this.startupRecoveryCompleted) {
      await this.maintainJobs();
      this.startupRecoveryCompleted = true;
    }
    this.startMaintenance();

    this.initialized = true;
  }

  async maintainJobs(): Promise<void> {
    if (!this.jobManager) return;
    try {
      await this.jobManager.failOrphanedActiveJobs();
      await this.jobManager.adoptOrphanedPollingJobs();
    } catch (err) {
      this.app.logger.warn('Document Understanding: job maintenance sweep failed.', err);
    }
  }

  private startMaintenance(): void {
    this.stopMaintenance();
    this.maintenanceTimer = setInterval(() => {
      this.maintainJobs();
    }, DocumentUnderstandingService.MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref?.();
  }

  private stopMaintenance(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
  }

  private async ensureConfig(): Promise<ServiceConfig> {
    const configRepo = this.db.getRepository('doc_understanding_config');
    let config = await configRepo.findOne();

    if (!config) {
      config = await configRepo.create({
        values: {
          baseUrl: 'http://localhost:8000',
          authType: 'none',
          defaultTimeout: 30000,
          defaultRetries: 2,
          pollInterval: 5000,
          pollTimeout: 300000,
          engineMode: 'builtin',
          maxFileSizeBytes: 10485760,
          maxFilesPerRequest: 20,
          publicGatewayEnabled: true,
        },
      });
    }

    return config.toJSON() as ServiceConfig;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async getConfig(): Promise<ServiceConfig> {
    return this.ensureConfig();
  }

  async getConfigForClient(): Promise<ClientServiceConfig> {
    const { authKey, webhookSecret, ...config } = await this.ensureConfig();
    return {
      ...config,
      hasAuthKey: Boolean(authKey),
      hasWebhookSecret: Boolean(webhookSecret),
    };
  }

  async updateConfig(data: Partial<ServiceConfig>): Promise<void> {
    const configRepo = this.db.getRepository('doc_understanding_config');
    const conf = await configRepo.findOne();
    if (conf) {
      const values = { ...data };
      if (!values.authKey) delete values.authKey;
      if (!values.webhookSecret) delete values.webhookSecret;
      await configRepo.update({ filterByTk: conf.id, values });
    }
    await this.initialize();
  }

  async getGatewayHealth(): Promise<Record<string, unknown>> {
    await this.ensureInitialized();
    const config = await this.getConfig();
    const llmServices = await this.orchestrator.builtinEngine.listAvailableLlmServices();
    let externalStatus: Record<string, unknown> | undefined;
    if (config.engineMode === 'du_rework' || config.engineMode === 'hybrid') {
      const extClient = new ExternalDuReworkClient(config);
      externalStatus = await extClient.checkHealth();
    }
    return {
      status: 'ok',
      engineMode: config.engineMode || 'builtin',
      publicGatewayEnabled: config.publicGatewayEnabled !== false,
      builtinAiAvailable: llmServices.length > 0 || Boolean(this.orchestrator.builtinEngine.resolveAiManager()),
      llmServiceCount: llmServices.length,
      ...(externalStatus ? { externalGateway: externalStatus } : {}),
      businesses: [
        { businessId: 'document-core', version: '2.0.0', state: 'ACTIVE' },
        { businessId: 'lc-checker', version: '1.2.0', state: 'ACTIVE' },
        { businessId: 'example-review', version: '1.0.0', state: 'ACTIVE' },
      ],
    };
  }

  async syncCatalog(): Promise<{ endpoints: number; pipelines: number }> {
    return seedDugateEndpoints(this.db);
  }

  destroy(): void {
    this.stopMaintenance();
    this.jobManager?.destroy();
    this.initialized = false;
    this.startupRecoveryCompleted = false;
  }

  async listEndpoints(): Promise<EndpointDef[]> {
    await this.ensureInitialized();
    const rows = await this.db.getRepository('doc_understanding_endpoints').find({ sort: 'sortOrder' });
    return rows as unknown as EndpointDef[];
  }

  async createEndpoint(data: Partial<EndpointDef>): Promise<EndpointDef> {
    const created = await this.db
      .getRepository('doc_understanding_endpoints')
      .create({ values: this.normalizeEndpoint(data) });
    return created as unknown as EndpointDef;
  }

  async updateEndpoint(id: number, data: Partial<EndpointDef>): Promise<void> {
    await this.db.getRepository('doc_understanding_endpoints').update({
      filterByTk: id,
      values: this.normalizeEndpoint(data),
    });
  }

  private normalizeEndpoint(data: Partial<EndpointDef> = {}): Partial<EndpointDef> {
    if (!Object.prototype.hasOwnProperty.call(data, 'customHeaders')) {
      return data;
    }
    return {
      ...data,
      customHeaders: this.normalizeHeaders(data.customHeaders),
    };
  }

  private normalizeHeaders(headers?: Record<string, unknown>): Record<string, string> {
    const normalized: Record<string, string> = {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
      return normalized;
    }

    for (const [rawName, rawValue] of Object.entries(headers)) {
      const name = rawName.trim();
      if (!name) continue;
      if (!DocumentUnderstandingService.HEADER_NAME_RE.test(name)) {
        throw new Error(`Invalid HTTP header name: ${rawName}`);
      }
      if (rawValue === undefined || rawValue === null) continue;
      normalized[name] = String(rawValue);
    }
    return normalized;
  }

  async deleteEndpoint(id: number): Promise<void> {
    await this.db.getRepository('doc_understanding_endpoints').destroy({ filterByTk: id });
  }

  async listPipelines(): Promise<PipelineDef[]> {
    await this.ensureInitialized();
    const rows = await this.db.getRepository('doc_understanding_pipelines').find({
      appends: ['steps', 'steps.endpoint'],
    });
    return rows as unknown as PipelineDef[];
  }

  async createPipeline(data: Partial<PipelineDef>): Promise<PipelineDef> {
    this.validateStepAliases(data.steps);
    const created = await this.db.getRepository('doc_understanding_pipelines').create({ values: data });
    return created as unknown as PipelineDef;
  }

  async updatePipeline(id: number, data: Partial<PipelineDef>): Promise<void> {
    this.validateStepAliases(data.steps);
    await this.db.getRepository('doc_understanding_pipelines').update({ filterByTk: id, values: data });
  }

  private validateStepAliases(steps?: Array<{ outputAlias?: string }>) {
    if (!steps) return;
    const aliases = steps.map((s) => s.outputAlias).filter(Boolean);
    const unique = new Set(aliases);
    if (unique.size !== aliases.length) {
      throw new Error('Pipeline steps must have unique outputAlias values');
    }
  }

  async deletePipeline(id: number): Promise<void> {
    await this.db.getRepository('doc_understanding_pipelines').destroy({ filterByTk: id });
  }

  async executePipeline(
    pipelineId: number,
    input: Record<string, unknown>,
    files: FileInput[] = [],
    userId?: number,
  ): Promise<{ jobId: number }> {
    await this.ensureInitialized();
    const job = await this.pipelineExecutor.execute(pipelineId, input, files, userId);
    return { jobId: job.id };
  }

  async getJobStatus(jobId: number, userId?: number): Promise<JobState> {
    const filter = userId ? { id: jobId, createdById: userId } : { id: jobId };
    const job = await this.db.getRepository('doc_understanding_jobs').findOne({ filter });
    if (!job) throw new Error('Job not found');
    return job as unknown as JobState;
  }

  async listJobs(filters?: Record<string, unknown>, userId?: number): Promise<JobState[]> {
    const filter = userId ? { ...(filters || {}), createdById: userId } : filters;
    const rows = await this.db.getRepository('doc_understanding_jobs').find({
      filter,
      sort: ['-createdAt'],
    });
    return rows as unknown as JobState[];
  }

  async cancelJob(jobId: number): Promise<JobState> {
    await this.ensureInitialized();
    const job = await this.getJobStatus(jobId);
    this.jobManager.stopPolling(jobId);
    if (job.operationId) {
      await this.orchestrator.cancelOperation('*', job.operationId).catch(() => undefined);
    }
    await this.db.getRepository('doc_understanding_jobs').update({
      filterByTk: jobId,
      values: {
        status: 'cancelled',
        completedAt: new Date(),
        leaseExpiresAt: null,
      },
    });
    return this.getJobStatus(jobId);
  }

  async resumeJob(jobId: number, input: Record<string, unknown>, resumedBy?: string): Promise<JobState> {
    await this.ensureInitialized();
    const job = await this.getJobStatus(jobId);
    if (job.status !== 'waiting_input' || !job.operationId) {
      throw new Error(`Job #${jobId} is not waiting for human input`);
    }
    await this.orchestrator.resumeOperation({
      tenantId: '*',
      operationId: job.operationId,
      input,
      resumedBy,
    });
    const opView = await this.orchestrator.waitForOperation('*', job.operationId, 30);
    if (opView.state === 'SUCCEEDED') {
      const opRecord = await this.orchestrator.getOperationRecordOrThrow('*', job.operationId);
      await this.pipelineExecutor.resumeFromStep(jobId, {
        ...(opRecord.outputPayload || {}),
        usage: opRecord.usage,
        operationId: opRecord.operationId,
      });
    }
    return this.getJobStatus(jobId);
  }

  async handleWebhook(
    payload: Record<string, unknown>,
    signature?: string,
    duHeaders?: { signature?: string; timestamp?: string; deliveryId?: string },
  ): Promise<void> {
    await this.ensureInitialized();
    const config = await this.getConfig();

    if (duHeaders?.deliveryId && this.processedWebhookDeliveries.has(duHeaders.deliveryId)) {
      return;
    }

    if (config.webhookSecret) {
      const effectiveSig = duHeaders?.signature || signature;
      if (!effectiveSig) {
        throw new Error('Webhook signature missing');
      }
      const rawJson = JSON.stringify(payload);
      const signedInput = duHeaders?.timestamp ? `${duHeaders.timestamp}.${rawJson}` : rawJson;
      const expected = crypto.createHmac('sha256', config.webhookSecret).update(signedInput).digest('hex');
      const signatureHash = effectiveSig.startsWith('sha256=') ? effectiveSig.slice(7) : effectiveSig;
      const sigBuf = Buffer.from(signatureHash, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        throw new Error('Webhook signature verification failed');
      }
    }

    const taskId = String(payload.operationId ?? payload.task_id ?? payload.operation_id ?? '');
    if (!taskId) throw new Error('Webhook missing task_id / operationId');

    if (duHeaders?.deliveryId) {
      this.processedWebhookDeliveries.add(duHeaders.deliveryId);
    }

    const jobsRepo = this.db.getRepository('doc_understanding_jobs');
    const PAGE_SIZE = 100;
    let offset = 0;
    let hasMoreJobs = true;

    while (hasMoreJobs) {
      const jobs = await jobsRepo.find({
        filter: { status: { $in: ['polling', 'waiting_input'] } },
        limit: PAGE_SIZE,
        offset,
      });

      if (jobs.length === 0) break;

      for (const job of jobs) {
        const extIds = Object.values((job.externalTaskIds as Record<string, string>) || {});
        if (extIds.includes(taskId) || job.operationId === taskId) {
          if (payload.state === 'WAITING_INPUT' && isRecord(payload.wait)) {
            await jobsRepo.update({
              filterByTk: job.id,
              values: { status: 'waiting_input', waitState: payload.wait, leaseExpiresAt: null },
            });
            return;
          }
          await this.pipelineExecutor.resumeFromStep(job.id, payload.result || payload);
          return;
        }
      }

      hasMoreJobs = jobs.length >= PAGE_SIZE;
      if (hasMoreJobs) {
        offset += PAGE_SIZE;
      }
    }

    throw new Error(`Job not found for webhook task ${taskId}`);
  }
}
