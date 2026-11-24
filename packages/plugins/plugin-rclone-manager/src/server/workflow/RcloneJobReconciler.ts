// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import type { Model } from '@nocobase/database';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import { EXECUTION_STATUS, JOB_STATUS, type JobModel } from '@nocobase/plugin-workflow';
import type { Application } from '@nocobase/server';
import { COLLECTIONS, RCLONE_TRANSFER_INSTRUCTION_TYPE } from '../../shared/constants';
import type { RcloneTransferJobState, RcloneWorkflowJobMeta } from '../../shared/types';
import type { RcloneConnectionManager } from './../services/connection-manager';
import { isLockContentionError, runWithAppLock, type LockableAppLike } from '../utils/distributed-lock';
import { isJobAfterAnchor, traceWorkflowContinuation, type FlowNodeLike } from './continuation-tracker';

const POLL_INTERVAL_MS = 2_500;
const IDLE_POLL_INTERVAL_MS = 30_000;
const STARTING_PROBE_GRACE_MS = 5_000;
const STARTING_STALE_MS = 120_000;
const MISSING_JOB_FLUSH_GRACE_MS = 1_500;
const MEMORY_QUEUE_REDISPATCH_MS = 30_000;
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'stopped', 'unverified'];

function isVolatileEventQueue(app: Application): boolean {
  const eq = (app as unknown as { eventQueue?: { adapter?: unknown } }).eventQueue;
  const adapter = eq?.adapter;
  if (!adapter || typeof adapter !== 'object') {
    return false;
  }
  const ctorName = (adapter as { constructor?: { name?: string } }).constructor?.name ?? '';
  if (ctorName === 'MemoryEventQueueAdapter') {
    return true;
  }
  const queuesProp = (adapter as { queues?: unknown }).queues;
  return queuesProp instanceof Map || Array.isArray(queuesProp);
}

