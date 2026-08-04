import { existsSync, realpathSync, readFileSync, statSync } from 'fs';
import { basename, resolve, sep } from 'path';
import { Database } from '@nocobase/database';
import mime from 'mime-types';
import { ExternalApiClient, FileInput } from './ExternalApiClient';
import { AsyncJobManager } from './AsyncJobManager';
import { PipelineDef, PipelineStepDef, JobState, EndpointDef } from '../types';

interface LoggerLike {
  error: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

interface FileReferenceInput {
  buffer?: Buffer;
  url?: string;
  fieldName?: string;
}

const UPLOAD_ROOTS = [resolve(process.cwd(), 'storage', 'uploads')];

const isInsidePath = (basePath: string, targetPath: string) =>
  targetPath === basePath || targetPath.startsWith(`${basePath}${sep}`);

export function resolveUploadFilePath(urlOrPath: string): string | null {
  if (!urlOrPath || urlOrPath.includes('\0')) return null;

  let pathname = urlOrPath.replace(/\\/g, '/').split(/[?#]/)[0];
  try {
    if (pathname.startsWith('http://') || pathname.startsWith('https://')) {
      pathname = new URL(pathname).pathname;
    }
  } catch {
    return null;
  }

  pathname = decodeURIComponent(pathname).replace(/^\/+/, '');
  const uploadsIndex = pathname.indexOf('uploads/');
  if (pathname.startsWith('storage/uploads/')) {
    pathname = pathname.slice('storage/uploads/'.length);
  } else if (pathname.startsWith('uploads/')) {
    pathname = pathname.slice('uploads/'.length);
  } else if (uploadsIndex >= 0) {
    pathname = pathname.slice(uploadsIndex + 'uploads/'.length);
  } else {
    return null;
  }

  const parts = pathname.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part.includes('\0'))) return null;

  for (const root of UPLOAD_ROOTS) {
    const candidate = resolve(root, ...parts);
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    if (!existsSync(candidate)) continue;
    const realCandidate = realpathSync(candidate);
    if (isInsidePath(realRoot, realCandidate) && statSync(realCandidate).isFile()) {
      return realCandidate;
    }
  }

  return null;
}

export interface ExecutionContext {
  input: Record<string, any>;
  files: FileInput[];
  stepResults: Record<string, any>;
  jobId: number;
}

export class PipelineExecutor {
  private db: Database;
  private apiClient: ExternalApiClient;
  private jobManager: AsyncJobManager;
  private logger: LoggerLike;

  constructor(db: Database, apiClient: ExternalApiClient, jobManager: AsyncJobManager, logger: LoggerLike) {
    this.db = db;
    this.apiClient = apiClient;
    this.jobManager = jobManager;
    this.logger = logger;
  }

