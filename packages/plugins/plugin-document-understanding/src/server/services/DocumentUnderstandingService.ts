import * as crypto from 'crypto';
import { Application } from '@nocobase/server';
import { Database, Repository } from '@nocobase/database';
import { ExternalApiClient, FileInput } from './ExternalApiClient';
import { AsyncJobManager } from './AsyncJobManager';
import { PipelineExecutor } from './PipelineExecutor';
import { ServiceConfig, EndpointDef, PipelineDef, JobState } from '../types';

export class DocumentUnderstandingService {
  private app: Application;
  private db: Database;
  private apiClient!: ExternalApiClient;
  private pipelineExecutor!: PipelineExecutor;
  private jobManager!: AsyncJobManager;
  private initialized = false;
  private static readonly HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

  constructor(app: Application, db: Database) {
    this.app = app;
    this.db = db;
  }

  async initialize(): Promise<void> {
    const configRepo = this.db.getRepository<any>('doc_understanding_config');
    let config = await configRepo.findOne();

    // Create default config if not exists
    if (!config) {
      config = await configRepo.create({
        values: {
          baseUrl: 'http://localhost:8000',
          authType: 'none',
          defaultTimeout: 30000,
          defaultRetries: 2,
          pollInterval: 5000,
          pollTimeout: 300000,
        },
      });
    }

    this.apiClient = new ExternalApiClient(config);
    this.jobManager = new AsyncJobManager(this.db, this.apiClient, {
      onJobComplete: async (jobId, result) => {
        await this.pipelineExecutor.resumeFromStep(jobId, result);
      },
      onJobError: async (jobId, error) => {
        const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
        await jobsRepo.update({
          filterByTk: jobId,
          values: { status: 'failed', error, completedAt: new Date() },
        });
      },
    });

    this.pipelineExecutor = new PipelineExecutor(this.db, this.apiClient, this.jobManager);

    // Clean up stuck jobs (pending/running) that were in-flight when server restarted
    await this.jobManager.cleanupStuckJobs();

    // Recover any polling jobs that were in-flight before server restart
    await this.jobManager.recoverPollingJobs();

    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async getConfig(): Promise<ServiceConfig> {
    const configRepo = this.db.getRepository<any>('doc_understanding_config');
    const conf = await configRepo.findOne();
    if (!conf) throw new Error('Config not found');
    return conf;
  }

  async updateConfig(data: Partial<ServiceConfig>): Promise<void> {
    const configRepo = this.db.getRepository<any>('doc_understanding_config');
    const conf = await configRepo.findOne();
    if (conf) {
      await configRepo.update({ filterByTk: conf.id, values: data });
    }
    // Reinitialize to pick up new config
    await this.initialize();
  }

  async listEndpoints(): Promise<EndpointDef[]> {
    return this.db.getRepository<any>('doc_understanding_endpoints').find({ sort: 'sortOrder' });
  }

  async createEndpoint(data: Partial<EndpointDef>): Promise<EndpointDef> {
    return this.db.getRepository<any>('doc_understanding_endpoints').create({ values: this.normalizeEndpoint(data) });
  }

  async updateEndpoint(id: number, data: Partial<EndpointDef>): Promise<void> {
    await this.db.getRepository<any>('doc_understanding_endpoints').update({
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

  private normalizeHeaders(headers?: Record<string, any>): Record<string, string> {
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
    await this.db.getRepository<any>('doc_understanding_endpoints').destroy({ filterByTk: id });
  }

  async listPipelines(): Promise<PipelineDef[]> {
    return this.db.getRepository<any>('doc_understanding_pipelines').find({
      appends: ['steps', 'steps.endpoint'],
    });
  }

  async createPipeline(data: Partial<PipelineDef>): Promise<PipelineDef> {
    this.validateStepAliases(data.steps);
    return this.db.getRepository<any>('doc_understanding_pipelines').create({ values: data });
  }

  async updatePipeline(id: number, data: Partial<PipelineDef>): Promise<void> {
    this.validateStepAliases(data.steps);
    await this.db.getRepository<any>('doc_understanding_pipelines').update({ filterByTk: id, values: data });
  }

  private validateStepAliases(steps?: any[]) {
    if (!steps) return;
    const aliases = steps.map((s) => s.outputAlias).filter(Boolean);
    const unique = new Set(aliases);
    if (unique.size !== aliases.length) {
      throw new Error('Pipeline steps must have unique outputAlias values');
    }
  }

  async deletePipeline(id: number): Promise<void> {
    await this.db.getRepository<any>('doc_understanding_pipelines').destroy({ filterByTk: id });
  }

  async executePipeline(
    pipelineId: number,
    input: Record<string, any>,
    files: FileInput[] = [],
    userId?: number,
  ): Promise<{ jobId: number }> {
    if (!this.isReady()) throw new Error('Service not ready');
    const job = await this.pipelineExecutor.execute(pipelineId, input, files, userId);
    return { jobId: job.id };
  }

  async getJobStatus(jobId: number): Promise<JobState> {
    const job = await this.db.getRepository<any>('doc_understanding_jobs').findOne({ filterByTk: jobId });
    if (!job) throw new Error('Job not found');
    return job;
  }

  async listJobs(filters?: any): Promise<JobState[]> {
    return this.db.getRepository<any>('doc_understanding_jobs').find({
      filter: filters,
      sort: ['-createdAt'],
    });
  }

  async handleWebhook(payload: any, signature?: string): Promise<void> {
    // Verify webhook signature if secret is configured
    const config = await this.getConfig();
    if (config.webhookSecret) {
      if (!signature) {
        throw new Error('Webhook signature missing');
      }
      const expected = crypto.createHmac('sha256', config.webhookSecret).update(JSON.stringify(payload)).digest('hex');
      const signatureHash = signature.startsWith('sha256=') ? signature.slice(7) : signature;
      if (!crypto.timingSafeEqual(Buffer.from(signatureHash, 'hex'), Buffer.from(expected, 'hex'))) {
        throw new Error('Webhook signature verification failed');
      }
    }

    const taskId = payload.task_id;
    const result = payload.result;
    if (!taskId) throw new Error('Webhook missing task_id');

    // Paginated search to avoid loading all polling jobs into memory
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    const PAGE_SIZE = 100;
    let offset = 0;
    let hasMoreJobs = true;

    while (hasMoreJobs) {
      const jobs = await jobsRepo.find({
        filter: { status: 'polling' },
        limit: PAGE_SIZE,
        offset,
      });

      if (jobs.length === 0) break;

      for (const job of jobs) {
        if (Object.values(job.externalTaskIds || {}).includes(taskId)) {
          await this.pipelineExecutor.resumeFromStep(job.id, result || payload);
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
