// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { basename } from 'path';
import mime from 'mime-types';
import {
  EXECUTION_STATUS,
  Instruction,
  JOB_STATUS,
  type FlowNodeModel,
  type IJob,
  type JobModel,
  type Processor,
} from '@nocobase/plugin-workflow';
import { parsePageRangeString, type DocumentSelection } from '../contracts/du-contracts';
import type { DocumentUnderstandingService } from '../services/DocumentUnderstandingService';
import { resolveUploadFilePath } from '../services/PipelineExecutor';

export interface DocumentUnderstandingNodeConfig {
  mode?: 'business_action' | 'pipeline';
  businessId?: 'document-core' | 'lc-checker' | 'example-review';
  action?: string;
  variant?: string;
  pipelineId?: number;
  files?: unknown;
  pages?: string;
  inputJson?: Record<string, unknown> | string;
  ignoreFail?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectFileUrlStrings(rawFiles: unknown): string[] {
  if (!rawFiles) return [];
  if (typeof rawFiles === 'string') {
    return rawFiles
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(rawFiles)) {
    const urls: string[] = [];
    for (const item of rawFiles) {
      urls.push(...collectFileUrlStrings(item));
    }
    return urls;
  }
  if (isRecord(rawFiles)) {
    if (typeof rawFiles.url === 'string') return [rawFiles.url];
    if (typeof rawFiles.filename === 'string') return [`uploads/${rawFiles.filename}`];
  }
  return [];
}

function applyVariantToInput(action: string, variant: string | undefined, target: Record<string, unknown>): void {
  if (!variant || !variant.trim()) return;
  const v = variant.trim();
  if (action === 'ingest' || action === 'compare') {
    if (target.mode === undefined) target.mode = v;
  } else if (action === 'extract') {
    if (target.type === undefined) target.type = v;
  } else if (action === 'analyze' || action === 'generate') {
    if (target.task === undefined) target.task = v;
  } else if (action === 'transform') {
    if (target.variant === undefined) target.variant = v;
  }
}

export class DocumentUnderstandingWorkflowInstruction extends Instruction {
  private getService(): DocumentUnderstandingService {
    const appWithService = this.workflow.app as typeof this.workflow.app & {
      documentUnderstandingService?: DocumentUnderstandingService;
    };
    const pluginInstance = (this.workflow.app.pm?.get?.('plugin-document-understanding') ||
      this.workflow.app.pm?.get?.('document-understanding')) as { service?: DocumentUnderstandingService } | undefined;

    const service = pluginInstance?.service || appWithService.documentUnderstandingService;
    if (!service) {
      throw new Error('Document Understanding service is not available');
    }
    return service;
  }