  private async resolveFile(urlOrPath: string, fieldName = 'file'): Promise<FileInput | null> {
    if (!urlOrPath || typeof urlOrPath !== 'string') return null;

    try {
      const localPath = resolveUploadFilePath(urlOrPath);
      if (localPath) {
        const buffer = readFileSync(localPath);
        const mimeType = mime.lookup(localPath) || 'application/octet-stream';

        return {
          fieldName,
          buffer,
          filename: basename(localPath),
          mimeType,
        };
      }

      // Only files in NocoBase's upload storage are accepted. Fetching arbitrary
      // HTTP(S) URLs here would turn a user/AI-provided value into an SSRF primitive.
      if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
        this.logger.warn?.('Ignoring remote file URL; use a NocoBase upload URL instead.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn?.(`Failed to resolve file input: ${message}`);
    }

    return null;
  }

  async execute(
    pipelineId: number,
    input: Record<string, any>,
    files: FileInput[] = [],
    userId?: number,
  ): Promise<JobState> {
    const pipelineRepo = this.db.getRepository<any>('doc_understanding_pipelines');
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');

    const pipeline = await pipelineRepo.findOne({
      filter: { id: pipelineId },
      appends: ['steps', 'steps.endpoint'],
    });

    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);
    if (!pipeline.enabled) throw new Error(`Pipeline ${pipelineId} is disabled`);

    // Create Job
    const job = await jobsRepo.create({
      values: {
        pipelineId,
        status: 'pending',
        input,
        currentStep: 1, // 1-based ordering
        stepResults: {},
        externalTaskIds: {},
        startedAt: new Date(),
        createdById: userId,
      },
    });

    const resolvedFiles: FileInput[] = [];

    const tryAddFile = async (urlOrPath: string, fieldName = 'file') => {
      const resolved = await this.resolveFile(urlOrPath, fieldName);
      if (resolved) {
        resolvedFiles.push(resolved);
      }
    };

    // 1. Process files argument
    if (Array.isArray(files)) {
      for (const f of files) {
        if (f && typeof f === 'object') {
          const fileRef = f as FileReferenceInput;
          if (fileRef.buffer) {
            resolvedFiles.push(f);
          } else if (fileRef.url) {
            await tryAddFile(fileRef.url, fileRef.fieldName || 'file');
          }
        }
      }
    }

    // 2. Scan input for common file URL keys
    const urlFields = ['file_url', 'file_urls', 'file', 'files'];
    for (const key of urlFields) {
      const val = input[key];
      if (!val) continue;

      if (typeof val === 'string') {
        if (
          val.startsWith('http://') ||
          val.startsWith('https://') ||
          val.startsWith('/') ||
          val.startsWith('storage/')
        ) {
          await tryAddFile(val, 'file');
        } else if (val.includes(',')) {
          const urls = val.split(',').map((s) => s.trim());
          for (const u of urls) {
            if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('/') || u.startsWith('storage/')) {
              await tryAddFile(u, 'file');
            }
          }
        }
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string') {
            if (
              item.startsWith('http://') ||
              item.startsWith('https://') ||
              item.startsWith('/') ||
              item.startsWith('storage/')
            ) {
              await tryAddFile(item, 'file');
            }
          } else if (item && typeof item === 'object' && item.url) {
            await tryAddFile(item.url, 'file');
          }
        }
      } else if (val && typeof val === 'object' && val.url) {
        await tryAddFile(val.url, 'file');
      }
    }

    if (resolvedFiles.length === 0 && files && files.length > 0) {
      for (const f of files) {
        if ((f as FileReferenceInput).buffer) {
          resolvedFiles.push(f);
        }
      }
    }

    const context: ExecutionContext = {
      input,
      files: resolvedFiles,
      stepResults: {},
      jobId: job.id,
    };

    // Sorting steps by order
    const steps = [...(pipeline.steps || [])].sort((a, b) => a.stepOrder - b.stepOrder);

    // Run steps (Synchronous part)
    this.runSteps(job, steps, context).catch((err) => {
      this.logger.error(`Background pipeline error for job ${job.id}`, err);
    });

    return job;
  }

  private async runSteps(job: JobState, steps: PipelineStepDef[], context: ExecutionContext, startFromOrder = 1) {
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    let currentOrder = startFromOrder;

    try {
      await jobsRepo.update({ filterByTk: job.id, values: { status: 'running' } });

      for (const step of steps) {
        if (step.stepOrder < startFromOrder) continue;

        context.jobId = job.id;
        currentOrder = step.stepOrder;

        await jobsRepo.update({ filterByTk: job.id, values: { currentStep: currentOrder } });

        if (!this.evaluateCondition(step.condition, context)) {
          continue; // Skip step
        }

        if (!step.endpoint?.enabled) {
          throw new Error(`Endpoint for step ${step.name} is disabled`);
        }

        const mappedBody = this.resolveMapping(step.inputMapping || {}, context);
        let retries = step.onError === 'retry' ? step.retryCount || 0 : 0;
        let success = false;
        let lastError = null;

        while (retries >= 0 && !success) {
          try {
            const fileFieldName = step.endpoint.fileFieldName || 'file';
            const mappedFiles = context.files
              ? context.files.map((f) => ({
                  ...f,
                  fieldName: fileFieldName,
                }))
              : [];

            const result = await this.apiClient.call({
              endpoint: step.endpoint,
              body: mappedBody,
              files: mappedFiles,
            });

            if (step.endpoint.executionMode === 'sync') {
              context.stepResults[step.outputAlias || step.stepOrder.toString()] = result.data;
              success = true;
            } else if (step.endpoint.executionMode === 'polling') {
              // Extract taskId from result based on pollTaskIdField
              const taskIdField = step.endpoint.pollTaskIdField || 'task_id';
              const taskId = this.getNestedValue(result.data, taskIdField);

              if (!taskId) throw new Error(`Polling taskId not found in field ${taskIdField}`);

              const externalTaskIds = job.externalTaskIds || {};
              externalTaskIds[step.stepOrder.toString()] = taskId;

              await jobsRepo.update({
                filterByTk: job.id,
                values: { status: 'polling', externalTaskIds },
              });

              await this.jobManager.startPolling(job.id, step.endpoint, taskId);

              // Halt execution. Polling callback will resume from next step.
              return;
            } else if (step.endpoint.executionMode === 'webhook') {
              // Wait for webhook
              const taskIdField = step.endpoint.pollTaskIdField || 'task_id';
              const taskId = this.getNestedValue(result.data, taskIdField);
              const externalTaskIds = job.externalTaskIds || {};
              externalTaskIds[step.stepOrder.toString()] = taskId;

              await jobsRepo.update({
                filterByTk: job.id,
                values: { status: 'polling', externalTaskIds },
              });

              // End execution. Webhook will resume.
              return;
            }
          } catch (err: any) {
            lastError = err;
            retries--;
          }
        }

        if (!success) {
          if (step.onError === 'fail') {
            throw lastError || new Error(`Step ${step.name} failed`);
          }
          // if 'skip', we continue the loop
        }
      }

      // If loop completes without being halted for async
      await this.finishJob(job.id, context);
    } catch (err: any) {
      await jobsRepo.update({
        filterByTk: job.id,
        values: { status: 'failed', error: err.message, completedAt: new Date() },
      });
    }
  }

  async resumeFromStep(jobId: number, asyncResult: any) {
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    const pipelineRepo = this.db.getRepository<any>('doc_understanding_pipelines');

    const job = await jobsRepo.findOne({ filterByTk: jobId });
    if (!job) throw new Error(`Job ${jobId} not found`);

    const pipeline = await pipelineRepo.findOne({
      filter: { id: job.pipelineId },
      appends: ['steps', 'steps.endpoint'],
    });

    if (!pipeline) throw new Error(`Pipeline not found for job ${jobId}`);

    const steps = [...(pipeline.steps || [])].sort((a, b) => a.stepOrder - b.stepOrder);
    const step = steps.find((s) => s.stepOrder === job.currentStep);

    if (step) {
      job.stepResults = job.stepResults || {};
      job.stepResults[step.outputAlias || step.stepOrder.toString()] = asyncResult;

      await jobsRepo.update({
        filterByTk: jobId,
        values: { stepResults: job.stepResults }, // updating stepResults json
      });
    }

    const context: ExecutionContext = {
      input: job.input,
      files: [], // Files cannot easily persist across webhook unless stored in bucket. For now assume next steps use only json.
      stepResults: job.stepResults,
      jobId: job.id,
    };

    // resume from next step
    this.runSteps(job, steps, context, job.currentStep + 1).catch((err) => {
      this.logger.error(`Failed executing step ${job.currentStep + 1} for job ${job.id}`, err);
    });
  }

  private async finishJob(jobId: number, context: ExecutionContext) {
    const jobsRepo = this.db.getRepository<any>('doc_understanding_jobs');
    const pipelineRepo = this.db.getRepository<any>('doc_understanding_pipelines');
    const job = await jobsRepo.findOne({ filterByTk: jobId });
    if (!job) return;

    const pipeline = await pipelineRepo.findOne({ filter: { id: job.pipelineId } });
    if (!pipeline) return;

    const finalResult = pipeline.outputMapping
      ? this.resolveMapping(pipeline.outputMapping, context)
      : context.stepResults;

    await jobsRepo.update({
      filterByTk: jobId,
      values: {
        status: 'completed',
        stepResults: context.stepResults,
        finalResult,
        completedAt: new Date(),
      },
    });
  }

  private resolveMapping(mapping: Record<string, string>, context: ExecutionContext): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(mapping)) {
      if (typeof value === 'string') {
        if (value.startsWith('$input.')) {
          result[key] = this.getNestedValue(context.input, value.replace('$input.', ''));
        } else if (value.startsWith('$step[')) {
          const match = value.match(/\$step\[(.*?)\]\.response\.(.*)/);
          if (match) {
            const stepKey = match[1];
            const path = match[2];
            const stepResult = context.stepResults[stepKey];
            result[key] = this.getNestedValue(stepResult, path);
          } else {
            result[key] = value;
          }
        } else if (value === '$files') {
          // special case: mapping wants files. Not mapped here as form data handles files via input.files.
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value; // copy raw if not string mapping
      }
    }
    return result;
  }

  private evaluateCondition(condition: any, context: ExecutionContext): boolean {
    if (!condition) return true;

    const resolveValue = (v: any) => {
      if (typeof v === 'string' && v.startsWith('$')) {
        // Resolve simple $ expressions
        if (v.startsWith('$step[')) {
          const match = v.match(/\$step\[(.*?)\]\.response\.(.*)/);
          if (match) return this.getNestedValue(context.stepResults[match[1]], match[2]);
        }
      }
      return v;
    };

    const fieldVal = resolveValue(condition.field);
    const val = resolveValue(condition.value);

    switch (condition.op) {
      case 'eq':
        return fieldVal === val;
      case 'neq':
        return fieldVal !== val;
      case 'gt':
        return fieldVal > val;
      case 'gte':
        return fieldVal >= val;
      case 'lt':
        return fieldVal < val;
      case 'lte':
        return fieldVal <= val;
      case 'in':
        return Array.isArray(val) && val.includes(fieldVal);
      case 'contains':
        return typeof fieldVal === 'string' && fieldVal.includes(String(val));
      default:
        return false;
    }
  }

  private getNestedValue(obj: any, path: string): any {
    if (!obj) return obj;
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }
}
