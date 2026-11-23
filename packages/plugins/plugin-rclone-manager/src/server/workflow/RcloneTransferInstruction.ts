// SPDX-License-Identifier: Apache-2.0

import type { Model } from '@nocobase/database';
import WorkflowPlugin, {
  Instruction,
  JOB_STATUS,
  type FlowNodeModel,
  type JobModel,
  type Processor,
} from '@nocobase/plugin-workflow';
import { COLLECTIONS, PLUGIN_NAME, TRANSFER_OPERATIONS } from '../../shared/constants';
import { isConnectionStringOverride, normalizeRemoteSubPath } from '../../shared/fs-guard';
import type { RcloneTransferJobState, RcloneTransferNodeConfig, RcloneTransferOperation } from '../../shared/types';
import type PluginRcloneManagerServer from '../plugin';

function isValidOperation(op: string): op is RcloneTransferOperation {
  return (TRANSFER_OPERATIONS as readonly string[]).includes(op);
}

function joinFsWithSubPath(fs: string, subPath: string): string {
  const cleanFs = fs.trim();
  const cleanSub = normalizeRemoteSubPath(subPath);
  if (!cleanSub) {
    return cleanFs;
  }
  if (cleanFs.endsWith(':') || cleanFs.endsWith('/') || cleanFs.endsWith('\\')) {
    return `${cleanFs}${cleanSub}`;
  }
  return `${cleanFs}/${cleanSub}`;
}

