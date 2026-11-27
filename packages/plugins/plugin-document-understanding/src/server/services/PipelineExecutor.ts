// SPDX-License-Identifier: Apache-2.0

import { existsSync, realpathSync, readFileSync, statSync } from 'fs';
import { basename, resolve, sep } from 'path';
import type { Database } from '@nocobase/database';
import mime from 'mime-types';
import { ExternalApiClient, FileInput } from './ExternalApiClient';
import { AsyncJobManager, JOB_RUN_LEASE_MS, pollLeaseMs } from './AsyncJobManager';
import type { OperationOrchestrator } from './OperationOrchestrator';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract a task/operation ID from a 202 Accepted response.
 * Priority:
 * 1. `taskIdExtractPath` + optional `taskIdExtractRegex` (e.g. path="operationId" or path="name", regex="operations/([^/]+)")
 * 2. `pollTaskIdField` (default "task_id")
 * 3. `operationId` field fallback
 * 4. Raw response body as string fallback
 */
function extractTaskId(responseData: unknown, endpoint: EndpointDef): string | null {
  const extractPath = endpoint.taskIdExtractPath?.trim();
  if (extractPath && isRecord(responseData)) {
    const raw = extractPath.split('.').reduce<unknown>((acc, k) => (isRecord(acc) ? acc[k] : undefined), responseData);
    if (raw != null) {
      const regex = endpoint.taskIdExtractRegex?.trim();
      if (regex) {
        try {
          const m = String(raw).match(new RegExp(regex));
          if (m?.[1]) return m[1];
        } catch {
          /* invalid regex, fall through */
        }
      }
      return String(raw);
    }
  }

  const idField = endpoint.pollTaskIdField || 'task_id';
  if (isRecord(responseData)) {
    const fieldVal = idField.split('.').reduce<unknown>((acc, k) => (isRecord(acc) ? acc[k] : undefined), responseData);
    if (fieldVal != null) return String(fieldVal);
    if (typeof responseData.operationId === 'string') return responseData.operationId;
  }

  if (typeof responseData === 'string') return responseData;
  if (typeof responseData === 'number') return String(responseData);

  return null;
}

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
  input: Record<string, unknown>;
  files: FileInput[];
  artifactIds?: string[];
  stepResults: Record<string, unknown>;
  jobId: number;
  userId?: number;
}

export class PipelineExecutor {
  private db: Database;
  private apiClient: ExternalApiClient;
  private jobManager: AsyncJobManager;
  private logger: LoggerLike;
  private nodeId: string;
  private orchestrator?: OperationOrchestrator;

  constructor(
    db: Database,
    apiClient: ExternalApiClient,
    jobManager: AsyncJobManager,
    logger: LoggerLike,
    nodeId = '',
    orchestrator?: OperationOrchestrator,
  ) {
    this.db = db;
    this.apiClient = apiClient;
    this.jobManager = jobManager;
    this.logger = logger;
    this.nodeId = nodeId;
    this.orchestrator = orchestrator;
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
          mimeType: String(mimeType),
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
    input: Record<string, unknown>,
    files: FileInput[] = [],
    userId?: number,
  ): Promise<JobState> {
    const pipelineRepo = this.db.getRepository('doc_understanding_pipelines');
    const jobsRepo = this.db.getRepository('doc_understanding_jobs');

    const pipeline = await pipelineRepo.findOne({
      filter: { id: pipelineId },
      appends: ['steps', 'steps.endpoint'],
    });

    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);
    if (!pipeline.enabled) throw new Error(`Pipeline ${pipelineId} is disabled`);

    const job = (await jobsRepo.create({
      values: {
        pipelineId,
        status: 'pending',
        input,
        currentStep: 1,
        stepResults: {},
        externalTaskIds: {},
        startedAt: new Date(),
        createdById: userId,
        ownedBy: this.nodeId,
        leaseExpiresAt: new Date(Date.now() + JOB_RUN_LEASE_MS),
      },
    })) as unknown as JobState;

    const resolvedFiles: FileInput[] = [];

    const tryAddFile = async (urlOrPath: string, fieldName = 'file') => {
      const resolved = await this.resolveFile(urlOrPath, fieldName);
      if (resolved) {
        resolvedFiles.push(resolved);
      }
    };

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