function extractWorkflowJobMeta(task: Model): RcloneWorkflowJobMeta | null {
  let raw: unknown = task.get('workflowJobMeta');
  if (typeof raw === 'string' && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as Partial<RcloneWorkflowJobMeta>;
  if (candidate.executionId == null || candidate.nodeId == null || !candidate.nodeKey) {
    return null;
  }
  return candidate as RcloneWorkflowJobMeta;
}

function resolveTaskWorkflowJobId(task: Model): string {
  const direct = String(task.get('workflowJobId') ?? '').trim();
  if (direct) {
    return direct;
  }
  const meta = extractWorkflowJobMeta(task);
  return String(meta?.workflowJobId ?? '').trim();
}

function allocateWorkflowJobIdIfMissing(task: Model, workflowPlugin?: WorkflowPlugin): string {
  const existing = resolveTaskWorkflowJobId(task);
  if (existing) {
    return existing;
  }
  const meta = extractWorkflowJobMeta(task);
  if (!meta) {
    return '';
  }
  const snowflake = (
    workflowPlugin as unknown as { snowflake?: { getUniqueID?: () => { toString: () => string } } } | undefined
  )?.snowflake;
  return snowflake?.getUniqueID?.()?.toString() || `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function computeTaskDurationSec(task: Model): number {
  const rawStartedAt = task.get('startedAt');
  const rawCompletedAt = task.get('completedAt');
  const startedMs = rawStartedAt ? new Date(String(rawStartedAt)).getTime() : Number.NaN;
  const completedMs = rawCompletedAt ? new Date(String(rawCompletedAt)).getTime() : Number.NaN;
  return Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
    ? (completedMs - startedMs) / 1000
    : 0;
}

function extractNestedJobError(output: unknown, directError?: string): string {
  if (directError && directError.trim()) {
    return directError.trim();
  }
  if (!output || typeof output !== 'object' || !('results' in output)) {
    return '';
  }
  const results = (output as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return '';
  }
  const messages: string[] = [];
  for (const item of results) {
    if (item && typeof item === 'object' && 'error' in item) {
      const msg = String((item as { error?: unknown }).error ?? '').trim();
      if (msg) {
        messages.push(msg);
      }
    }
  }
  return messages.join('\n');
}

function computePercent(bytes: number, totalBytes: number, fallbackPercent?: number): number {
  if (totalBytes > 0) {
    return Math.max(0, Math.min(100, Math.round((bytes / totalBytes) * 100)));
  }
  if (typeof fallbackPercent === 'number' && Number.isFinite(fallbackPercent)) {
    return Math.max(0, Math.min(100, Math.round(fallbackPercent)));
  }
  return 0;
}

export class RcloneJobReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private readonly memoryDispatchRecords = new Map<string, { executionId: string; timestamp: number }>();
  private executionAfterUpdateHandler:
    | ((execution: Model, options?: { transaction?: unknown }) => Promise<void>)
    | null = null;

  constructor(
    private readonly app: Application,
    private readonly connectionManager: RcloneConnectionManager,
  ) {}

  start(): void {
    this.stopped = false;
    if (!this.executionAfterUpdateHandler && typeof this.app.db?.on === 'function') {
      const handler = async (execution: Model, options?: { transaction?: unknown }) => {
        const status = Number(execution?.get?.('status') ?? (execution as unknown as { status?: number })?.status);
        const execId = execution?.get?.('id') ?? (execution as unknown as { id?: number | string })?.id;
        if (execId == null || status === EXECUTION_STATUS.STARTED) {
          return;
        }
        const execKey = String(execId);
        let removedFromMemory = false;
        for (const [jobKey, rec] of this.memoryDispatchRecords.entries()) {
          if (rec.executionId === execKey) {
            this.memoryDispatchRecords.delete(jobKey);
            removedFromMemory = true;
          }
        }
        if (!removedFromMemory) {
          return;
        }
        const taskCollection = this.app.db.getCollection?.(COLLECTIONS.tasks);
        const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
        if (typeof taskModelUpdate === 'function') {
          await taskModelUpdate
            .call(
              taskCollection.model,
              { resumePending: false },
              {
                where: { executionId: execId, resumePending: true },
                ...(options?.transaction ? { transaction: options.transaction as never } : {}),
              },
            )
            .catch(() => {});
        }
      };
      this.executionAfterUpdateHandler = handler;
      this.app.db.on('executions.afterUpdate', handler);
    }
    this.kick(250);
  }

  stop(): void {
    this.stopped = true;
    if (this.executionAfterUpdateHandler && typeof this.app.db?.off === 'function') {
      this.app.db.off('executions.afterUpdate', this.executionAfterUpdateHandler);
      this.executionAfterUpdateHandler = null;
    }
    this.memoryDispatchRecords.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  clearDispatchThrottle(wfJobId: string): void {
    if (wfJobId) {
      this.memoryDispatchRecords.delete(wfJobId);
    }
  }

  kick(delayMs = 150): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) {
        return;
      }
      this.reconcileOnce().catch((error) => {
        this.app.logger?.warn?.(`[plugin-rclone-manager] Reconciler iteration warning: ${String(error)}`);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async reconcileOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    if (!this.app.db.getCollection(COLLECTIONS.tasks)) {
      return;
    }

    this.running = true;
    let hasActiveWork = false;
    try {
      const taskRepo = this.app.db.getRepository(COLLECTIONS.tasks);
      const rawRunning = (await taskRepo.find({
        filter: { status: 'running' },
      })) as Model[];
      const runningTasks = rawRunning.filter((row) => String(row.get('status') ?? 'running') === 'running');

      const rawStarting = (await taskRepo.find({
        filter: { status: 'starting' },
      })) as Model[];
      const startingTasks = rawStarting.filter((row) => String(row.get('status') ?? '') === 'starting');

      const rawResumePending = (await taskRepo.find({
        filter: { resumePending: true },
      })) as Model[];
      const resumePendingTasks = rawResumePending.filter((row) => {
        const status = String(row.get('status') ?? '');
        return Boolean(row.get('resumePending')) && TERMINAL_TASK_STATUSES.includes(status);
      });

      // Also discover pending workflow jobs and settled orphan jobs of STARTED executions (for both volatile memory
      // queues and durable queues like RedisEventQueueAdapter whose prior publish attempt failed before confirmation).
      const workflowPlugin = this.app.pm.get('workflow') as WorkflowPlugin | undefined;
      const pendingJobsById = new Map<string, JobModel>();
      const settledStartedJobs: JobModel[] = [];
      if (workflowPlugin && this.app.db.getCollection('jobs')) {
        const jobModel = this.app.db.getCollection('jobs').model;
        const pendingJobs = (await jobModel.findAll({
          where: { status: JOB_STATUS.PENDING },
          include: [
            {
              association: 'execution',
              where: { status: EXECUTION_STATUS.STARTED },
              required: true,
            },
            {
              association: 'node',
              attributes: ['id', 'key', 'type', 'config', 'upstreamId', 'downstreamId', 'branchIndex'],
              where: { type: RCLONE_TRANSFER_INSTRUCTION_TYPE },
              required: true,
            },
          ],
        })) as JobModel[];
        for (const job of pendingJobs) {
          if (Number(job.status) === JOB_STATUS.PENDING) {
            pendingJobsById.set(String(job.id), job);
          }
        }

        const settledCandidates = (await jobModel
          .findAll({
            where: { status: [JOB_STATUS.RESOLVED, JOB_STATUS.FAILED, JOB_STATUS.CANCELED] },
            include: [
              {
                association: 'execution',
                where: { status: EXECUTION_STATUS.STARTED },
                required: true,
              },
              {
                association: 'node',
                attributes: ['id', 'key', 'type', 'config', 'upstreamId', 'downstreamId', 'branchIndex'],
                where: { type: RCLONE_TRANSFER_INSTRUCTION_TYPE },
                required: true,
              },
            ],
          })
          .catch(() => [])) as JobModel[];
        for (const job of settledCandidates) {
          if (Number(job.status) !== JOB_STATUS.PENDING) {
            settledStartedJobs.push(job);
          }
        }
      }

      if (this.memoryDispatchRecords.size > 0) {
        const now = Date.now();
        for (const [jobKey, rec] of this.memoryDispatchRecords.entries()) {
          if (now - rec.timestamp >= MEMORY_QUEUE_REDISPATCH_MS) {
            this.memoryDispatchRecords.delete(jobKey);
          }
        }
      }

      if (
        runningTasks.length === 0 &&
        startingTasks.length === 0 &&
        resumePendingTasks.length === 0 &&
        pendingJobsById.size === 0 &&
        settledStartedJobs.length === 0
      ) {
        this.memoryDispatchRecords.clear();
        return;
      }

      // Group running tasks by connectionId so we reuse each connection's RC client
      const byConnection = new Map<number, Model[]>();
      const handledJobIds = new Set<string>();
      const finalizedTaskIds = new Set<number>();

      for (const task of startingTasks) {
        const taskId = Number(task.get('id'));
        const wfJobId = String(task.get('workflowJobId') ?? '').trim();
        const runGroup = String(task.get('rcloneGroup') ?? '').trim();
        const rawStartedAt = task.get('startedAt');
        const startedMs = rawStartedAt ? new Date(String(rawStartedAt)).getTime() : Number.NaN;
        const elapsedMs = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;

        if (!runGroup) {
          if (Number.isFinite(startedMs) && elapsedMs > STARTING_STALE_MS && !(Number(task.get('rcloneJobId')) > 0)) {
            const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
              status: 'unverified',
              success: false,
              errorText:
                'Transfer task was interrupted while starting without a run group identifier and cannot be verified',
            });
            finalizedTaskIds.add(taskId);
            if (wfJobId) handledJobIds.add(wfJobId);
            if (!resumed) hasActiveWork = true;
          } else {
            hasActiveWork = true;
            if (wfJobId) handledJobIds.add(wfJobId);
          }
          continue;
        }

        if (elapsedMs < STARTING_PROBE_GRACE_MS) {
          hasActiveWork = true;
          if (wfJobId) handledJobIds.add(wfJobId);
          continue;
        }

        const connId = Number(task.get('connectionId'));
        let startClient;
        try {
          const resolved = await this.connectionManager.getClient(connId, false);
          startClient = resolved.client;
        } catch (connError) {
          const status = (connError as { status?: number } | null)?.status;
          const msg = connError instanceof Error ? connError.message : String(connError);
          if (status === 400 || status === 404) {
            const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
              status: 'failed',
              success: false,
              errorText: msg,
            });
            finalizedTaskIds.add(taskId);
            if (wfJobId) handledJobIds.add(wfJobId);
            if (!resumed) hasActiveWork = true;
          } else {
            hasActiveWork = true;
            if (wfJobId) handledJobIds.add(wfJobId);
          }
          continue;
        }

        let matched: Awaited<ReturnType<typeof startClient.findJobByGroup>> = null;
        let activeInGroupStats = false;
        try {
          matched = await startClient.findJobByGroup(runGroup);
          if (!matched) {
            const groups = await startClient.getStatsGroups();
            if (groups?.includes(runGroup)) {
              const stats = await startClient.getStats(runGroup).catch(() => null);
              activeInGroupStats = (stats?.transferring?.length ?? 0) > 0 || (stats?.checking?.length ?? 0) > 0;
            }
          }
        } catch (probeError) {
          // Daemon unreachable — keep task in starting state rather than falsely marking failed while daemon may still be transferring.
          hasActiveWork = true;
          if (wfJobId) handledJobIds.add(wfJobId);
          this.app.logger?.warn?.(
            `[plugin-rclone-manager] Transient probe error while recovering starting task #${taskId}: ${String(
              probeError,
            )}`,
          );
          continue;
        }

        if (matched) {
          if (!matched.job.finished) {
            const recoverPatch = {
              status: 'running',
              rcloneJobId: matched.job.id,
              rcloneExecuteId: matched.executeId ?? null,
            };
            const taskCollection = this.app.db.getCollection?.(COLLECTIONS.tasks);
            const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
            if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
              const [recovered] = await taskModelUpdate.call(taskCollection.model, recoverPatch, {
                where: { id: taskId, status: 'starting', rcloneGroup: runGroup },
              });
              if (
                recovered > 0 &&
                typeof (task as { set?: (vals: Record<string, unknown>) => void }).set === 'function'
              ) {
                task.set(recoverPatch);
              }
            } else {
              await task.update(recoverPatch);
            }
            hasActiveWork = true;
            if (wfJobId) handledJobIds.add(wfJobId);
            continue;
          }

          const groupStats =
            typeof startClient.getStats === 'function' ? await startClient.getStats(runGroup).catch(() => null) : null;
          let finalBytes = Number(groupStats?.bytes ?? task.get('bytes') ?? 0);
          let finalTotalBytes = Number(groupStats?.totalBytes ?? task.get('totalBytes') ?? 0);
          if (finalBytes === 0 && finalTotalBytes === 0 && typeof startClient.getTransferred === 'function') {
            const transferredRes = await startClient.getTransferred(runGroup).catch(() => null);
            const items = transferredRes?.transferred ?? [];
            if (items.length > 0) {
              const summed = items.reduce((acc, item) => acc + Number(item.bytes ?? item.size ?? 0), 0);
              finalBytes = summed;
              finalTotalBytes = summed;
            }
          }
          const errorText = matched.job.success ? '' : extractNestedJobError(matched.job.output, matched.job.error);
          const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
            status: matched.job.success ? 'completed' : 'failed',
            success: matched.job.success,
            rcloneJobId: matched.job.id,
            rcloneExecuteId: matched.executeId ?? null,
            bytes: finalBytes,
            totalBytes: finalTotalBytes,
            duration: matched.job.duration ?? 0,
            errorText: errorText || (matched.job.success ? '' : 'Rclone transfer job failed'),
          });
          finalizedTaskIds.add(taskId);
          if (wfJobId) handledJobIds.add(wfJobId);
          if (!resumed) hasActiveWork = true;
          continue;
        }

        if (!activeInGroupStats && Number.isFinite(startedMs) && elapsedMs > STARTING_STALE_MS) {
          // Rclone purges finished job records after --rc-job-expire-duration (60s by default), so absence of an
          // expired starting group does not prove the transfer failed; mark 'unverified' to prevent unsafe re-runs.
          const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
            status: 'unverified',
            success: false,
            errorText:
              'Transfer task outcome could not be verified (daemon job history expired or interrupted while starting)',
          });
          finalizedTaskIds.add(taskId);
          if (wfJobId) handledJobIds.add(wfJobId);
          if (!resumed) hasActiveWork = true;
        } else {
          hasActiveWork = true;
          if (wfJobId) handledJobIds.add(wfJobId);
        }
      }

      for (const task of runningTasks) {
        const connId = Number(task.get('connectionId'));
        if (!Number.isFinite(connId) || connId <= 0) continue;
        const list = byConnection.get(connId) ?? [];
        list.push(task);
        byConnection.set(connId, list);
      }

      const reconcileConnection = async (connectionId: number, tasks: Model[]): Promise<void> => {
        let client;
        try {
          const resolved = await this.connectionManager.getClient(connectionId, false);
          client = resolved.client;
        } catch (error) {
          const status = (error as { status?: number } | null)?.status;
          const msg = error instanceof Error ? error.message : String(error);
          if (status === 404 || status === 400) {
            for (const task of tasks) {
              const wfJobId = String(task.get('workflowJobId') ?? '').trim();
              const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
                status: 'failed',
                success: false,
                errorText: msg,
              });
              finalizedTaskIds.add(Number(task.get('id')));
              if (wfJobId) {
                handledJobIds.add(wfJobId);
              }
              if (!resumed) {
                hasActiveWork = true;
              }
            }
          } else {
            hasActiveWork = true;
            for (const task of tasks) {
              const wfJobId = String(task.get('workflowJobId') ?? '').trim();
              if (wfJobId) handledJobIds.add(wfJobId);
            }
            this.app.logger?.warn?.(
              `[plugin-rclone-manager] Transient connection load error for connection #${connectionId}: ${msg}`,
            );
          }
          return;
        }

        for (const task of tasks) {
          const rcloneJobId = Number(task.get('rcloneJobId'));
          const expectedExecuteId = String(task.get('rcloneExecuteId') ?? '').trim() || undefined;
          const expectedGroup = String(task.get('rcloneGroup') ?? '').trim() || undefined;
          const wfJobId = String(task.get('workflowJobId') ?? '').trim();
          if (!Number.isFinite(rcloneJobId) || rcloneJobId <= 0) {
            continue;
          }

          if (!expectedExecuteId && !expectedGroup) {
            const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
              status: 'unverified',
              success: false,
              errorText:
                'Pre-upgrade transfer task lacks job identity (executeId and group) and cannot be verified safely',
            });
            finalizedTaskIds.add(Number(task.get('id')));
            if (wfJobId) handledJobIds.add(wfJobId);
            if (!resumed) hasActiveWork = true;
            continue;
          }

          let jobStatus;
          try {
            jobStatus = await client.getJobStatus(rcloneJobId, {
              executeId: expectedExecuteId,
              group: expectedGroup,
            });
          } catch (statusError) {
            // Keep task running on transient network/timeout/5xx errors; retry on next poll tick.
            hasActiveWork = true;
            if (wfJobId) handledJobIds.add(wfJobId);
            this.app.logger?.warn?.(
              `[plugin-rclone-manager] Transient /job/status error for task #${String(
                task.get('id'),
              )} (job ${rcloneJobId}): ${String(statusError)}`,
            );
            continue;
          }

          if (!jobStatus) {
            // Job expired from rclone history (--rc-job-expire-duration) or daemon restarted (executeId mismatch);
            // mark 'unverified' rather than 'failed' so operators do not re-run a transfer that already succeeded.
            const prevBytes = Number(task.get('bytes') ?? 0);
            const prevTotalBytes = Number(task.get('totalBytes') ?? 0);
            const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
              status: 'unverified',
              success: false,
              bytes: prevBytes,
              totalBytes: prevTotalBytes,
              errorText: 'Rclone job outcome could not be verified (job history expired on daemon or daemon restarted)',
            });
            finalizedTaskIds.add(Number(task.get('id')));
            if (wfJobId) {
              handledJobIds.add(wfJobId);
            }
            if (!resumed) {
              hasActiveWork = true;
            }
            continue;
          }

          const groupName = expectedGroup || jobStatus.group || `job/${rcloneJobId}`;
          const groupStats = await client.getStats(groupName).catch(() => null);
          const bytes = Number(groupStats?.bytes ?? task.get('bytes') ?? 0);
          const totalBytes = Number(groupStats?.totalBytes ?? task.get('totalBytes') ?? 0);
          const speed = Number(groupStats?.speed ?? 0);
          const eta = typeof groupStats?.eta === 'number' && Number.isFinite(groupStats.eta) ? groupStats.eta : null;
          const firstItemPct = groupStats?.transferring?.[0]?.percentage;

          if (!jobStatus.finished) {
            hasActiveWork = true;
            if (wfJobId) handledJobIds.add(wfJobId);
            await task.update({
              bytes,
              totalBytes,
              speed,
              eta,
              progress: computePercent(bytes, totalBytes, firstItemPct),
            });
            continue;
          }

          let finalBytes = bytes;
          let finalTotalBytes = totalBytes;
          if (finalBytes === 0 && finalTotalBytes === 0) {
            const transferredRes = await client.getTransferred(groupName).catch(() => null);
            const items = transferredRes?.transferred ?? [];
            if (items.length > 0) {
              const summed = items.reduce((acc, item) => acc + Number(item.bytes ?? item.size ?? 0), 0);
              finalBytes = summed;
              finalTotalBytes = summed;
            }
          }

          const errorText = jobStatus.success ? '' : extractNestedJobError(jobStatus.output, jobStatus.error);
          const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
            status: jobStatus.success ? 'completed' : 'failed',
            success: jobStatus.success,
            bytes: finalBytes,
            totalBytes: finalTotalBytes,
            duration: jobStatus.duration ?? 0,
            errorText: errorText || (jobStatus.success ? '' : 'Rclone transfer job failed'),
          });
          finalizedTaskIds.add(Number(task.get('id')));
          if (wfJobId) {
            handledJobIds.add(wfJobId);
          }
          if (!resumed) {
            hasActiveWork = true;
          }
        }
      };

      const connResults = await Promise.allSettled(
        [...byConnection.entries()].map(([connId, tasks]) => reconcileConnection(connId, tasks)),
      );
      for (const result of connResults) {
        if (result.status === 'rejected') {
          hasActiveWork = true;
          this.app.logger?.warn?.(`[plugin-rclone-manager] Connection reconciliation error: ${String(result.reason)}`);
        }
      }

      // Retry durable workflow resume requests whose previous queue publish failed or whose JobModel was not flushed yet.
      for (const task of resumePendingTasks) {
        const taskId = Number(task.get('id'));
        if (finalizedTaskIds.has(taskId)) {
          continue;
        }
        const wfJobId = allocateWorkflowJobIdIfMissing(task, workflowPlugin);
        if (!wfJobId) {
          await this.clearTaskResumePending(task);
          continue;
        }
        if (!workflowPlugin) {
          hasActiveWork = true;
          continue;
        }
        const taskStatus = String(task.get('status') ?? '');
        const resumed = await this.dispatchWorkflowResumeForTask(task, wfJobId, pendingJobsById, workflowPlugin, {
          success: taskStatus === 'completed',
          bytes: Number(task.get('bytes') ?? 0),
          totalBytes: Number(task.get('totalBytes') ?? 0),
          duration: computeTaskDurationSec(task),
          errorText: String(task.get('errorText') ?? ''),
        });
        handledJobIds.add(wfJobId);
        if (!resumed) {
          hasActiveWork = true;
        }
      }

      // Reconcile any orphaned PENDING workflow jobs whose task already reached a terminal state or was interrupted before status='running'.
      if (workflowPlugin && pendingJobsById.size > 0 && typeof taskRepo.findOne === 'function') {
        for (const [wfJobId, wfJob] of pendingJobsById.entries()) {
          if (handledJobIds.has(wfJobId)) {
            continue;
          }
          const jobState = (
            wfJob.result && typeof wfJob.result === 'object' ? wfJob.result : {}
          ) as Partial<RcloneTransferJobState>;
          const taskId = Number(jobState.taskId);
          if (!Number.isFinite(taskId) || taskId <= 0) {
            continue;
          }
          const task = (await taskRepo.findOne({ filterByTk: taskId })) as Model | null;
          if (!task) {
            const resumed = await this.resumeOrphanWorkflowJob(wfJob, taskId, workflowPlugin, {
              success: false,
              bytes: 0,
              totalBytes: 0,
              duration: 0,
              errorText: `Transfer task #${taskId} was not found`,
            });
            if (!resumed) {
              hasActiveWork = true;
            }
            continue;
          }
          const taskStatus = String(task.get('status') ?? '');
          if (TERMINAL_TASK_STATUSES.includes(taskStatus)) {
            // Do NOT mutate resumePending outside the per-job lock; dispatchWorkflowResumeForTask reloads both
            // task and job inside the lock before deciding whether to set resumePending and publish resume.
            const resumed = await this.dispatchWorkflowResumeForTask(
              task,
              wfJobId,
              pendingJobsById,
              workflowPlugin,
              {
                success: taskStatus === 'completed',
                bytes: Number(task.get('bytes') ?? 0),
                totalBytes: Number(task.get('totalBytes') ?? 0),
                duration: computeTaskDurationSec(task),
                errorText: String(task.get('errorText') ?? ''),
              },
              { fromOrphanPendingScan: true },
            );
            if (!resumed) {
              hasActiveWork = true;
            }
          } else if (
            (taskStatus === 'queued' ||
              taskStatus === 'starting' ||
              (taskStatus === 'running' && !(Number(task.get('rcloneJobId')) > 0))) &&
            Number.isFinite(Number(jobState.rcloneJobId)) &&
            Number(jobState.rcloneJobId) > 0
          ) {
            await task.update({
              status: 'running',
              rcloneJobId: Number(jobState.rcloneJobId),
              rcloneExecuteId: jobState.rcloneExecuteId ?? task.get('rcloneExecuteId') ?? null,
              rcloneGroup: jobState.rcloneGroup ?? task.get('rcloneGroup') ?? null,
              workflowJobId: wfJobId,
              startedAt: task.get('startedAt') ?? new Date(),
            });
            hasActiveWork = true;
          } else if (taskStatus === 'running' && !(Number(task.get('rcloneJobId')) > 0)) {
            // Corrupted running task with no rcloneJobId on either task or workflow job; fail cleanly instead of spinning forever.
            const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
              status: 'failed',
              success: false,
              errorText: 'Rclone job ID is missing for running task',
            });
            if (!resumed) {
              hasActiveWork = true;
            }
          } else {
            hasActiveWork = true;
          }
        }
      }

      // Recover settled orphan workflow jobs whose linked task row was deleted before the event queue (either volatile
      // MemoryEventQueueAdapter or a durable queue like RedisEventQueueAdapter after a transient publish failure)
      // confirmed delivery or completed closing execution.status.
      if (workflowPlugin && settledStartedJobs.length > 0 && typeof taskRepo.findOne === 'function') {
        const volatileQueue = isVolatileEventQueue(this.app);
        for (const orphanJob of settledStartedJobs) {
          const wfJobId = String(orphanJob.id);
          if (handledJobIds.has(wfJobId)) {
            continue;
          }
          const orphanMeta = (orphanJob.meta && typeof orphanJob.meta === 'object' ? orphanJob.meta : {}) as Record<
            string,
            unknown
          >;
          if (!volatileQueue && orphanMeta.orphanResumePending === false) {
            continue;
          }
          const jobState = (
            orphanJob.result && typeof orphanJob.result === 'object' ? orphanJob.result : {}
          ) as Partial<RcloneTransferJobState>;
          const taskId = Number(jobState.taskId);
          const task =
            Number.isFinite(taskId) && taskId > 0
              ? ((await taskRepo.findOne({ filterByTk: taskId }).catch(() => null)) as Model | null)
              : null;
          if (task) {
            continue;
          }
          const resumed = await this.resumeOrphanWorkflowJob(
            orphanJob,
            Number.isFinite(taskId) ? taskId : 0,
            workflowPlugin,
            {
              success: Number(orphanJob.status) === JOB_STATUS.RESOLVED,
              bytes: Number(jobState.bytes ?? 0),
              totalBytes: Number(jobState.totalBytes ?? 0),
              duration: Number(jobState.duration ?? 0),
              errorText: String(jobState.error || `Transfer task #${String(taskId)} was not found`),
            },
          );
          if (!resumed) {
            hasActiveWork = true;
          }
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped) {
        this.kick(hasActiveWork ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
      }
    }
  }

  private async markTaskResumePending(task: Model, wfJobId: string, resumeToken: string): Promise<void> {
    if (
      Boolean(task.get('resumePending')) &&
      String(task.get('workflowJobId') ?? '') === wfJobId &&
      String(task.get('resumeToken') ?? '') === resumeToken
    ) {
      return;
    }
    const patch = { workflowJobId: wfJobId, resumePending: true, resumeToken };
    const taskId = Number(task.get('id'));
    const taskCollection = this.app.db.getCollection?.(COLLECTIONS.tasks);
    const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
    if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
      await taskModelUpdate.call(taskCollection.model, patch, {
        where: { id: taskId, status: TERMINAL_TASK_STATUSES },
      });
      if (typeof (task as { set?: (vals: Record<string, unknown>) => void }).set === 'function') {
        task.set(patch);
      }
    } else if (typeof task.update === 'function') {
      await task.update(patch);
    }
  }

  private async clearTaskResumePending(task: Model, expectedResumeToken?: string): Promise<boolean> {
    const patch = { resumePending: false };
    const taskId = Number(task.get('id'));
    if (expectedResumeToken && Number.isFinite(taskId) && taskId > 0) {
      const taskRepo = this.app.db.getRepository?.(COLLECTIONS.tasks) as
        | { findOne?: (opts: { filterByTk: number }) => Promise<Model | null> }
        | undefined;
      if (typeof taskRepo?.findOne === 'function') {
        const latest = await taskRepo.findOne({ filterByTk: taskId }).catch(() => null);
        const liveToken = String((latest ?? task).get('resumeToken') ?? '').trim();
        if (liveToken && liveToken !== expectedResumeToken) {
          return false;
        }
      }
    }
    const taskCollection = this.app.db.getCollection?.(COLLECTIONS.tasks);
    const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
    if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
      const [updatedCount] = await taskModelUpdate.call(taskCollection.model, patch, {
        where: {
          id: taskId,
          status: TERMINAL_TASK_STATUSES,
          ...(expectedResumeToken ? { resumeToken: expectedResumeToken } : {}),
        },
      });
      if (updatedCount > 0) {
        if (typeof (task as { set?: (vals: Record<string, unknown>) => void }).set === 'function') {
          task.set(patch);
        }
        return true;
      }
      return false;
    }
    if (expectedResumeToken) {
      const liveToken = String(task.get('resumeToken') ?? '').trim();
      if (liveToken && liveToken !== expectedResumeToken) {
        return false;
      }
    }
    if (typeof task.update === 'function') {
      await task.update(patch);
    }
    return true;
  }

  private async materializeMissingWorkflowJob(
    task: Model,
    wfJobId: string,
    meta: RcloneWorkflowJobMeta,
    outcome: {
      success: boolean;
      bytes: number;
      totalBytes: number;
      duration?: number;
      errorText?: string;
    },
    resumeToken: string,
  ): Promise<JobModel | undefined> {
    if (!this.app.db.getCollection?.('jobs')) {
      return undefined;
    }

    const taskId = Number(task.get('id'));
    const failOnError = meta.failOnError !== false;
    const nextJobStatus = outcome.success || !failOnError ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED;
    const rcloneJobId = Number(task.get('rcloneJobId') ?? 0);
    const rcloneExecuteId = String(task.get('rcloneExecuteId') ?? '').trim() || undefined;
    const rcloneGroup = String(task.get('rcloneGroup') ?? '').trim() || undefined;

    const nextResult: RcloneTransferJobState = {
      taskId,
      connectionId: meta.connectionId,
      rcloneJobId: Number.isFinite(rcloneJobId) ? rcloneJobId : 0,
      ...(rcloneExecuteId ? { rcloneExecuteId } : {}),
      ...(rcloneGroup ? { rcloneGroup } : {}),
      resumeToken,
      operation: meta.operation,
      srcFs: meta.srcFs,
      srcRemote: meta.srcRemote,
      dstFs: meta.dstFs,
      dstRemote: meta.dstRemote,
      failOnError,
      success: outcome.success,
      bytes: outcome.bytes,
      totalBytes: outcome.totalBytes,
      duration: outcome.duration ?? 0,
      error: outcome.errorText || '',
    };

    const jobValues: Record<string, unknown> = {
      id: wfJobId,
      executionId: meta.executionId,
      ...(meta.workflowId != null ? { workflowId: meta.workflowId } : {}),
      nodeId: meta.nodeId,
      nodeKey: meta.nodeKey,
      upstreamId: meta.upstreamId ?? null,
      status: nextJobStatus,
      result: nextResult,
    };

    const jobCollection = this.app.db.getCollection('jobs');
    const jobsRepo = this.app.db.getRepository?.('jobs') as
      | {
          create?: (opts: { values: Record<string, unknown> }) => Promise<JobModel>;
          findOne?: (opts: { filterByTk: string; appends?: string[] }) => Promise<JobModel | null>;
        }
      | undefined;
    const jobModelCreate = (
      jobCollection?.model as { create?: (vals: Record<string, unknown>) => Promise<JobModel> } | undefined
    )?.create;

    let createdJob: JobModel | undefined;
    try {
      if (typeof jobsRepo?.create === 'function') {
        createdJob = await jobsRepo.create({ values: jobValues });
      } else if (typeof jobModelCreate === 'function') {
        createdJob = await jobModelCreate.call(jobCollection.model, jobValues);
      }
    } catch {
      // Concurrent Processor.exit() may have just inserted wfJobId; fall through to findOne below.
      createdJob = undefined;
    }

    if (typeof jobsRepo?.findOne === 'function') {
      const fetched = await jobsRepo.findOne({ filterByTk: wfJobId, appends: ['execution'] }).catch(() => null);
      if (fetched) {
        createdJob = fetched;
      }
    }

    if (!createdJob) {
      return undefined;
    }

    if (!createdJob.execution && typeof createdJob.getExecution === 'function') {
      createdJob.execution = await createdJob.getExecution().catch(() => undefined);
    }
    if (!createdJob.execution && this.app.db.getCollection?.('executions')) {
      const execRepo = this.app.db.getRepository?.('executions') as
        | { findOne?: (opts: { filterByTk: number | string }) => Promise<JobModel['execution'] | null> }
        | undefined;
      if (typeof execRepo?.findOne === 'function') {
        const execModel = await execRepo.findOne({ filterByTk: meta.executionId }).catch(() => null);
        if (execModel) {
          createdJob.execution = execModel;
        }
      }
    }
    if (!createdJob.execution && !this.app.db.getCollection?.('executions')) {
      (createdJob as unknown as { execution: Record<string, unknown> }).execution = {
        id: meta.executionId,
        workflowId: meta.workflowId,
        status: EXECUTION_STATUS.STARTED,
      };
    }
    if ((createdJob as unknown as { executionId?: unknown }).executionId == null) {
      (createdJob as unknown as { executionId: number | string }).executionId = meta.executionId;
    }
    return createdJob;
  }

  private async loadWorkflowNodes(
    workflowId: number | string | null | undefined,
    wfJob: JobModel,
    workflowPlugin?: WorkflowPlugin,
  ): Promise<FlowNodeLike[] | null> {
    const execNodes = (wfJob?.execution as unknown as { workflow?: { nodes?: FlowNodeLike[] } } | undefined)?.workflow
      ?.nodes;
    if (Array.isArray(execNodes) && execNodes.length > 0) {
      return execNodes;
    }
    if (workflowId != null) {
      const cached = (
        workflowPlugin as unknown as { enabledCache?: Map<unknown, { nodes?: FlowNodeLike[] }> } | undefined
      )?.enabledCache?.get(workflowId)?.nodes;
      if (Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
      if (this.app.db.getCollection?.('flow_nodes')) {
        const nodesRepo = this.app.db.getRepository?.('flow_nodes') as
          | { find?: (opts: { filter: Record<string, unknown> }) => Promise<FlowNodeLike[]> }
          | undefined;
        if (typeof nodesRepo?.find === 'function') {
          const rows = await nodesRepo.find({ filter: { workflowId } }).catch(() => null);
          if (Array.isArray(rows) && rows.length > 0) {
            return rows;
          }
        }
      }
    }
    return null;
  }

  private async inspectExecutionDownstreamState(
    wfJob: JobModel,
    executionId: number | string,
    workflowPlugin?: WorkflowPlugin,
    fallbackWorkflowId?: number | string | null,
  ): Promise<{ hasPendingLaterJob: boolean; hasAnyLaterJob: boolean }> {
    if (!this.app.db.getCollection?.('jobs')) {
      return { hasPendingLaterJob: false, hasAnyLaterJob: false };
    }
    const jobsRepo = this.app.db.getRepository?.('jobs') as
      | {
          find?: (opts: { filter: Record<string, unknown> }) => Promise<JobModel[]>;
          count?: (opts: { filter: Record<string, unknown> }) => Promise<number>;
        }
      | undefined;

    if (typeof jobsRepo?.find === 'function') {
      const execJobs = await jobsRepo.find({ filter: { executionId } }).catch(() => null);
      if (Array.isArray(execJobs)) {
        const laterJobs = execJobs.filter((item) => isJobAfterAnchor(item, wfJob));
        const workflowId =
          (wfJob.execution as { workflowId?: number | string } | undefined)?.workflowId ??
          (wfJob as unknown as { workflowId?: number | string })?.workflowId ??
          fallbackWorkflowId;
        const workflowNodes = await this.loadWorkflowNodes(workflowId, wfJob, workflowPlugin);
        const attachedNode = (wfJob as unknown as { node?: FlowNodeLike })?.node;
        const startNode = workflowNodes?.find((n) => String(n.id) === String(wfJob.nodeId)) ?? attachedNode;

        if (
          workflowNodes ||
          startNode?.downstream ||
          startNode?.upstream ||
          startNode?.downstreamId !== undefined ||
          startNode?.branchIndex !== undefined
        ) {
          const jobResult = (
            wfJob.result && typeof wfJob.result === 'object' ? wfJob.result : {}
          ) as Partial<RcloneTransferJobState>;
          const jobMeta = (wfJob.meta && typeof wfJob.meta === 'object' ? wfJob.meta : {}) as Record<string, unknown>;
          const jobToken = String(jobResult.resumeToken || `wfjob:${String(wfJob.id ?? '')}`).trim();
          const consumedMatches = Boolean(jobToken && String(jobMeta.consumedResumeToken ?? '') === jobToken);
          const trace = traceWorkflowContinuation(startNode, wfJob, execJobs, workflowNodes, consumedMatches);
          return {
            hasAnyLaterJob: laterJobs.length > 0,
            hasPendingLaterJob: trace.kind === 'parked',
          };
        }

        return {
          hasAnyLaterJob: laterJobs.length > 0,
          hasPendingLaterJob: laterJobs.some((item) => Number(item.status) === JOB_STATUS.PENDING),
        };
      }
    }

    if (typeof jobsRepo?.count === 'function') {
      const downstreamCount = await jobsRepo.count({ filter: { executionId, upstreamId: wfJob.id } }).catch(() => 0);
      if (downstreamCount > 0) {
        return { hasPendingLaterJob: true, hasAnyLaterJob: true };
      }
    }

    return { hasPendingLaterJob: false, hasAnyLaterJob: false };
  }

  private async setOrphanJobResumePendingFlag(
    jobInstance: JobModel,
    pendingFlag: boolean,
    options?: { dispatchToken?: string; expectedDispatchToken?: string },
  ): Promise<boolean> {
    let currMeta = (jobInstance.meta && typeof jobInstance.meta === 'object' ? jobInstance.meta : {}) as Record<
      string,
      unknown
    >;
    if (!pendingFlag && options?.expectedDispatchToken && this.app.db.getCollection?.('jobs')) {
      const jobsRepo = this.app.db.getRepository?.('jobs') as
        | { findOne?: (opts: { filterByTk: string }) => Promise<JobModel | null> }
        | undefined;
      if (typeof jobsRepo?.findOne === 'function') {
        const freshJob = await jobsRepo.findOne({ filterByTk: String(jobInstance.id) }).catch(() => null);
        if (freshJob?.meta && typeof freshJob.meta === 'object') {
          currMeta = freshJob.meta as Record<string, unknown>;
        }
      }
      const liveDispatchToken = String(currMeta.orphanDispatchToken ?? '').trim();
      if (liveDispatchToken && liveDispatchToken !== options.expectedDispatchToken) {
        return false;
      }
    }
    if (
      currMeta.orphanResumePending === pendingFlag &&
      (!options?.dispatchToken || currMeta.orphanDispatchToken === options.dispatchToken)
    ) {
      return true;
    }
    const nextMeta = {
      ...currMeta,
      orphanResumePending: pendingFlag,
      ...(options?.dispatchToken ? { orphanDispatchToken: options.dispatchToken } : {}),
    };
    const jobCollection = this.app.db.getCollection?.('jobs');
    const jobModelUpdate = (jobCollection?.model as { update?: typeof Model.update } | undefined)?.update;
    if (typeof jobModelUpdate === 'function') {
      await jobModelUpdate
        .call(jobCollection.model, { meta: nextMeta }, { where: { id: jobInstance.id } })
        .catch(() => {});
      jobInstance.set?.({ meta: nextMeta });
      const clearDirty = (jobInstance as unknown as { changed?: (field: string, val: boolean) => void }).changed;
      clearDirty?.call(jobInstance, 'meta', false);
    } else if (typeof jobInstance.save === 'function') {
      jobInstance.set?.({ meta: nextMeta });
      await jobInstance.save().catch(() => {});
    }
    return true;
  }

  private async resumeOrphanWorkflowJob(
    wfJob: JobModel,
    taskId: number,
    workflowPlugin: WorkflowPlugin,
    outcome: {
      success: boolean;
      bytes: number;
      totalBytes: number;
      duration?: number;
      errorText?: string;
    },
  ): Promise<boolean> {
    const wfJobId = String(wfJob.id);
    const lockKey = `rclone-manager:workflow-resume:${wfJobId}`;

    try {
      return await runWithAppLock(
        this.app as unknown as LockableAppLike,
        lockKey,
        async () => {
          let currentJob = wfJob;
          if (this.app.db.getCollection?.('jobs')) {
            const jobsRepo = this.app.db.getRepository?.('jobs') as
              | { findOne?: (opts: { filterByTk: string; appends?: string[] }) => Promise<JobModel | null> }
              | undefined;
            if (typeof jobsRepo?.findOne === 'function') {
              const reloaded = await jobsRepo
                .findOne({ filterByTk: wfJobId, appends: ['execution'] })
                .catch(() => null);
              if (reloaded) {
                if (
                  (wfJob as unknown as { node?: unknown }).node &&
                  !(reloaded as unknown as { node?: unknown }).node
                ) {
                  (reloaded as unknown as { node?: unknown }).node = (wfJob as unknown as { node?: unknown }).node;
                }
                currentJob = reloaded;
              }
            }
          }

          const volatileQueue = isVolatileEventQueue(this.app);
          const initialMeta = (currentJob.meta && typeof currentJob.meta === 'object' ? currentJob.meta : {}) as Record<
            string,
            unknown
          >;

          if (currentJob.status === JOB_STATUS.PENDING) {
            const prevResult = (
              currentJob.result && typeof currentJob.result === 'object' ? currentJob.result : {}
            ) as Partial<RcloneTransferJobState>;
            const failOnError = prevResult.failOnError !== false;
            const nextJobStatus = outcome.success || !failOnError ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED;
            const resumeToken = String(prevResult.resumeToken ?? '').trim() || `rtok-${wfJobId}-${crypto.randomUUID()}`;
            const nextResult = {
              ...prevResult,
              taskId,
              resumeToken,
              success: outcome.success,
              bytes: outcome.bytes,
              totalBytes: outcome.totalBytes,
              duration: outcome.duration ?? 0,
              error: outcome.errorText || '',
            };
            const nextMeta = { ...initialMeta, orphanResumePending: true };

            const jobCollection = this.app.db.getCollection('jobs');
            const jobModelUpdate = (jobCollection?.model as { update?: typeof Model.update } | undefined)?.update;
            if (typeof jobModelUpdate === 'function') {
              const [claimedCount] = await jobModelUpdate.call(
                jobCollection.model,
                { status: nextJobStatus, result: nextResult, meta: nextMeta },
                { where: { id: currentJob.id, status: JOB_STATUS.PENDING } },
              );
              if (claimedCount === 0) {
                return false;
              }
              currentJob.set({ status: nextJobStatus, result: nextResult, meta: nextMeta });
              const clearDirty = (currentJob as unknown as { changed?: (field: string, val: boolean) => void }).changed;
              if (typeof clearDirty === 'function') {
                clearDirty.call(currentJob, 'status', false);
                clearDirty.call(currentJob, 'result', false);
                clearDirty.call(currentJob, 'meta', false);
              }
            } else {
              currentJob.set({ status: nextJobStatus, result: nextResult, meta: nextMeta });
              await currentJob.save();
            }
          } else if (!volatileQueue && initialMeta.orphanResumePending === false) {
            return true;
          }

          if (!currentJob.execution && typeof currentJob.getExecution === 'function') {
            currentJob.execution = await currentJob.getExecution();
          }
          if (!currentJob.execution || currentJob.execution.status !== EXECUTION_STATUS.STARTED) {
            this.memoryDispatchRecords.delete(wfJobId);
            await this.setOrphanJobResumePendingFlag(currentJob, false);
            return true;
          }

          const { hasPendingLaterJob } = await this.inspectExecutionDownstreamState(
            currentJob,
            currentJob.execution.id,
            workflowPlugin,
            currentJob.execution.workflowId,
          );
          if (hasPendingLaterJob) {
            this.memoryDispatchRecords.delete(wfJobId);
            await this.setOrphanJobResumePendingFlag(currentJob, false);
            return true;
          }

          const orphanDispatchToken = `odtok-${wfJobId}-${crypto.randomUUID()}`;
          await this.setOrphanJobResumePendingFlag(currentJob, true, { dispatchToken: orphanDispatchToken });

          if (volatileQueue) {
            const rec = this.memoryDispatchRecords.get(wfJobId);
            if (rec && Date.now() - rec.timestamp < MEMORY_QUEUE_REDISPATCH_MS) {
              return false;
            }
          }

          try {
            await workflowPlugin.resume(currentJob);
          } catch (resumeError) {
            this.app.logger?.warn?.(
              `[plugin-rclone-manager] Failed to enqueue workflow resume for orphan job #${wfJobId}; keeping orphanResumePending for retry: ${String(
                resumeError,
              )}`,
            );
            return false;
          }

          if (volatileQueue) {
            this.memoryDispatchRecords.set(wfJobId, {
              executionId: String(currentJob.execution.id),
              timestamp: Date.now(),
            });
            return false;
          }

          return this.setOrphanJobResumePendingFlag(currentJob, false, {
            expectedDispatchToken: orphanDispatchToken,
          });
        },
        { timeoutMs: 10_000, ttlMs: 30_000 },
      );
    } catch (lockError) {
      if (isLockContentionError(lockError)) {
        return false;
      }
      throw lockError;
    }
  }

  private async dispatchWorkflowResumeForTask(
    task: Model,
    wfJobId: string,
    pendingJobsById: Map<string, JobModel>,
    workflowPlugin: WorkflowPlugin,
    outcome: {
      success: boolean;
      bytes: number;
      totalBytes: number;
      duration?: number;
      errorText?: string;
    },
    options?: {
      fromOrphanPendingScan?: boolean;
      isImmediateFinalize?: boolean;
    },
  ): Promise<boolean> {
    const taskId = Number(task.get('id'));
    const lockKey = `rclone-manager:workflow-resume:${wfJobId}`;

    try {
      return await runWithAppLock(
        this.app as unknown as LockableAppLike,
        lockKey,
        async () => {
          const taskRepo = this.app.db.getRepository?.(COLLECTIONS.tasks) as
            | { findOne?: (opts: { filterByTk: number }) => Promise<Model | null> }
            | undefined;
          const latestTask =
            typeof taskRepo?.findOne === 'function' && Number.isFinite(taskId) && taskId > 0
              ? await taskRepo.findOne({ filterByTk: taskId }).catch(() => null)
              : null;
          const currentTask = latestTask ?? task;

          // If RcloneTransferInstruction.resume already consumed this task's resume token, clear flag and skip.
          const consumedToken = String(currentTask.get('resumeConsumedToken') ?? '').trim();
          if (consumedToken) {
            if (currentTask.get('resumePending')) {
              await this.clearTaskResumePending(currentTask);
            }
            return true;
          }

          let wfJob = this.app.db.getCollection('jobs')
            ? ((await this.app.db.getRepository('jobs').findOne({
                filterByTk: wfJobId,
                appends: ['execution'],
              })) as JobModel | null) ?? undefined
            : undefined;
          if (!wfJob) {
            wfJob = pendingJobsById.get(wfJobId);
          }

          const isResumePending = Boolean(currentTask.get('resumePending'));
          if (options?.fromOrphanPendingScan) {
            // Re-verify inside the per-job lock before flipping resumePending so a second reconciler acting on a
            // stale PENDING snapshot cannot re-arm and re-publish a job that a peer reconciler already settled.
            if (!isResumePending && (!wfJob || wfJob.status !== JOB_STATUS.PENDING)) {
              return true;
            }
          } else if (latestTask && latestTask.get('resumePending') === false) {
            return true;
          }

          const prevJobResult = (
            wfJob?.result && typeof wfJob.result === 'object' ? wfJob.result : {}
          ) as Partial<RcloneTransferJobState>;
          const resumeToken =
            String(currentTask.get('resumeToken') ?? prevJobResult.resumeToken ?? '').trim() ||
            `rtok-${wfJobId}-${crypto.randomUUID()}`;

          await this.markTaskResumePending(currentTask, wfJobId, resumeToken);

          if (!wfJob) {
            const meta = extractWorkflowJobMeta(currentTask);
            if (!meta) {
              // No reconstruction metadata (e.g. legacy row or Processor.exit() still flushing); retry on next tick.
              return false;
            }
            const rawStartedAt = currentTask.get('startedAt');
            const startedMs = rawStartedAt ? new Date(String(rawStartedAt)).getTime() : Number.NaN;
            const elapsedMs = Number.isFinite(startedMs) ? Date.now() - startedMs : Number.POSITIVE_INFINITY;
            if (options?.isImmediateFinalize && elapsedMs < MISSING_JOB_FLUSH_GRACE_MS) {
              return false;
            }
            wfJob = await this.materializeMissingWorkflowJob(currentTask, wfJobId, meta, outcome, resumeToken);
            if (!wfJob) {
              return false;
            }
          }

          const taskRcloneJobId = Number(currentTask.get('rcloneJobId') ?? 0);
          const effectiveRcloneJobId =
            Number.isFinite(taskRcloneJobId) && taskRcloneJobId > 0
              ? taskRcloneJobId
              : Number(prevJobResult.rcloneJobId ?? 0);
          const effectiveExecuteId =
            String(currentTask.get('rcloneExecuteId') ?? prevJobResult.rcloneExecuteId ?? '').trim() || undefined;
          const effectiveGroup =
            String(currentTask.get('rcloneGroup') ?? prevJobResult.rcloneGroup ?? '').trim() || undefined;

          if (wfJob.status === JOB_STATUS.PENDING) {
            const prevResult = (
              wfJob.result && typeof wfJob.result === 'object' ? wfJob.result : {}
            ) as Partial<RcloneTransferJobState>;
            const failOnError = prevResult.failOnError !== false;
            const nextJobStatus = outcome.success || !failOnError ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED;
            const nextResult: Partial<RcloneTransferJobState> = {
              ...prevResult,
              taskId,
              rcloneJobId: effectiveRcloneJobId,
              ...(effectiveExecuteId ? { rcloneExecuteId: effectiveExecuteId } : {}),
              ...(effectiveGroup ? { rcloneGroup: effectiveGroup } : {}),
              resumeToken,
              success: outcome.success,
              bytes: outcome.bytes,
              totalBytes: outcome.totalBytes,
              duration: outcome.duration ?? 0,
              error: outcome.errorText || '',
            };

            const jobCollection = this.app.db.getCollection('jobs');
            const jobModelUpdate = (jobCollection?.model as { update?: typeof Model.update } | undefined)?.update;
            if (typeof jobModelUpdate === 'function') {
              const [claimedCount] = await jobModelUpdate.call(
                jobCollection.model,
                { status: nextJobStatus, result: nextResult },
                { where: { id: wfJob.id, status: JOB_STATUS.PENDING } },
              );
              if (claimedCount === 0) {
                return false;
              }
              wfJob.set({ status: nextJobStatus, result: nextResult });
              const clearDirty = (wfJob as unknown as { changed?: (field: string, val: boolean) => void }).changed;
              if (typeof clearDirty === 'function') {
                clearDirty.call(wfJob, 'status', false);
                clearDirty.call(wfJob, 'result', false);
              }
            } else {
              wfJob.set({ status: nextJobStatus, result: nextResult });
              await wfJob.save();
            }
          } else {
            const currentJobResult = (
              wfJob.result && typeof wfJob.result === 'object' ? wfJob.result : {}
            ) as Partial<RcloneTransferJobState>;
            if (
              currentJobResult.resumeToken !== resumeToken ||
              (!currentJobResult.rcloneJobId && effectiveRcloneJobId > 0) ||
              !currentJobResult.taskId
            ) {
              const patchedResult: Partial<RcloneTransferJobState> = {
                ...currentJobResult,
                taskId,
                rcloneJobId: effectiveRcloneJobId,
                ...(effectiveExecuteId ? { rcloneExecuteId: effectiveExecuteId } : {}),
                ...(effectiveGroup ? { rcloneGroup: effectiveGroup } : {}),
                resumeToken,
              };
              const jobCollection = this.app.db.getCollection('jobs');
              const jobModelUpdate = (jobCollection?.model as { update?: typeof Model.update } | undefined)?.update;
              if (typeof jobModelUpdate === 'function') {
                await jobModelUpdate
                  .call(jobCollection.model, { result: patchedResult }, { where: { id: wfJob.id } })
                  .catch(() => {});
                wfJob.set({ result: patchedResult });
                const clearDirty = (wfJob as unknown as { changed?: (field: string, val: boolean) => void }).changed;
                clearDirty?.call(wfJob, 'result', false);
              } else if (typeof wfJob.save === 'function') {
                wfJob.set({ result: patchedResult });
                await wfJob.save().catch(() => {});
              }
            }
          }

          if (!wfJob.execution && typeof wfJob.getExecution === 'function') {
            wfJob.execution = await wfJob.getExecution();
          }
          if (!wfJob.execution || wfJob.execution.status !== EXECUTION_STATUS.STARTED) {
            this.memoryDispatchRecords.delete(wfJobId);
            await this.clearTaskResumePending(currentTask);
            return true;
          }

          // Distinguish a workflow legitimately waiting at a later PENDING node on THIS rclone job's own continuation
          // path (never a sibling Parallel branch!) from an unfinished downstream step or crashed terminal child node.
          const { hasPendingLaterJob } = await this.inspectExecutionDownstreamState(
            wfJob,
            wfJob.execution.id,
            workflowPlugin,
            (currentTask.get('workflowId') as number | string | null | undefined) ?? wfJob.execution.workflowId,
          );
          if (hasPendingLaterJob) {
            this.memoryDispatchRecords.delete(wfJobId);
            await this.clearTaskResumePending(currentTask);
            return true;
          }

          const volatileQueue = isVolatileEventQueue(this.app);
          if (volatileQueue) {
            const lastMemRec = this.memoryDispatchRecords.get(wfJobId);
            if (lastMemRec !== undefined && Date.now() - lastMemRec.timestamp < MEMORY_QUEUE_REDISPATCH_MS) {
              return false;
            }
          }

          try {
            await workflowPlugin.resume(wfJob);
          } catch (resumeError) {
            this.app.logger?.warn?.(
              `[plugin-rclone-manager] Failed to publish workflow resume for task #${taskId} (job #${wfJobId}); keeping resumePending for retry: ${String(
                resumeError,
              )}`,
            );
            return false;
          }

          if (volatileQueue) {
            // MemoryEventQueueAdapter holds messages only in RAM; keep resumePending=true in DB until the workflow
            // durably finishes execution or parks at a later PENDING job so an abrupt restart re-publishes immediately.
            this.memoryDispatchRecords.set(wfJobId, {
              executionId: String(wfJob.execution.id),
              timestamp: Date.now(),
            });
            return false;
          }

          return this.clearTaskResumePending(currentTask, resumeToken);
        },
        { timeoutMs: 10_000, ttlMs: 30_000 },
      );
    } catch (lockError) {
      if (isLockContentionError(lockError)) {
        return false;
      }
      throw lockError;
    }
  }

  async finalizeTaskAndWorkflowJob(
    task: Model,
    pendingJobsById: Map<string, JobModel>,
    workflowPlugin: WorkflowPlugin | undefined,
    outcome: {
      status: 'completed' | 'failed' | 'stopped' | 'unverified';
      success: boolean;
      rcloneJobId?: number;
      rcloneExecuteId?: string | null;
      bytes?: number;
      totalBytes?: number;
      duration?: number;
      errorText?: string;
    },
  ): Promise<boolean> {
    const bytes = outcome.bytes ?? Number(task.get('bytes') ?? 0);
    const totalBytes = outcome.totalBytes ?? Number(task.get('totalBytes') ?? 0);
    const completedAt = new Date();
    const rawStartedAt = task.get('startedAt');
    const startedMs = rawStartedAt ? new Date(String(rawStartedAt)).getTime() : Number.NaN;
    const wallDurationSec = Number.isFinite(startedMs)
      ? Math.max(0.001, (completedAt.getTime() - startedMs) / 1000)
      : 0;
    const effectiveDurationSec =
      typeof outcome.duration === 'number' && outcome.duration > 0 ? outcome.duration : wallDurationSec;
    const avgSpeed = bytes > 0 && effectiveDurationSec > 0 ? Math.round(bytes / effectiveDurationSec) : 0;

    const wfJobId = allocateWorkflowJobIdIfMissing(task, workflowPlugin);
    const needsWorkflowResume = Boolean(wfJobId);
    const existingResumeToken = String(task.get('resumeToken') ?? '').trim();
    const resumeToken = needsWorkflowResume
      ? existingResumeToken || `rtok-${wfJobId}-${crypto.randomUUID()}`
      : undefined;

    const taskPatch: Record<string, unknown> = {
      status: outcome.status,
      ...(typeof outcome.rcloneJobId === 'number' && outcome.rcloneJobId > 0
        ? { rcloneJobId: outcome.rcloneJobId }
        : {}),
      ...(outcome.rcloneExecuteId !== undefined ? { rcloneExecuteId: outcome.rcloneExecuteId } : {}),
      bytes,
      totalBytes,
      speed: avgSpeed,
      eta: null,
      progress: outcome.success ? 100 : computePercent(bytes, totalBytes),
      errorText: outcome.errorText || null,
      completedAt,
      ...(needsWorkflowResume ? { workflowJobId: wfJobId, resumePending: true, resumeToken } : {}),
    };

    const taskId = Number(task.get('id'));
    const taskCollection = this.app.db.getCollection(COLLECTIONS.tasks);
    const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
    if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
      const [affectedCount] = await taskModelUpdate.call(taskCollection.model, taskPatch, {
        where: { id: taskId, status: ['queued', 'starting', 'running'] },
      });
      if (affectedCount === 0) {
        return true;
      }
      if (typeof (task as { set?: (vals: Record<string, unknown>) => void }).set === 'function') {
        task.set(taskPatch);
      }
    } else {
      await task.update(taskPatch);
    }

    if (!needsWorkflowResume || !workflowPlugin) {
      return true;
    }

    return this.dispatchWorkflowResumeForTask(
      task,
      wfJobId,
      pendingJobsById,
      workflowPlugin,
      {
        success: outcome.success,
        bytes,
        totalBytes,
        duration: outcome.duration ?? 0,
        errorText: outcome.errorText || '',
      },
      { isImmediateFinalize: true },
    );
  }
}
