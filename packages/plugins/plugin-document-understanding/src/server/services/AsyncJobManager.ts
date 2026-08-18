import { Database } from '@nocobase/database';
import { ExternalApiClient } from './ExternalApiClient';
import { EndpointDef } from '../types';

interface LoggerLike {
  warn: (...args: unknown[]) => void;
}

// Lease for inline (pending/running) execution. Refreshed at the start of every
// pipeline step; must outlive the slowest step (endpoint timeout x retries).
export const JOB_RUN_LEASE_MS = 10 * 60 * 1000;
// Lease for polling jobs. Refreshed on every poll tick, so it only needs to
// outlive a few missed ticks before another node may adopt the job.
const JOB_POLL_LEASE_MIN_MS = 60 * 1000;

export function pollLeaseMs(pollInterval?: number): number {
  return Math.max((pollInterval || 5000) * 3, JOB_POLL_LEASE_MIN_MS);
}

const JOBS_COLLECTION = 'doc_understanding_jobs';

export class AsyncJobManager {
  private db: Database;
  private apiClient: ExternalApiClient;
  private intervals: Map<number, NodeJS.Timeout> = new Map();
  private onJobComplete: (jobId: number, result: any) => Promise<void>;
  private onJobError: (jobId: number, error: string) => Promise<void>;
  private logger: LoggerLike;
  private nodeId: string;

  constructor(
    db: Database,
    apiClient: ExternalApiClient,
    callbacks: {
      onJobComplete: (jobId: number, result: any) => Promise<void>;
      onJobError: (jobId: number, error: string) => Promise<void>;
    },
    logger: LoggerLike,
    nodeId: string,
  ) {
    this.db = db;
    this.apiClient = apiClient;
    this.onJobComplete = callbacks.onJobComplete;
    this.onJobError = callbacks.onJobError;
    this.logger = logger;
    this.nodeId = nodeId;
  }