    const urlFields = ['file_url', 'file_urls', 'file', 'files'];
    for (const key of urlFields) {
      const val = input[key];
      if (!val) continue;

      if (typeof val === 'string') {
        if (
          val.startsWith('http://') ||
          val.startsWith('https://') ||
          val.startsWith('/') ||
          val.startsWith('storage/') ||
          val.startsWith('uploads/')
        ) {
          await tryAddFile(val, 'file');
        } else if (val.includes(',')) {
          const urls = val.split(',').map((s) => s.trim());
          for (const u of urls) {
            if (
              u.startsWith('http://') ||
              u.startsWith('https://') ||
              u.startsWith('/') ||
              u.startsWith('storage/') ||
              u.startsWith('uploads/')
            ) {
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
              item.startsWith('storage/') ||
              item.startsWith('uploads/')
            ) {
              await tryAddFile(item, 'file');
            }
          } else if (isRecord(item) && typeof item.url === 'string') {
            await tryAddFile(item.url, 'file');
          }
        }
      } else if (isRecord(val) && typeof val.url === 'string') {
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
      userId,
    };

    const rawSteps = (pipeline as unknown as PipelineDef).steps || [];
    const steps = [...rawSteps].sort((a, b) => a.stepOrder - b.stepOrder);

    this.runSteps(job, steps, context).catch((err) => {
      this.logger.error(`Background pipeline error for job ${job.id}`, err);
    });

    return job;
  }

  private async ensureArtifactsForContext(context: ExecutionContext): Promise<string[]> {
    if (context.artifactIds) return context.artifactIds;
    const ids: string[] = [];
    if (Array.isArray(context.input.artifactIds)) {
      for (const id of context.input.artifactIds) {
        if (typeof id === 'string' && id.trim()) ids.push(id.trim());
      }
    }
    if (this.orchestrator && context.files.length > 0) {
      for (const file of context.files) {
        const created = await this.orchestrator.artifactStorage.createReadyArtifactFromBuffer({
          tenantId: 'default',
          fileName: file.filename,
          mimeType: file.mimeType,
          buffer: file.buffer,
          userId: context.userId,
        });
        ids.push(created.artifactId);
      }
    }
    context.artifactIds = ids;
    return ids;
  }

  private isCanonicalEndpoint(endpoint: EndpointDef): boolean {
    if (!this.orchestrator) return false;
    return (
      endpoint.protocolMode === 'builtin_du' ||
      endpoint.protocolMode === 'du_rework_v1' ||
      Boolean(endpoint.businessId && endpoint.actionName)
    );
  }

  private async executeCanonicalStep(
    job: JobState,
    step: PipelineStepDef,
    mappedBody: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<{ halted: boolean; responsePayload?: Record<string, unknown> }> {
    if (!this.orchestrator) {
      throw new Error('OperationOrchestrator is not attached');
    }

    const endpoint = step.endpoint;
    const businessId = endpoint.businessId || 'document-core';
    const action = endpoint.actionName || 'ingest';
    const stepInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(mappedBody || {})) {
      if (v !== undefined) stepInput[k] = v;
    }
    if (endpoint.discriminatorField && endpoint.discriminatorValue) {
      stepInput[endpoint.discriminatorField] = endpoint.discriminatorValue;
    }

    const artifactIds = await this.ensureArtifactsForContext(context);
    const submitted = await this.orchestrator.submitOperation({
      principal: {
        kind: 'nocobase_user',
        tenantId: 'default',
        userId: context.userId,
        allowedBusinesses: ['*'],
        allowedActions: ['*'],
      },
      businessId,
      action,
      submission: {
        input: stepInput,
        artifacts: artifactIds.map((artifactId) => ({ artifactId, role: 'input' })),
        documentSelection: isRecord(context.input.documentSelection)
          ? (context.input.documentSelection as never)
          : undefined,
      },
      waitCompletionMs: endpoint.pollTimeout || 120_000,
    });

    const opRecord = await this.orchestrator.getOperationRecordOrThrow('default', submitted.operationId);
    const jobsRepo = this.db.getRepository('doc_understanding_jobs');

    if (opRecord.state === 'WAITING_INPUT') {
      const externalTaskIds = { ...(job.externalTaskIds || {}), [String(step.stepOrder)]: opRecord.operationId };
      await jobsRepo.update({
        filterByTk: job.id,
        values: {
          status: 'waiting_input',
          operationId: opRecord.operationId,
          waitState: opRecord.waitState,
          usage: opRecord.usage,
          externalTaskIds,
          leaseExpiresAt: null,
        },
      });
      return { halted: true };
    }

    if (opRecord.state !== 'SUCCEEDED') {
      throw new Error(
        opRecord.errorProblem?.detail || opRecord.errorProblem?.title || `Operation ended in state ${opRecord.state}`,
      );
    }

    await jobsRepo.update({
      filterByTk: job.id,
      values: {
        operationId: opRecord.operationId,
        usage: opRecord.usage ?? null,
      },
    });

    return {
      halted: false,
      responsePayload: {
        ...(opRecord.outputPayload || {}),
        usage: opRecord.usage,
        operationId: opRecord.operationId,
      },
    };
  }

