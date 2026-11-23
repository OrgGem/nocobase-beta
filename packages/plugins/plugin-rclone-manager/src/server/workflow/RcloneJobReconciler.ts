// SPDX-License-Identifier: Apache-2.0

import type { Model } from '@nocobase/database';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import { EXECUTION_STATUS, JOB_STATUS, type JobModel } from '@nocobase/plugin-workflow';
import type { Application } from '@nocobase/server';
import { COLLECTIONS, RCLONE_TRANSFER_INSTRUCTION_TYPE } from '../../shared/constants';
import type { RcloneTransferJobState } from '../../shared/types';
import type { RcloneConnectionManager } from './../services/connection-manager';

const POLL_INTERVAL_MS = 2_500;
const IDLE_POLL_INTERVAL_MS = 30_000;

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

  constructor(
    private readonly app: Application,
    private readonly connectionManager: RcloneConnectionManager,
  ) {}

  start(): void {
    this.stopped = false;
    this.kick(250);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
      this.reconcileOnce().catch((error) => {
        this.app.logger?.warn?.(`[plugin-rclone-manager] Reconciler iteration warning: ${String(error)}`);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async reconcileOnce(): Promise<void> {
    if (this.running || this.stopped) {
      return;
    }
    if (!this.app.db.getCollection(COLLECTIONS.tasks)) {
      return;
    }

    this.running = true;
    let hasActiveWork = false;
    try {
      const taskRepo = this.app.db.getRepository(COLLECTIONS.tasks);
      const runningTasks = (await taskRepo.find({
        filter: { status: 'running' },
      })) as Model[];

      // Also discover pending workflow jobs in case server restarted right after job save
      const workflowPlugin = this.app.pm.get('workflow') as WorkflowPlugin | undefined;
      const pendingJobsById = new Map<string, JobModel>();
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
              attributes: ['id', 'type', 'config'],
              where: { type: RCLONE_TRANSFER_INSTRUCTION_TYPE },
              required: true,
            },
          ],
        })) as JobModel[];
        for (const job of pendingJobs) {
          pendingJobsById.set(String(job.id), job);
        }
      }

      if (runningTasks.length === 0 && pendingJobsById.size === 0) {
        return;
      }

      // Group running tasks by connectionId so we reuse each connection's RC client
      const byConnection = new Map<number, Model[]>();
      const handledJobIds = new Set<string>();
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
              if (wfJobId && resumed) {
                handledJobIds.add(wfJobId);
              } else if (!resumed) {
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
          const wfJobId = String(task.get('workflowJobId') ?? '').trim();
          if (!Number.isFinite(rcloneJobId) || rcloneJobId <= 0) {
            continue;
          }

          const groupName = `job/${rcloneJobId}`;
          const [statusResult, groupStats] = await Promise.all([
            client.getJobStatus(rcloneJobId).then(
              (status) => ({ ok: true as const, status }),
              (error: unknown) => ({ ok: false as const, error }),
            ),
            client.getStats(groupName).catch(() => null),
          ]);

          if (!statusResult.ok) {
            // Keep task running on transient network/timeout/5xx errors; retry on next poll tick.
            hasActiveWork = true;
            if (wfJobId) handledJobIds.add(wfJobId);
            this.app.logger?.warn?.(
              `[plugin-rclone-manager] Transient /job/status error for task #${String(
                task.get('id'),
              )} (job ${rcloneJobId}): ${String(statusResult.error)}`,
            );
            continue;
          }

          const jobStatus = statusResult.status;
          const bytes = Number(groupStats?.bytes ?? task.get('bytes') ?? 0);
          const totalBytes = Number(groupStats?.totalBytes ?? task.get('totalBytes') ?? 0);
          const speed = Number(groupStats?.speed ?? 0);
          const eta = typeof groupStats?.eta === 'number' && Number.isFinite(groupStats.eta) ? groupStats.eta : null;
          const firstItemPct = groupStats?.transferring?.[0]?.percentage;

          if (!jobStatus) {
            // Job purged from rclone memory (e.g. rclone daemon restarted while running)
            const resumed = await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
              status: 'failed',
              success: false,
              bytes,
              totalBytes,
              errorText: 'Rclone job disappeared from daemon (daemon may have restarted)',
            });
            if (wfJobId && resumed) {
              handledJobIds.add(wfJobId);
            } else if (!resumed) {
              hasActiveWork = true;
            }
            continue;
          }

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
          if (wfJobId && resumed) {
            handledJobIds.add(wfJobId);
          } else if (!resumed) {
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
            await this.resumePendingWorkflowJob(wfJob, taskId, workflowPlugin, {
              success: false,
              bytes: 0,
              totalBytes: 0,
              duration: 0,
              errorText: `Transfer task #${taskId} was not found`,
            });
            continue;
          }
          const taskStatus = String(task.get('status') ?? '');
          if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'stopped') {
            const rawStartedAt = task.get('startedAt');
            const rawCompletedAt = task.get('completedAt');
            const startedMs = rawStartedAt ? new Date(String(rawStartedAt)).getTime() : Number.NaN;
            const completedMs = rawCompletedAt ? new Date(String(rawCompletedAt)).getTime() : Number.NaN;
            const duration =
              Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
                ? (completedMs - startedMs) / 1000
                : 0;
            await this.resumePendingWorkflowJob(wfJob, taskId, workflowPlugin, {
              success: taskStatus === 'completed',
              bytes: Number(task.get('bytes') ?? 0),
              totalBytes: Number(task.get('totalBytes') ?? 0),
              duration,
              errorText: String(task.get('errorText') ?? ''),
            });
          } else if (
            (taskStatus === 'queued' || (taskStatus === 'running' && !(Number(task.get('rcloneJobId')) > 0))) &&
            Number.isFinite(Number(jobState.rcloneJobId)) &&
            Number(jobState.rcloneJobId) > 0
          ) {
            await task.update({
              status: 'running',
              rcloneJobId: Number(jobState.rcloneJobId),
              workflowJobId: wfJobId,
              startedAt: task.get('startedAt') ?? new Date(),
            });
            hasActiveWork = true;
          } else if (taskStatus === 'running' && !(Number(task.get('rcloneJobId')) > 0)) {
            // Corrupted running task with no rcloneJobId on either task or workflow job; fail cleanly instead of spinning forever.
            await this.finalizeTaskAndWorkflowJob(task, pendingJobsById, workflowPlugin, {
              status: 'failed',
              success: false,
              errorText: 'Rclone job ID is missing for running task',
            });
          } else {
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

  private async resumePendingWorkflowJob(
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
  ): Promise<void> {
    if (wfJob.status !== JOB_STATUS.PENDING) {
      return;
    }

    const prevResult = (
      wfJob.result && typeof wfJob.result === 'object' ? wfJob.result : {}
    ) as Partial<RcloneTransferJobState>;
    const failOnError = prevResult.failOnError !== false;
    const nextJobStatus = outcome.success || !failOnError ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED;
    const nextResult = {
      ...prevResult,
      taskId,
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
        return;
      }
      wfJob.set({ status: nextJobStatus, result: nextResult });
    } else {
      wfJob.set({ status: nextJobStatus, result: nextResult });
      await wfJob.save();
    }

    if (!wfJob.execution) {
      wfJob.execution = await wfJob.getExecution();
    }
    if (wfJob.execution && wfJob.execution.status === EXECUTION_STATUS.STARTED) {
      await workflowPlugin.resume(wfJob);
    }
  }

  async finalizeTaskAndWorkflowJob(
    task: Model,
    pendingJobsById: Map<string, JobModel>,
    workflowPlugin: WorkflowPlugin | undefined,
    outcome: {
      status: 'completed' | 'failed' | 'stopped';
      success: boolean;
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

    const taskPatch = {
      status: outcome.status,
      bytes,
      totalBytes,
      speed: avgSpeed,
      eta: null,
      progress: outcome.success ? 100 : computePercent(bytes, totalBytes),
      errorText: outcome.errorText || null,
      completedAt,
    };

    const taskId = Number(task.get('id'));
    const taskCollection = this.app.db.getCollection(COLLECTIONS.tasks);
    const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
    if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
      const [affectedCount] = await taskModelUpdate.call(taskCollection.model, taskPatch, {
        where: { id: taskId, status: ['queued', 'running'] },
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

    const wfJobId = String(task.get('workflowJobId') ?? '').trim();
    if (!wfJobId || !workflowPlugin) {
      return true;
    }

    let wfJob = pendingJobsById.get(wfJobId);
    if (!wfJob && this.app.db.getCollection('jobs')) {
      wfJob =
        ((await this.app.db.getRepository('jobs').findOne({
          filterByTk: wfJobId,
          appends: ['execution'],
        })) as JobModel | null) ?? undefined;
    }
    if (!wfJob) {
      // Processor.exit() may not have flushed the newly built JobModel yet; signal caller to schedule one follow-up tick.
      return false;
    }
    if (wfJob.status !== JOB_STATUS.PENDING) {
      return true;
    }

    await this.resumePendingWorkflowJob(wfJob, taskId, workflowPlugin, {
      success: outcome.success,
      bytes,
      totalBytes,
      duration: outcome.duration ?? 0,
      errorText: outcome.errorText || '',
    });
    return true;
  }
}