  async startPolling(
    jobId: number,
    endpoint: EndpointDef,
    taskId: string,
    customInterval?: number,
    customTimeout?: number,
  ): Promise<void> {
    // Don't start duplicate polling for same job
    if (this.intervals.has(jobId)) return;

    const interval = customInterval || endpoint.pollInterval || 5000;
    const timeout = customTimeout || endpoint.pollTimeout || 300000;
    const startTime = Date.now();

    const timer = setInterval(async () => {
      try {
        if (Date.now() - startTime > timeout) {
          this.stopPolling(jobId);
          await this.onJobError(jobId, 'Polling timeout exceeded');
          return;
        }

        // Renew our lease; if the row no longer matches (job finished, or another
        // node adopted it after our lease expired) stop polling immediately.
        if (!(await this.refreshLease(jobId, endpoint))) {
          this.stopPolling(jobId);
          return;
        }

        const pollResultSubpath = endpoint.pollResultSubpath;
        if (!pollResultSubpath) {
          this.stopPolling(jobId);
          await this.onJobError(jobId, 'Polling result subpath is not configured');
          return;
        }

        const url = pollResultSubpath.replace('{taskId}', taskId);
        const response = await this.apiClient.get(url);

        // Smart completion check: use pollStatusField if configured
        if (endpoint.pollStatusField) {
          const statusValue = this.getNestedValue(response, endpoint.pollStatusField);
          const completedValue = endpoint.pollCompletedValue || 'completed';
          if (String(statusValue) === completedValue) {
            const resultValue = endpoint.pollResultField
              ? this.getNestedValue(response, endpoint.pollResultField)
              : response;
            this.stopPolling(jobId);
            await this.onJobComplete(jobId, resultValue);
          } else if (statusValue === 'failed' || statusValue === 'error') {
            this.stopPolling(jobId);
            await this.onJobError(jobId, `External task failed with status: ${statusValue}`);
          }
          // Otherwise still pending, continue polling
        } else {
          // Fallback: check if result field has non-null value
          const resultValue = endpoint.pollResultField
            ? this.getNestedValue(response, endpoint.pollResultField)
            : response;
          if (resultValue !== undefined && resultValue !== null) {
            this.stopPolling(jobId);
            await this.onJobComplete(jobId, resultValue);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Polling error for job ${jobId}: ${message}`);
      }
    }, interval);

    this.intervals.set(jobId, timer);
  }

  private async refreshLease(jobId: number, endpoint: EndpointDef): Promise<boolean> {
    const jobsRepo = this.db.getRepository<any>(JOBS_COLLECTION);
    const updated = await jobsRepo.update({
      filter: { id: jobId, status: 'polling', ownedBy: this.nodeId },
      values: { leaseExpiresAt: new Date(Date.now() + pollLeaseMs(endpoint.pollInterval)) },
    });
    return Array.isArray(updated) ? updated.length > 0 : Boolean(updated);
  }

  /**
   * Fail pending/running jobs that can no longer be executing. First the jobs
   * this node owned (in-memory execution state is lost across a restart), then
   * any remaining job whose owner lease expired. Rows without a lease predate
   * ownership tracking and are treated as orphaned too.
   */
  async failOrphanedActiveJobs(): Promise<void> {
    const jobsRepo = this.db.getRepository<any>(JOBS_COLLECTION);
    const now = new Date();

    await jobsRepo.update({
      filter: { status: { $in: ['pending', 'running'] }, ownedBy: this.nodeId },
      values: { status: 'failed', error: 'Server restarted during execution', completedAt: now },
    });

    await jobsRepo.update({
      filter: {
        status: { $in: ['pending', 'running'] },
        $or: [{ leaseExpiresAt: { $lt: now } }, { leaseExpiresAt: null }],
      },
      values: { status: 'failed', error: 'Job lease expired before completion', completedAt: now },
    });
  }

  /**
   * Re-adopt 'polling' jobs whose owner can no longer be polling them: jobs this
   * node owned before a restart, jobs whose lease expired, and legacy rows without
   * ownership. Webhook-mode jobs are skipped — nothing polls them, and any node
   * can process the webhook when it arrives.
   */
  async adoptOrphanedPollingJobs(): Promise<void> {
    const jobsRepo = this.db.getRepository<any>(JOBS_COLLECTION);
    const now = new Date();
    const candidates = await jobsRepo.find({
      filter: {
        status: 'polling',
        $or: [{ ownedBy: this.nodeId }, { leaseExpiresAt: { $lt: now } }, { ownedBy: null }],
      },
    });

    for (const job of candidates) {
      const externalTaskIds = (job.externalTaskIds || {}) as Record<string, string>;
      const stepKey = String(job.currentStep);
      const taskId = externalTaskIds[stepKey];
      if (!taskId) continue;

      const pipelineRepo = this.db.getRepository('doc_understanding_pipelines');
      const pipeline = await pipelineRepo.findOne({
        filter: { id: job.pipelineId },
        appends: ['steps', 'steps.endpoint'],
      });
      if (!pipeline) continue;

      const steps = ((pipeline as any).steps || []) as Array<{ stepOrder: number; endpoint?: EndpointDef }>;
      const step = steps.find((s) => s.stepOrder === job.currentStep);
      if (!step?.endpoint || step.endpoint.executionMode !== 'polling') continue;

      if (await this.claimJobForPolling(job.id, step.endpoint)) {
        await this.startPolling(job.id, step.endpoint, taskId);
      }
    }
  }

  private async claimJobForPolling(jobId: number, endpoint: EndpointDef): Promise<boolean> {
    return this.db.sequelize.transaction(async (transaction: { LOCK: { UPDATE: string } }): Promise<boolean> => {
      const jobsRepo = this.db.getRepository<any>(JOBS_COLLECTION);
      const row = await jobsRepo.findOne({ filterByTk: jobId, transaction, lock: transaction.LOCK.UPDATE });
      if (!row) return false;
      if (String(row.get('status')) !== 'polling') return false;

      const owner = row.get('ownedBy') as string | null;
      const lease = row.get('leaseExpiresAt') as Date | string | null;
      const leaseValid = lease != null && new Date(lease).getTime() > Date.now();
      // A different node still owns the job with a valid lease: leave it alone.
      if (owner !== this.nodeId && leaseValid) return false;

      await jobsRepo.update({
        filterByTk: jobId,
        values: {
          ownedBy: this.nodeId,
          leaseExpiresAt: new Date(Date.now() + pollLeaseMs(endpoint.pollInterval)),
        },
        transaction,
      });
      return true;
    });
  }

  stopPolling(jobId: number) {
    const timer = this.intervals.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.intervals.delete(jobId);
    }
  }

  destroy() {
    for (const timer of this.intervals.values()) {
      clearInterval(timer);
    }
    this.intervals.clear();
  }

  private getNestedValue(obj: any, path: string): any {
    if (!obj) return obj;
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }
}