  private async executeConfig(
    config: DocumentUnderstandingNodeConfig,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const service = this.getService();
    await service.ensureInitialized();

    let parsedInput: Record<string, unknown> = {};
    if (typeof config.inputJson === 'string' && config.inputJson.trim()) {
      const parsed: unknown = JSON.parse(config.inputJson);
      if (isRecord(parsed)) parsedInput = { ...parsed };
    } else if (isRecord(config.inputJson)) {
      parsedInput = { ...config.inputJson };
    }

    const fileUrls = collectFileUrlStrings(config.files);

    if (config.mode === 'pipeline') {
      const pipelineId = Number(config.pipelineId);
      if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0) {
        throw new Error('Workflow node in pipeline mode requires a valid pipelineId');
      }
      if (config.pages && !parsedInput.pages) {
        parsedInput.pages = config.pages;
      }
      const fileRefs = fileUrls.map((url) => ({
        url,
        fieldName: 'file',
        buffer: undefined as unknown as Buffer,
        filename: '',
        mimeType: '',
      }));

      const { jobId } = await service.executePipeline(pipelineId, parsedInput, fileRefs);
      const serviceConf = await service.getConfig();
      const deadline = Date.now() + (serviceConf.pollTimeout || 300_000);

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await service.cancelJob(jobId).catch(() => undefined);
          throw new Error('Workflow execution aborted');
        }
        const job = await service.getJobStatus(jobId);
        if (job.status === 'completed') {
          const finalObj = isRecord(job.finalResult) ? job.finalResult : { data: job.finalResult };
          return {
            jobId,
            operationId: job.operationId ?? null,
            state: 'SUCCEEDED',
            ...finalObj,
            usage: job.usage ?? finalObj.usage ?? null,
          };
        }
        if (['failed', 'cancelled', 'timeout'].includes(job.status)) {
          throw new Error(job.error || `Document pipeline job #${jobId} ended with status ${job.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`Document pipeline job #${jobId} timed out`);
    }

    // Default: Canonical `du-rework` Business Action execution
    const businessId = config.businessId || 'document-core';
    const action = config.action || 'extract';
    applyVariantToInput(action, config.variant, parsedInput);

    const artifactIds: string[] = [];
    for (const rawUrl of fileUrls) {
      const localPath = resolveUploadFilePath(rawUrl);
      if (!localPath) continue;
      const bytes = readFileSync(localPath);
      const fileName = basename(localPath);
      const mimeType = String(mime.lookup(localPath) || 'application/octet-stream');
      const created = await service.orchestrator.artifactStorage.createReadyArtifactFromBuffer({
        tenantId: 'default',
        fileName,
        mimeType,
        buffer: bytes,
      });
      artifactIds.push(created.artifactId);
    }

    let documentSelection: DocumentSelection | undefined;
    if (config.pages && config.pages.trim() && artifactIds.length > 0) {
      const ranges = parsePageRangeString(config.pages, 500);
      if (ranges.length > 0) {
        documentSelection = {
          kind: 'requestSelection',
          schemaVersion: 1,
          mode: 'combined',
          artifactIds,
          pageSelections: artifactIds.map((artifactId) => ({
            artifactId,
            selection: { kind: 'ranges', ranges },
          })),
        };
      }
    }

    const submitted = await service.orchestrator.submitOperation({
      principal: {
        kind: 'nocobase_user',
        tenantId: 'default',
        allowedBusinesses: ['*'],
        allowedActions: ['*'],
      },
      businessId,
      action,
      submission: {
        input: parsedInput,
        artifacts: artifactIds.map((artifactId) => ({ artifactId, role: 'input' })),
        documentSelection,
      },
    });

    const serviceConf = await service.getConfig();
    const deadline = Date.now() + (serviceConf.pollTimeout || 300_000);

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await service.orchestrator.cancelOperation('default', submitted.operationId).catch(() => undefined);
        throw new Error('Workflow execution aborted');
      }
      const view = await service.orchestrator.waitForOperation('default', submitted.operationId, 5);
      if (view.state === 'SUCCEEDED') {
        const opRecord = await service.orchestrator.getOperationRecordOrThrow('default', submitted.operationId);
        const payload = opRecord.outputPayload || {};
        return {
          operationId: submitted.operationId,
          state: 'SUCCEEDED',
          data: payload.data ?? payload,
          markdown: payload.markdown ?? null,
          text: payload.text ?? null,
          report: payload.report ?? null,
          verdict: payload.verdict ?? null,
          discrepancies: payload.discrepancies ?? null,
          usage: opRecord.usage ?? null,
        };
      }
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(view.state)) {
        throw new Error(view.error?.detail || view.error?.title || `Operation ended in state ${view.state}`);
      }
      // If WAITING_INPUT, keep waiting cleanly until human reviewer resumes or deadline expires
      if (view.state === 'WAITING_INPUT') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new Error(`Document Understanding operation ${submitted.operationId} timed out`);
  }

  async run(node: FlowNodeModel, prevJob: JobModel, processor: Processor, options?: { signal?: AbortSignal }) {
    const config = processor.getParsedValue(node.config, node.id) as DocumentUnderstandingNodeConfig;
    const sync = processor.isInstructionSync(node);

    if (sync) {
      try {
        const result = await this.executeConfig(config, options?.signal);
        return { status: JOB_STATUS.RESOLVED, result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: config.ignoreFail ? JOB_STATUS.RESOLVED : JOB_STATUS.ERROR,
          result: { error: message },
        };
      }
    }

    const { id } = processor.saveJob({
      status: JOB_STATUS.PENDING,
      nodeId: node.id,
      nodeKey: node.key,
      upstreamId: prevJob?.id ?? null,
    });

    await processor.exit();
    const abortHandle = processor.createBackgroundAbortHandle();
    const jobDone: IJob = { status: JOB_STATUS.PENDING };

    const settle = async () => {
      try {
        const result = await this.executeConfig(config, abortHandle.signal);
        jobDone.status = JOB_STATUS.RESOLVED;
        jobDone.result = result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        jobDone.status = abortHandle.signal.aborted
          ? JOB_STATUS.ABORTED
          : config.ignoreFail
            ? JOB_STATUS.RESOLVED
            : JOB_STATUS.ERROR;
        jobDone.result = { error: message };
      } finally {
        abortHandle.dispose();
        const job = await this.workflow.app.db.getRepository('jobs').findOne({ filterByTk: id });
        if (job) {
          const execution = await job.getExecution();
          const aborted = await this.workflow.abortExecutionIfExpired(execution);
          if (!aborted) {
            await execution.reload();
            await job.reload();
          }
          if (!aborted && execution.status === EXECUTION_STATUS.STARTED && job.status === JOB_STATUS.PENDING) {
            job.set(jobDone);
            await this.workflow.resume(job);
          }
        }
      }
    };

    settle().catch((err) => {
      processor.logger.error(`Document Understanding workflow node (#${node.id}) settling failed`, err);
    });
  }

  async resume(node: FlowNodeModel, job: JobModel) {
    const config = (node.config || {}) as DocumentUnderstandingNodeConfig;
    if (config.ignoreFail) {
      job.set('status', JOB_STATUS.RESOLVED);
    }
    return job;
  }
}
