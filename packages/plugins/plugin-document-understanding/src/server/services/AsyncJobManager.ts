import { Database } from '@nocobase/database';
import { ExternalApiClient } from './ExternalApiClient';
import { EndpointDef, JobState } from '../types';

interface LoggerLike {
  warn: (...args: unknown[]) => void;
}

export class AsyncJobManager {
  private db: Database;
  private apiClient: ExternalApiClient;
  private intervals: Map<number, NodeJS.Timeout> = new Map();
  private onJobComplete: (jobId: number, result: any) => Promise<void>;
  private onJobError: (jobId: number, error: string) => Promise<void>;
  private logger: LoggerLike;

  constructor(
    db: Database,
    apiClient: ExternalApiClient,
    callbacks: {
      onJobComplete: (jobId: number, result: any) => Promise<void>;
      onJobError: (jobId: number, error: string) => Promise<void>;
    },
    logger: LoggerLike,
  ) {
    this.db = db;
    this.apiClient = apiClient;
    this.onJobComplete = callbacks.onJobComplete;
    this.onJobError = callbacks.onJobError;
    this.logger = logger;
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

        const pollResultSubpath = endpoint.pollResultSubpath;
        if (!pollResultSubpath) {
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

  /**
   * Transition pending and running jobs to failed state during startup.
   */
  async cleanupStuckJobs(): Promise<void> {
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    const stuckJobs = await jobsRepo.find({
      filter: {
        status: ['pending', 'running'],
      },
    });

    for (const job of stuckJobs) {
      await jobsRepo.update({
        filterByTk: job.id,
        values: {
          status: 'failed',
          error: 'Server restarted during execution',
          completedAt: new Date(),
        },
      });
    }
  }

  /**
   * Recover polling jobs that were in-flight when server restarted.
   * Call this during service initialization.
   */
  async recoverPollingJobs(): Promise<void> {
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    const stuckJobs = await jobsRepo.find({ filter: { status: 'polling' } });

    for (const job of stuckJobs) {
      if (!job.externalTaskIds) continue;

      // Find the current step's endpoint and taskId
      const stepKey = job.currentStep.toString();
      const taskId = job.externalTaskIds[stepKey];
      if (!taskId) continue;

      // We need the endpoint definition for this step
      const pipelineRepo = this.db.getRepository('doc_understanding_pipelines');
      const pipeline = await pipelineRepo.findOne({
        filter: { id: job.pipelineId },
        appends: ['steps', 'steps.endpoint'],
      });

      if (!pipeline) continue;

      const step = (pipeline as any).steps?.find((s: any) => s.stepOrder === job.currentStep);
      if (!step?.endpoint || step.endpoint.executionMode !== 'polling') continue;

      await this.startPolling(job.id, step.endpoint, taskId);
    }
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