function parseRuleLines(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  return raw
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export class RcloneTransferInstruction extends Instruction {
  constructor(public workflow: WorkflowPlugin) {
    super(workflow);
  }

  private get rclonePlugin(): PluginRcloneManagerServer {
    const plugin = this.workflow.app.pm.get(PLUGIN_NAME) ?? this.workflow.app.pm.get('rclone-manager');
    if (!plugin) {
      throw new Error('plugin-rclone-manager is not loaded');
    }
    return plugin as PluginRcloneManagerServer;
  }

  async run(node: FlowNodeModel, prevJob: JobModel, processor: Processor) {
    const rawConfig = (node.config ?? {}) as RcloneTransferNodeConfig;
    const parsedTaskId = rawConfig.taskId ? processor.getParsedValue(rawConfig.taskId, node.id) : undefined;
    const failOnError = rawConfig.failOnError !== false;

    const taskRepo = this.workflow.app.db.getRepository(COLLECTIONS.tasks);
    let taskModel: Model | null = null;

    if (parsedTaskId !== undefined && parsedTaskId !== null && String(parsedTaskId).trim() !== '') {
      taskModel = await taskRepo.findOne({ filterByTk: Number(parsedTaskId) });
      if (!taskModel) {
        return {
          status: failOnError ? JOB_STATUS.FAILED : JOB_STATUS.RESOLVED,
          result: { success: false, error: `Transfer task #${String(parsedTaskId)} was not found` },
        };
      }
      const existingStatus = String(taskModel.get('status') ?? '');
      if (existingStatus !== 'queued') {
        const errText =
          existingStatus === 'running'
            ? `Transfer task #${String(parsedTaskId)} is already running`
            : String(taskModel.get('errorText') || `Transfer task #${String(parsedTaskId)} was ${existingStatus}`);
        return {
          status: existingStatus === 'completed' || !failOnError ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED,
          result: {
            taskId: Number(taskModel.get('id')),
            success: existingStatus === 'completed',
            error: existingStatus === 'completed' ? '' : errText,
          },
        };
      }
    }

    try {
      const connectionId = taskModel
        ? Number(taskModel.get('connectionId'))
        : Number(processor.getParsedValue(rawConfig.connectionId, node.id));
      const rawOperation = String(
        taskModel ? taskModel.get('operation') : processor.getParsedValue(rawConfig.operation ?? 'sync/copy', node.id),
      ).trim();

      if (!isValidOperation(rawOperation)) {
        throw new Error(`Unsupported Rclone transfer operation: ${rawOperation}`);
      }

      const srcFs = String(
        taskModel ? taskModel.get('srcFs') : processor.getParsedValue(rawConfig.srcFs ?? '', node.id),
      ).trim();
      const srcRemote = normalizeRemoteSubPath(
        String(
          taskModel
            ? taskModel.get('srcRemote') ?? ''
            : processor.getParsedValue(rawConfig.srcRemote ?? '', node.id) ?? '',
        ),
      );
      const dstFs = String(
        taskModel ? taskModel.get('dstFs') : processor.getParsedValue(rawConfig.dstFs ?? '', node.id),
      ).trim();
      const dstRemote = normalizeRemoteSubPath(
        String(
          taskModel
            ? taskModel.get('dstRemote') ?? ''
            : processor.getParsedValue(rawConfig.dstRemote ?? '', node.id) ?? '',
        ),
      );

      if (!srcFs || !dstFs) {
        throw new Error('Both source (srcFs) and destination (dstFs) are required');
      }

      const { client } = await this.rclonePlugin.connectionManager.getClient(connectionId, true);

      // Privilege escalation guard: local disk paths and ad-hoc connection overrides require explicit authorization
      const authorized = taskModel ? Boolean(taskModel.get('localAuthorized')) : Boolean(rawConfig.allowLocalPaths);
      let touchesLocal = false;
      if (!authorized) {
        if (isConnectionStringOverride(srcFs) || isConnectionStringOverride(dstFs)) {
          throw new Error(
            'On-the-fly Rclone connection strings and parameter overrides are blocked unless explicitly authorized',
          );
        }
        touchesLocal = (await client.isFsLocal(srcFs)) || (await client.isFsLocal(dstFs));
        if (touchesLocal) {
          throw new Error('Local filesystem paths are blocked unless authorized by high-privilege local-fs permission');
        }
      } else {
        touchesLocal =
          isConnectionStringOverride(srcFs) ||
          isConnectionStringOverride(dstFs) ||
          (await client.isFsLocal(srcFs)) ||
          (await client.isFsLocal(dstFs));
      }

      const dryRun = taskModel ? Boolean(taskModel.get('dryRun')) : Boolean(rawConfig.dryRun);
      const createEmptySrcDirs = taskModel
        ? Boolean(taskModel.get('createEmptySrcDirs'))
        : Boolean(rawConfig.createEmptySrcDirs);
      const deleteEmptySrcDirs = taskModel
        ? Boolean(taskModel.get('deleteEmptySrcDirs'))
        : Boolean(rawConfig.deleteEmptySrcDirs);

      let filterPayload = (taskModel?.get('filterRules') as Record<string, unknown> | null) ?? null;
      if (!filterPayload) {
        const includeRules = parseRuleLines(
          rawConfig.filterInclude ? processor.getParsedValue(rawConfig.filterInclude, node.id) : '',
        );
        const excludeRules = parseRuleLines(
          rawConfig.filterExclude ? processor.getParsedValue(rawConfig.filterExclude, node.id) : '',
        );
        if (includeRules.length > 0 || excludeRules.length > 0) {
          filterPayload = {
            ...(includeRules.length > 0 ? { IncludeRule: includeRules } : {}),
            ...(excludeRules.length > 0 ? { ExcludeRule: excludeRules } : {}),
          };
        }
      }

      const rcBody: Record<string, unknown> = {};
      if (rawOperation === 'operations/copyfile' || rawOperation === 'operations/movefile') {
        if (!srcRemote || !dstRemote) {
          throw new Error(`${rawOperation} requires both srcRemote and dstRemote file paths`);
        }
        if (!srcRemote.includes('/') && (await client.isUnrootedBucketFs(srcFs))) {
          throw new Error(`Source "${srcFs}" is bucket-based storage and requires "<bucket>/<file>" in srcRemote`);
        }
        if (!dstRemote.includes('/') && (await client.isUnrootedBucketFs(dstFs))) {
          throw new Error(
            `Destination "${dstFs}" is bucket-based storage and cannot store files at root; specify "<bucket>/<file>" in dstRemote`,
          );
        }
        rcBody.srcFs = srcFs;
        rcBody.srcRemote = srcRemote;
        rcBody.dstFs = dstFs;
        rcBody.dstRemote = dstRemote;
      } else if (rawOperation === 'sync/bisync') {
        rcBody.path1 = joinFsWithSubPath(srcFs, srcRemote);
        rcBody.path2 = joinFsWithSubPath(dstFs, dstRemote);
        if (dryRun) rcBody.dryRun = true;
      } else {
        rcBody.srcFs = joinFsWithSubPath(srcFs, srcRemote);
        rcBody.dstFs = joinFsWithSubPath(dstFs, dstRemote);
        if (createEmptySrcDirs) rcBody.createEmptySrcDirs = true;
        if (rawOperation === 'sync/move' && deleteEmptySrcDirs) rcBody.deleteEmptySrcDirs = true;
      }

      if (dryRun) {
        rcBody._config = {
          ...((taskModel?.get('extraConfig') as Record<string, unknown> | null) ?? {}),
          DryRun: true,
        };
      } else if (taskModel?.get('extraConfig')) {
        rcBody._config = taskModel.get('extraConfig');
      }

      if (filterPayload && Object.keys(filterPayload).length > 0) {
        rcBody._filter = filterPayload;
      }

      if (!taskModel) {
        taskModel = await taskRepo.create({
          values: {
            title: `${rawOperation}: ${joinFsWithSubPath(srcFs, srcRemote)} -> ${joinFsWithSubPath(dstFs, dstRemote)}`,
            connectionId,
            operation: rawOperation,
            srcFs,
            srcRemote,
            dstFs,
            dstRemote,
            createEmptySrcDirs,
            deleteEmptySrcDirs,
            dryRun,
            filterRules: filterPayload,
            triggerSource: 'workflow',
            localAuthorized: touchesLocal,
            status: 'queued',
          },
        });
      }

      const { jobid } = await client.postAsync(`/${rawOperation}`, rcBody);

      const jobState: RcloneTransferJobState = {
        taskId: Number(taskModel.get('id')),
        connectionId,
        rcloneJobId: jobid,
        operation: rawOperation,
        srcFs,
        srcRemote,
        dstFs,
        dstRemote,
        failOnError,
      };

      const savedJob = processor.saveJob({
        status: JOB_STATUS.PENDING,
        result: jobState,
        nodeId: node.id,
        nodeKey: node.key,
        upstreamId: prevJob?.id ?? null,
      });

      const taskId = Number(taskModel.get('id'));
      const taskPatch = {
        status: 'running',
        rcloneJobId: jobid,
        workflowId: processor.execution.workflowId,
        executionId: processor.execution.id,
        workflowJobId: String(savedJob.id),
        startedAt: new Date(),
        errorText: null,
      };
      const taskCollection = this.workflow.app.db.getCollection?.(COLLECTIONS.tasks);
      const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
      if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
        const [claimedCount] = await taskModelUpdate.call(taskCollection.model, taskPatch, {
          where: { id: taskId, status: 'queued' },
        });
        if (claimedCount === 0) {
          await client.stopJob(jobid).catch(() => {});
          const latestTask = await taskRepo.findOne({ filterByTk: taskId }).catch(() => null);
          const latestStatus = String(latestTask?.get('status') ?? 'stopped');
          const errText = String(latestTask?.get('errorText') || `Transfer task #${taskId} was ${latestStatus}`);
          savedJob.set({
            status: latestStatus === 'completed' || !failOnError ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED,
            result: {
              ...jobState,
              success: latestStatus === 'completed',
              error: latestStatus === 'completed' ? '' : errText,
            },
          });
          return savedJob;
        }
        if (typeof (taskModel as { set?: (vals: Record<string, unknown>) => void }).set === 'function') {
          taskModel.set(taskPatch);
        }
      } else {
        await taskModel.update(taskPatch);
      }

      this.rclonePlugin.reconciler.kick(400);
      return savedJob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (taskModel) {
        await taskModel.update({
          status: 'failed',
          errorText: message,
          completedAt: new Date(),
        });
      }
      return {
        status: failOnError ? JOB_STATUS.FAILED : JOB_STATUS.RESOLVED,
        result: {
          taskId: taskModel ? Number(taskModel.get('id')) : 0,
          success: false,
          error: message,
        },
      };
    }
  }

  async resume(_node: FlowNodeModel, job: JobModel, _processor: Processor) {
    return job;
  }
}

export default RcloneTransferInstruction;
