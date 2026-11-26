/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Model } from '@nocobase/database';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import {
  EXECUTION_STATUS,
  JOB_STATUS,
  type FlowNodeModel,
  type IJob,
  type JobModel,
  type Processor,
} from '@nocobase/plugin-workflow';
import type Application from '@nocobase/server';
import { DEFAULT_TIMEOUT_MS, PORTAINER_INSTANCES_COLLECTION } from '../../shared/constants';
import type { ID } from '../../shared/types';
import { clampTimeoutMs, PortainerApiError, PortainerClient } from '../services/PortainerClient';

export interface ResolvedPortainerInstance {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  gitUsername?: string;
  gitAccessToken?: string;
  gitCredentialId?: number;
  allowInsecureTls: boolean;
  defaultTimeoutMs: number;
  client: PortainerClient;
}

export async function decryptIfNeeded(app: Application, value: unknown): Promise<string> {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  const decryptor = (app as unknown as { aesEncryptor?: { decrypt(v: string): Promise<string> | string } })
    .aesEncryptor;
  if (!decryptor) {
    return raw;
  }
  try {
    return await decryptor.decrypt(raw);
  } catch {
    return raw;
  }
}

export async function resolvePortainerInstance(
  app: Application,
  instanceId?: ID | null,
): Promise<ResolvedPortainerInstance> {
  const repo = app.db.getRepository(PORTAINER_INSTANCES_COLLECTION);
  if (!repo) {
    throw new PortainerApiError('Portainer instances collection is not initialized', { code: 'NO_COLLECTION' });
  }

  let record: Model | null = null;
  const trimmedId = instanceId !== null && typeof instanceId !== 'undefined' ? String(instanceId).trim() : '';

  if (trimmedId) {
    const numericId = Number(trimmedId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      throw new PortainerApiError(`Invalid Portainer instance ID "${trimmedId}"`, { code: 'INVALID_INSTANCE' });
    }
    record = await repo.findOne({ filter: { id: numericId, enabled: true } });
    if (!record) {
      throw new PortainerApiError(`Portainer instance #${numericId} was not found or is disabled`, {
        code: 'INSTANCE_NOT_FOUND',
      });
    }
  } else {
    record = await repo.findOne({ filter: { isDefault: true, enabled: true } });
    if (!record) {
      record = await repo.findOne({ filter: { enabled: true }, sort: ['id'] });
    }
    if (!record) {
      throw new PortainerApiError('No enabled Portainer instance is configured', { code: 'NO_INSTANCE' });
    }
  }

  const baseUrl = String(record.get('baseUrl') ?? '').trim();
  const apiKey = await decryptIfNeeded(app, record.get('apiKey'));
  const gitAccessToken = await decryptIfNeeded(app, record.get('gitAccessToken'));
  const gitUsername = String(record.get('gitUsername') ?? '').trim() || undefined;
  const rawCredId = Number(record.get('gitCredentialId') ?? 0);
  const gitCredentialId = Number.isSafeInteger(rawCredId) && rawCredId > 0 ? rawCredId : undefined;
  const allowInsecureTls = Boolean(record.get('allowInsecureTls'));
  const defaultTimeoutMs = clampTimeoutMs(Number(record.get('defaultTimeoutMs') ?? DEFAULT_TIMEOUT_MS));

  const client = new PortainerClient({
    baseUrl,
    apiKey,
    allowInsecureTls,
    timeoutMs: defaultTimeoutMs,
  });

  return {
    id: Number(record.get('id')),
    name: String(record.get('name') ?? ''),
    baseUrl,
    apiKey,
    gitUsername,
    gitAccessToken: gitAccessToken || undefined,
    gitCredentialId,
    allowInsecureTls,
    defaultTimeoutMs,
    client,
  };
}

export function formatFailureResult(error: unknown, startedAt: Date) {
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  if (error instanceof PortainerApiError) {
    return {
      ok: false,
      errorMessage: error.message,
      errorCode: error.code ?? 'PORTAINER_ERROR',
      httpStatus: error.status ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    errorMessage: message,
    errorCode: 'EXECUTION_ERROR',
    httpStatus: null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
  };
}

function resolveFailureJobStatus(ignoreFail: boolean | undefined, error: unknown): number {
  if (ignoreFail) {
    return JOB_STATUS.RESOLVED;
  }
  if (error instanceof PortainerApiError && error.code === 'ECONNABORTED') {
    return JOB_STATUS.ABORTED;
  }
  return JOB_STATUS.FAILED;
}

/**
 * Shared sync/async workflow execution bridge modeled after NocoBase's native RequestInstruction.
 */
export async function runPortainerWorkflowTask<TResult extends Record<string, unknown>>(params: {
  workflow: WorkflowPlugin;
  node: FlowNodeModel;
  prevJob: JobModel;
  processor: Processor;
  ignoreFail?: boolean;
  signal?: AbortSignal;
  execute: (signal?: AbortSignal) => Promise<TResult>;
}) {
  const { workflow, node, prevJob, processor, ignoreFail, execute } = params;
  const startedAt = new Date();
  const sync = processor.isInstructionSync(node);

  if (sync) {
    try {
      const result = await execute(params.signal);
      return {
        status: JOB_STATUS.RESOLVED,
        result,
      };
    } catch (error) {
      return {
        status: resolveFailureJobStatus(ignoreFail, error),
        result: formatFailureResult(error, startedAt),
      };
    }
  }

  const savedJob = processor.saveJob({
    status: JOB_STATUS.PENDING,
    nodeId: node.id,
    nodeKey: node.key,
    upstreamId: prevJob?.id ?? null,
  });
  const jobId = savedJob.id;

  await processor.exit();
  const abortHandle = processor.createBackgroundAbortHandle();
  const jobDone: IJob = { status: JOB_STATUS.PENDING };

  const settle = async () => {
    try {
      const result = await execute(abortHandle.signal);
      jobDone.status = JOB_STATUS.RESOLVED;
      jobDone.result = result;
    } catch (error) {
      processor.logger.error(
        `[plugin-workflow-portainer] node (#${node.id}) execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      jobDone.status = abortHandle.signal.aborted ? JOB_STATUS.ABORTED : resolveFailureJobStatus(ignoreFail, error);
      jobDone.result = formatFailureResult(error, startedAt);
    } finally {
      abortHandle.dispose();
      const job = (await workflow.app.db.getRepository('jobs').findOne({
        filterByTk: jobId,
      })) as JobModel | null;
      if (job) {
        const execution = await job.getExecution();
        const aborted = await workflow.abortExecutionIfExpired(execution);
        if (!aborted) {
          await execution.reload();
          await job.reload();
        }
        if (!aborted && execution.status === EXECUTION_STATUS.STARTED && job.status === JOB_STATUS.PENDING) {
          job.set(jobDone);
          await workflow.resume(job);
        }
      }
    }
  };

  settle().catch((caught) => {
    processor.logger.error(
      `[plugin-workflow-portainer] async job settle failed (#${node.id}): ${
        caught instanceof Error ? caught.message : String(caught)
      }`,
    );
  });
}