  private async runSteps(job: JobState, steps: PipelineStepDef[], context: ExecutionContext, startFromOrder = 1) {
    const jobsRepo = this.db.getRepository('doc_understanding_jobs');
    let currentOrder = startFromOrder;

    try {
      await jobsRepo.update({
        filterByTk: job.id,
        values: { status: 'running', ownedBy: this.nodeId, leaseExpiresAt: new Date(Date.now() + JOB_RUN_LEASE_MS) },
      });

      for (const step of steps) {
        if (step.stepOrder < startFromOrder) continue;

        context.jobId = job.id;
        currentOrder = step.stepOrder;

        await jobsRepo.update({
          filterByTk: job.id,
          values: { currentStep: currentOrder, leaseExpiresAt: new Date(Date.now() + JOB_RUN_LEASE_MS) },
        });

        if (!this.evaluateCondition(step.condition, context)) {
          continue;
        }

        if (!step.endpoint?.enabled) {
          throw new Error(`Endpoint for step ${step.name} is disabled`);
        }

        const mappedBody =
          step.inputMapping && Object.keys(step.inputMapping).length > 0
            ? this.resolveMapping(step.inputMapping, context)
            : context.input;
        let retries = step.onError === 'retry' ? step.retryCount || 0 : 0;
        let success = false;
        let lastError: Error | null = null;

        while (retries >= 0 && !success) {
          try {
            if (this.isCanonicalEndpoint(step.endpoint)) {
              const canonicalOutcome = await this.executeCanonicalStep(job, step, mappedBody, context);
              if (canonicalOutcome.halted) {
                return;
              }
              context.stepResults[step.outputAlias || step.stepOrder.toString()] = canonicalOutcome.responsePayload;
              success = true;
              continue;
            }

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
              const responseData = result.data;
              const isAsyncAccepted = result.status === 202 || (isRecord(responseData) && responseData.done === false);
              if (isAsyncAccepted) {
                const taskId = extractTaskId(responseData, step.endpoint);
                if (taskId) {
                  const externalTaskIds = { ...(job.externalTaskIds || {}) };
                  externalTaskIds[step.stepOrder.toString()] = taskId;

                  await jobsRepo.update({
                    filterByTk: job.id,
                    values: {
                      status: 'polling',
                      externalTaskIds,
                      leaseExpiresAt: new Date(Date.now() + pollLeaseMs(step.endpoint.pollInterval)),
                    },
                  });

                  await this.jobManager.startPolling(job.id, step.endpoint, taskId);
                  return;
                }
              }
              context.stepResults[step.outputAlias || step.stepOrder.toString()] = responseData;
              success = true;
            } else if (step.endpoint.executionMode === 'polling') {
              const taskId = extractTaskId(result.data, step.endpoint);
              if (!taskId) throw new Error('Polling taskId not found in response');

              const externalTaskIds = job.externalTaskIds || {};
              externalTaskIds[step.stepOrder.toString()] = taskId;

              await jobsRepo.update({
                filterByTk: job.id,
                values: {
                  status: 'polling',
                  externalTaskIds,
                  leaseExpiresAt: new Date(Date.now() + pollLeaseMs(step.endpoint.pollInterval)),
                },
              });

              await this.jobManager.startPolling(job.id, step.endpoint, taskId);
              return;
            } else if (step.endpoint.executionMode === 'webhook') {
              const taskId = extractTaskId(result.data, step.endpoint);
              if (!taskId) throw new Error('Webhook taskId not found in response');
              const externalTaskIds = job.externalTaskIds || {};
              externalTaskIds[step.stepOrder.toString()] = taskId;

              await jobsRepo.update({
                filterByTk: job.id,
                values: {
                  status: 'polling',
                  externalTaskIds,
                  leaseExpiresAt: null,
                },
              });
              return;
            }
          } catch (err: unknown) {
            lastError = err instanceof Error ? err : new Error(String(err));
            retries -= 1;
          }
        }

        if (!success) {
          if (step.onError === 'fail') {
            throw lastError || new Error(`Step ${step.name} failed`);
          }
        }
      }

      await this.finishJob(job.id, context);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await jobsRepo.update({
        filterByTk: job.id,
        values: { status: 'failed', error: errorMessage, completedAt: new Date() },
      });
    }
  }

  async resumeFromStep(jobId: number, asyncResult: unknown) {
    const jobsRepo = this.db.getRepository('doc_understanding_jobs');
    const pipelineRepo = this.db.getRepository('doc_understanding_pipelines');

    interface LockedJobRow {
      id: number;
      get: (name: string) => unknown;
    }

    type ResumeClaim = {
      job: LockedJobRow;
      steps: PipelineStepDef[];
      stepResults: Record<string, unknown>;
      currentStep: number;
    };
    const resume: ResumeClaim | undefined = await this.db.sequelize.transaction(
      async (transaction: { LOCK: { UPDATE: string } }): Promise<ResumeClaim | undefined> => {
        const locked = (await jobsRepo.findOne({
          filterByTk: jobId,
          transaction,
          lock: transaction.LOCK.UPDATE,
        })) as LockedJobRow | null;
        const lockedStatus = locked ? String(locked.get('status')) : '';
        if (!locked || (lockedStatus !== 'polling' && lockedStatus !== 'waiting_input')) return undefined;

        const pipeline = await pipelineRepo.findOne({
          filter: { id: locked.get('pipelineId') },
          appends: ['steps', 'steps.endpoint'],
          transaction,
        });
        if (!pipeline) return undefined;

        const rawSteps = (pipeline as unknown as PipelineDef).steps || [];
        const steps = [...rawSteps].sort((a, b) => a.stepOrder - b.stepOrder);
        const currentStep = Number(locked.get('currentStep'));
        const step = steps.find((s) => s.stepOrder === currentStep);
        const stepResults = { ...((locked.get('stepResults') as Record<string, unknown>) || {}) };
        if (step) {
          stepResults[step.outputAlias || step.stepOrder.toString()] = asyncResult;
        }

        await jobsRepo.update({
          filterByTk: jobId,
          values: {
            status: 'running',
            waitState: null,
            ownedBy: this.nodeId,
            leaseExpiresAt: new Date(Date.now() + JOB_RUN_LEASE_MS),
            stepResults,
          },
          transaction,
        });
        return { job: locked, steps, stepResults, currentStep };
      },
    );

    if (!resume) return;

    const context: ExecutionContext = {
      input: (resume.job.get('input') as Record<string, unknown>) || {},
      files: [],
      stepResults: resume.stepResults,
      jobId: resume.job.id,
    };

    this.runSteps(resume.job as unknown as JobState, resume.steps, context, resume.currentStep + 1).catch((err) => {
      this.logger.error(`Failed executing step ${resume.currentStep + 1} for job ${resume.job.id}`, err);
    });
  }

  private async finishJob(jobId: number, context: ExecutionContext) {
    const jobsRepo = this.db.getRepository('doc_understanding_jobs');
    const pipelineRepo = this.db.getRepository('doc_understanding_pipelines');
    const job = await jobsRepo.findOne({ filterByTk: jobId });
    if (!job) return;

    const pipeline = (await pipelineRepo.findOne({ filter: { id: job.pipelineId } })) as unknown as PipelineDef | null;
    if (!pipeline) return;

    let finalResult: unknown = context.stepResults;
    if (pipeline.outputMapping && Object.keys(pipeline.outputMapping).length > 0) {
      const mapped = this.resolveMapping(pipeline.outputMapping, context);
      const compact = Object.fromEntries(Object.entries(mapped).filter(([, v]) => v !== undefined));
      finalResult = Object.keys(compact).length > 0 ? compact : context.stepResults;
    }

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

  private resolveMapping(mapping: Record<string, unknown>, context: ExecutionContext): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mapping)) {
      if (typeof value === 'string') {
        if (value.startsWith('$input.')) {
          result[key] = this.getNestedValue(context.input, value.replace('$input.', ''));
        } else if (value.startsWith('$step[')) {
          const match = value.match(/^\$step\[(.*?)\]\.(?:response\.)?(.*)$/);
          if (match) {
            const stepKey = match[1];
            const path = match[2];
            const stepResult = context.stepResults[stepKey];
            result[key] = path ? this.getNestedValue(stepResult, path) : stepResult;
          } else {
            result[key] = value;
          }
        } else if (value === '$files') {
          // Handled via context.files
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private evaluateCondition(condition: unknown, context: ExecutionContext): boolean {
    if (!condition || !isRecord(condition)) return true;

    const resolveValue = (v: unknown): unknown => {
      if (typeof v === 'string' && v.startsWith('$step[')) {
        const match = v.match(/^\$step\[(.*?)\]\.(?:response\.)?(.*)$/);
        if (match) return this.getNestedValue(context.stepResults[match[1]], match[2]);
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
        return Number(fieldVal) > Number(val);
      case 'gte':
        return Number(fieldVal) >= Number(val);
      case 'lt':
        return Number(fieldVal) < Number(val);
      case 'lte':
        return Number(fieldVal) <= Number(val);
      case 'in':
        return Array.isArray(val) && val.includes(fieldVal);
      case 'contains':
        return typeof fieldVal === 'string' && fieldVal.includes(String(val));
      default:
        return false;
    }
  }

  private getNestedValue(obj: unknown, path: string): unknown {
    if (!obj || !path) return obj;
    return path.split('.').reduce<unknown>((acc, part) => (isRecord(acc) ? acc[part] : undefined), obj);
  }
}
