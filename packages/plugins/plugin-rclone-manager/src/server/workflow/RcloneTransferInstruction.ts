// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import type { Model } from '@nocobase/database';
import WorkflowPlugin, {
  EXECUTION_STATUS,
  Instruction,
  JOB_STATUS,
  type FlowNodeModel,
  type JobModel,
  type Processor,
} from '@nocobase/plugin-workflow';
import { COLLECTIONS, PLUGIN_NAME, TRANSFER_OPERATIONS } from '../../shared/constants';
import { isConnectionStringOverride, normalizeRemoteSubPath } from '../../shared/fs-guard';
import type {
  RcloneTransferJobState,
  RcloneTransferNodeConfig,
  RcloneTransferOperation,
  RcloneWorkflowJobMeta,
} from '../../shared/types';
import type PluginRcloneManagerServer from '../plugin';
import { RcloneRcError } from '../services/rclone-rc-client';
import { traceWorkflowContinuation, type FlowNodeLike } from './continuation-tracker';

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

function needsJobFlush(job: JobModel | null | undefined): boolean {
  if (!job || typeof (job as { save?: unknown }).save !== 'function') {
    return false;
  }
  if ((job as { isNewRecord?: boolean }).isNewRecord) {
    return true;
  }
  const changedFn = (job as unknown as { changed?: () => boolean | string[] }).changed;
  if (typeof changedFn === 'function') {
    const changedResult = changedFn.call(job);
    return Array.isArray(changedResult) ? changedResult.length > 0 : Boolean(changedResult);
  }
  return false;
}

async function flushProcessorJobsUpfront(processor: Processor, targetJob?: JobModel | null): Promise<boolean> {
  const jobsMap = (processor as unknown as { jobsToSave?: Map<string, JobModel> }).jobsToSave;
  const transaction = (processor as unknown as { transaction?: unknown }).transaction;
  const saveOptions = transaction ? { transaction } : undefined;
  let savedTarget = false;

  if (jobsMap && typeof jobsMap.values === 'function') {
    for (const candidate of jobsMap.values()) {
      if (needsJobFlush(candidate)) {
        await (candidate as unknown as { save: (opts?: Record<string, unknown>) => Promise<unknown> }).save(
          saveOptions,
        );
        if (targetJob && String(candidate.id) === String(targetJob.id)) {
          savedTarget = true;
        }
      }
    }
  }

  if (!savedTarget && needsJobFlush(targetJob)) {
    await (targetJob as unknown as { save: (opts?: Record<string, unknown>) => Promise<unknown> }).save(saveOptions);
    savedTarget = true;
  }

  return savedTarget;
}

const TX_SAFE_INSTRUCTION_TYPES = new Set([
  'create',
  'update',
  'destroy',
  'query',
  'calculation',
  'condition',
  'multi-conditions',
  'end',
  'delay',
  'parallel',
  'loop',
  'output',
]);

const DATA_SOURCE_CRUD_TYPES = new Set(['create', 'update', 'destroy', 'query']);
const MUTATING_DATA_SOURCE_CRUD_TYPES = new Set(['create', 'update', 'destroy']);
const DS_TX_LEDGER_TABLE = '_rclone_wf_tx_ledger';

function extractCollectionDataSourceName(rawCollection: unknown): string {
  if (typeof rawCollection !== 'string' || !rawCollection.trim()) {
    return 'main';
  }
  const colonIdx = rawCollection.indexOf(':');
  return colonIdx > 0 ? rawCollection.slice(0, colonIdx) : 'main';
}

function resolveDataSourceSequelize(app: unknown, dataSourceName: string): SequelizeLike | null {
  const dsMap = (
    app as {
      dataSourceManager?: {
        dataSources?: Map<string, { collectionManager?: { db?: { sequelize?: SequelizeLike } } }>;
      };
    } | null
  )?.dataSourceManager?.dataSources;
  const sequelize = dsMap?.get(dataSourceName)?.collectionManager?.db?.sequelize;
  return typeof sequelize?.transaction === 'function' ? sequelize : null;
}

interface SequelizeTxLike {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  LOCK?: { UPDATE?: unknown };
}

interface SequelizeLike {
  options?: { dialect?: string };
  transaction: (opts?: Record<string, unknown>) => Promise<SequelizeTxLike>;
  query?: (sql: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

interface SecondaryLedgerRecord {
  status: number;
  result: unknown;
}

type LedgerSequelize = SequelizeLike & Required<Pick<SequelizeLike, 'query'>>;

function ledgerSqlError(error: unknown) {
  const wrapped = error as { original?: Error; parent?: Error };
  const cause = (wrapped?.original ?? wrapped?.parent ?? error) as {
    code?: string;
    number?: number;
    message?: string;
  };
  return {
    missing:
      cause?.code === '42P01' ||
      cause?.code === 'ER_NO_SUCH_TABLE' ||
      cause?.number === 208 ||
      (cause?.code === 'SQLITE_ERROR' && /no such table/i.test(cause.message ?? '')),
    configuration:
      [
        '42501',
        '42703',
        'ER_TABLEACCESS_DENIED_ERROR',
        'ER_COLUMNACCESS_DENIED_ERROR',
        'ER_DBACCESS_DENIED_ERROR',
        'ER_BAD_FIELD_ERROR',
        'SQLITE_READONLY',
        'SQLITE_AUTH',
      ].includes(cause?.code ?? '') ||
      [207, 229, 262].includes(cause?.number ?? 0) ||
      (cause?.code === 'SQLITE_ERROR' && /no such column|has no column named/i.test(cause.message ?? '')),
  };
}

async function ensureSecondaryTxLedgerTable(dsSequelize: LedgerSequelize): Promise<void> {
  const dialect = String(dsSequelize.options?.dialect ?? '').toLowerCase();
  const probe = `SELECT step_key, payload, created_at FROM ${DS_TX_LEDGER_TABLE} WHERE 1=0`;
  try {
    await dsSequelize.query(probe, { useMaster: true });
  } catch (error) {
    if (!ledgerSqlError(error).missing) throw error;
    await dsSequelize.query(
      dialect === 'mssql'
        ? `IF OBJECT_ID(N'${DS_TX_LEDGER_TABLE}', N'U') IS NULL CREATE TABLE ${DS_TX_LEDGER_TABLE} (step_key NVARCHAR(255) NOT NULL PRIMARY KEY, payload NVARCHAR(MAX) NOT NULL, created_at BIGINT NOT NULL)`
        : `CREATE TABLE IF NOT EXISTS ${DS_TX_LEDGER_TABLE} (step_key VARCHAR(255) NOT NULL PRIMARY KEY, payload TEXT NOT NULL, created_at BIGINT NOT NULL)`,
    );
    await dsSequelize.query(probe, { useMaster: true });
  }
  // Check INSERT privileges before invoking the business instruction, including on pre-provisioned tables.
  await dsSequelize.query(
    `INSERT INTO ${DS_TX_LEDGER_TABLE} (step_key, payload, created_at) SELECT step_key, payload, created_at FROM ${DS_TX_LEDGER_TABLE} WHERE 1=0`,
  );
}

async function readSecondaryTxLedger(
  dsSequelize: LedgerSequelize,
  secTx: SequelizeTxLike,
  stepKey: string,
): Promise<SecondaryLedgerRecord | null> {
  const rows = await dsSequelize.query(`SELECT payload FROM ${DS_TX_LEDGER_TABLE} WHERE step_key = ?`, {
    replacements: [stepKey],
    transaction: secTx,
    type: 'SELECT',
  });
  if (!Array.isArray(rows)) throw new Error('Unexpected ledger query result');
  if (!rows.length) return null;
  const first = rows[0] as Record<string, unknown> | undefined;
  const rawPayload = first?.payload ?? first?.PAYLOAD;
  const parsed = JSON.parse(typeof rawPayload === 'string' ? rawPayload : '') as SecondaryLedgerRecord;
  if (parsed?.status !== JOB_STATUS.RESOLVED || !Object.prototype.hasOwnProperty.call(parsed, 'result')) {
    throw new SyntaxError('Invalid ledger payload');
  }
  return { status: parsed.status, result: parsed.result ?? null };
}

async function writeSecondaryTxLedger(
  dsSequelize: LedgerSequelize,
  secTx: SequelizeTxLike,
  stepKey: string,
  entry: SecondaryLedgerRecord,
): Promise<void> {
  await dsSequelize.query(`INSERT INTO ${DS_TX_LEDGER_TABLE} (step_key, payload, created_at) VALUES (?, ?, ?)`, {
    replacements: [stepKey, JSON.stringify(entry), Date.now()],
    transaction: secTx,
  });
}

async function deleteSecondaryTxLedgerKeys(dsSequelize: SequelizeLike, stepKeys: string[]): Promise<void> {
  if (typeof dsSequelize.query !== 'function' || stepKeys.length === 0) {
    return;
  }
  for (const key of stepKeys) {
    await dsSequelize
      .query(`DELETE FROM ${DS_TX_LEDGER_TABLE} WHERE step_key = ?`, {
        replacements: [key],
      })
      .catch(() => {});
  }
}

function isRetryableDbLockError(error: unknown): boolean {
  if (!error) return false;
  const errObj = error as {
    message?: string;
    parent?: { code?: string; errno?: number; message?: string };
    original?: { code?: string; errno?: number; message?: string };
  };
  const code = String(errObj.parent?.code ?? errObj.original?.code ?? '');
  const errno = Number(errObj.parent?.errno ?? errObj.original?.errno ?? 0);
  const msg = `${errObj.message ?? ''} ${errObj.parent?.message ?? ''} ${errObj.original?.message ?? ''}`;
  if (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    code === '40001' ||
    code === '40P01' ||
    code === 'ER_LOCK_DEADLOCK' ||
    errno === 5 ||
    errno === 6 ||
    errno === 1205 ||
    errno === 1213
  ) {
    return true;
  }
  return /database is locked|database table is locked|deadlock|could not serialize/i.test(msg);
}

async function runWithDbLockRetry<T>(operation: () => Promise<T>, maxWaitMs = 15_000): Promise<T> {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;

  for (;;) {
    try {
      return await operation();
    } catch (err) {
      attempt += 1;
      if (!isRetryableDbLockError(err) || Date.now() >= deadline) {
        throw err;
      }
      const backoffMs = Math.min(120, 15 + attempt * 10 + Math.floor(Math.random() * 20));
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

async function openSerializedTransaction(sequelize: SequelizeLike, maxWaitMs = 25_000): Promise<SequelizeTxLike> {
  const isSqlite = sequelize.options?.dialect === 'sqlite';
  const txOpts: Record<string, unknown> = isSqlite ? { type: 'IMMEDIATE' } : { isolationLevel: 'READ COMMITTED' };
  return runWithDbLockRetry(() => sequelize.transaction(txOpts), maxWaitMs);
}

function mapJobStatusToExecutionStatus(jobStatus: number, processor: Processor): number {
  const ctorMap = (processor?.constructor as { StatusMap?: Record<number, number> } | undefined)?.StatusMap;
  if (ctorMap && typeof ctorMap[jobStatus] === 'number') {
    return ctorMap[jobStatus];
  }
  if (jobStatus === JOB_STATUS.PENDING) return EXECUTION_STATUS.STARTED;
  return Math.sign(jobStatus);
}

function syncProcessorJobCaches(processor: Processor, orderedJobs: JobModel[], discardQueued = false): void {
  if (processor?.execution) {
    processor.execution.jobs = orderedJobs;
  }
  const procInternal = processor as unknown as {
    nodesMap?: Map<number | string, FlowNodeModel>;
    jobsMapByNodeKey?: Record<string, JobModel>;
    jobResultsMapByNodeKey?: Record<string, unknown>;
    jobsToSave?: Map<string, JobModel>;
  };
  if (discardQueued) {
    procInternal.jobsToSave?.clear();
    procInternal.jobsMapByNodeKey = {};
    procInternal.jobResultsMapByNodeKey = {};
    processor.lastSavedJob = orderedJobs[orderedJobs.length - 1] ?? null;
  }
  if (!procInternal.nodesMap || !procInternal.jobsMapByNodeKey || !procInternal.jobResultsMapByNodeKey) {
    return;
  }
  for (const item of orderedJobs) {
    const targetNode: FlowNodeModel | undefined = procInternal.nodesMap.get(item.nodeId);
    const key = targetNode?.key ?? item.nodeKey;
    if (key) {
      procInternal.jobsMapByNodeKey[key] = item;
      procInternal.jobResultsMapByNodeKey[key] = item.result;
    }
  }
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
          existingStatus === 'running' || existingStatus === 'starting'
            ? `Transfer task #${String(parsedTaskId)} is already ${existingStatus}`
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

    let ownsStartingAttempt = false;
    let runGroup = '';
    let dispatchedToDaemon = false;
    let savedJob: JobModel | null = null;
    let persistedJobUpfront = false;
    let resolvedClient: {
      stopJobGroup?: (group: string) => Promise<void>;
      findJobByGroup?: (group: string) => Promise<unknown>;
      getStatsGroups?: () => Promise<string[] | null>;
    } | null = null;

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
      resolvedClient = client;

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

      // Persist any in-memory upstream jobs (prevJob and earlier sync nodes in this turn) before claiming/dispatching
      // so a crash after claiming or after RC dispatch never strands upstreamId pointing to an unpersisted job row.
      await flushProcessorJobsUpfront(processor, prevJob);

      const claimStartedAt = new Date();
      const taskCollection = this.workflow.app.db.getCollection?.(COLLECTIONS.tasks);
      const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;

      // Pre-allocate a stable workflow job ID at claim time so there is zero crash window where a jobs row exists
      // with one ID while rcloneTransferTasks lacks workflowJobId and causes recovery to mint a second job row.
      const rerunCtx = (processor as unknown as { rerunContext?: { overwrite?: boolean; targetJob?: JobModel | null } })
        ?.rerunContext;
      const rerunOverwriteJob =
        rerunCtx?.overwrite && rerunCtx.targetJob && String(rerunCtx.targetJob.nodeId) === String(node.id)
          ? rerunCtx.targetJob
          : null;
      const snowflake = (this.workflow as unknown as { snowflake?: { getUniqueID?: () => { toString: () => string } } })
        ?.snowflake;
      const preAllocatedWfJobId = rerunOverwriteJob
        ? String(rerunOverwriteJob.id)
        : snowflake?.getUniqueID?.()?.toString() || '';

      const baseWorkflowJobMeta: RcloneWorkflowJobMeta = {
        workflowJobId: preAllocatedWfJobId,
        workflowId: processor.execution.workflowId,
        executionId: processor.execution.id,
        nodeId: node.id,
        nodeKey: node.key,
        upstreamId: prevJob?.id ?? null,
        failOnError,
        connectionId,
        operation: rawOperation,
        srcFs,
        srcRemote,
        dstFs,
        dstRemote,
      };

      let activeTask: Model;
      if (!taskModel) {
        runGroup = `nb-wf-${String(processor.execution.id)}-${String(node.id)}-${crypto.randomUUID()}`;
        activeTask = (await taskRepo.create({
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
            status: 'starting',
            rcloneGroup: runGroup,
            workflowId: processor.execution.workflowId,
            executionId: processor.execution.id,
            workflowJobId: preAllocatedWfJobId || null,
            workflowJobMeta: baseWorkflowJobMeta,
            resumePending: false,
            resumeToken: null,
            resumeConsumedToken: null,
            startedAt: claimStartedAt,
          },
        })) as Model;
        taskModel = activeTask;
        ownsStartingAttempt = true;
      } else {
        activeTask = taskModel;
        const taskId = Number(activeTask.get('id'));
        runGroup = `nb-task-${taskId}-${crypto.randomUUID()}`;
        const claimPatch = {
          status: 'starting',
          rcloneGroup: runGroup,
          workflowId: processor.execution.workflowId,
          executionId: processor.execution.id,
          workflowJobId: preAllocatedWfJobId || null,
          workflowJobMeta: baseWorkflowJobMeta,
          resumePending: false,
          resumeToken: null,
          resumeConsumedToken: null,
          startedAt: claimStartedAt,
          errorText: null,
        };
        if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
          const [claimedCount] = await taskModelUpdate.call(taskCollection.model, claimPatch, {
            where: { id: taskId, status: 'queued' },
          });
          if (claimedCount === 0) {
            const latestTask = await taskRepo.findOne({ filterByTk: taskId }).catch(() => null);
            const latestStatus = String(latestTask?.get('status') ?? 'running');
            const errText =
              latestStatus === 'running' || latestStatus === 'starting'
                ? `Transfer task #${taskId} is already ${latestStatus}`
                : String(latestTask?.get('errorText') || `Transfer task #${taskId} was ${latestStatus}`);
            return {
              status: latestStatus === 'completed' || !failOnError ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED,
              result: {
                taskId,
                success: latestStatus === 'completed',
                error: latestStatus === 'completed' ? '' : errText,
              },
            };
          }
          ownsStartingAttempt = true;
          if (typeof (activeTask as { set?: (vals: Record<string, unknown>) => void }).set === 'function') {
            activeTask.set(claimPatch);
          }
        } else {
          await activeTask.update(claimPatch);
          ownsStartingAttempt = true;
        }
      }

      // Persist workflow job row using the exact pre-allocated ID BEFORE sending the RC command.
      const taskId = Number(activeTask.get('id'));
      const initialJobState: RcloneTransferJobState = {
        taskId,
        connectionId,
        rcloneJobId: 0,
        rcloneGroup: runGroup,
        operation: rawOperation,
        srcFs,
        srcRemote,
        dstFs,
        dstRemote,
        failOnError,
      };

      const jobsDbModel = this.workflow.app?.db?.getModel?.('jobs') as
        | {
            build?: (values: Record<string, unknown>, options?: { isNewRecord?: boolean }) => JobModel;
          }
        | undefined;
      if (!rerunOverwriteJob && preAllocatedWfJobId && typeof jobsDbModel?.build === 'function') {
        const preBuiltJob = jobsDbModel.build(
          {
            id: preAllocatedWfJobId,
            status: JOB_STATUS.PENDING,
            result: initialJobState,
            nodeId: node.id,
            nodeKey: node.key,
            upstreamId: prevJob?.id ?? null,
            startedAt: claimStartedAt,
            createdAt: claimStartedAt,
            updatedAt: claimStartedAt,
            executionId: processor.execution.id,
          },
          { isNewRecord: true },
        );
        savedJob = processor.saveJob(preBuiltJob);
      } else {
        savedJob = processor.saveJob({
          status: JOB_STATUS.PENDING,
          result: initialJobState,
          nodeId: node.id,
          nodeKey: node.key,
          upstreamId: prevJob?.id ?? null,
        });
      }

      const wfJobId = String(savedJob.id);
      const workflowJobMeta: RcloneWorkflowJobMeta = {
        ...baseWorkflowJobMeta,
        workflowJobId: wfJobId,
      };

      persistedJobUpfront = await flushProcessorJobsUpfront(processor, savedJob);

      if (wfJobId !== preAllocatedWfJobId) {
        const preDispatchPatch = {
          workflowJobId: wfJobId,
          workflowJobMeta,
        };
        if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
          const [preUpdatedCount] = await taskModelUpdate.call(taskCollection.model, preDispatchPatch, {
            where: { id: taskId, status: 'starting', rcloneGroup: runGroup },
          });
          if (preUpdatedCount === 0) {
            const latestTask = await taskRepo.findOne({ filterByTk: taskId }).catch(() => null);
            const latestStatus = String(latestTask?.get('status') ?? 'stopped');
            const errText = String(latestTask?.get('errorText') || `Transfer task #${taskId} was ${latestStatus}`);
            savedJob.set({
              status: latestStatus === 'completed' || !failOnError ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED,
              result: {
                ...initialJobState,
                success: latestStatus === 'completed',
                error: latestStatus === 'completed' ? '' : errText,
              },
            });
            return savedJob;
          }
          if (typeof (activeTask as { set?: (vals: Record<string, unknown>) => void }).set === 'function') {
            activeTask.set(preDispatchPatch);
          }
        } else {
          await activeTask.update(preDispatchPatch);
        }
      }

      dispatchedToDaemon = true;
      const { jobid, executeId } = await client.postAsync(`/${rawOperation}`, rcBody, { group: runGroup });

      const jobState: RcloneTransferJobState = {
        ...initialJobState,
        rcloneJobId: jobid,
        ...(executeId ? { rcloneExecuteId: executeId } : {}),
      };
      if (persistedJobUpfront) {
        // Persist the real rcloneJobId and executeId onto the jobs row only while it is still PENDING, then clear
        // the in-memory dirty bit on savedJob so Processor.exit() cannot overwrite a concurrent reconciler update.
        const jobCollection = this.workflow.app.db.getCollection?.('jobs');
        const jobModelUpdate = (jobCollection?.model as { update?: typeof Model.update } | undefined)?.update;
        if (typeof jobModelUpdate === 'function') {
          await jobModelUpdate
            .call(jobCollection.model, { result: jobState }, { where: { id: savedJob.id, status: JOB_STATUS.PENDING } })
            .catch(() => {});
        }
        savedJob.set({ result: jobState });
        const markChanged = (savedJob as unknown as { changed?: (field: string, value: boolean) => void }).changed;
        if (typeof markChanged === 'function') {
          markChanged.call(savedJob, 'result', false);
        }
      } else {
        savedJob.set({ result: jobState });
      }

      const taskPatch = {
        status: 'running',
        rcloneJobId: jobid,
        rcloneExecuteId: executeId ?? null,
        rcloneGroup: runGroup,
        workflowId: processor.execution.workflowId,
        executionId: processor.execution.id,
        workflowJobId: wfJobId,
        workflowJobMeta,
        startedAt: claimStartedAt,
        errorText: null,
      };
      if (typeof taskModelUpdate === 'function' && Number.isFinite(taskId) && taskId > 0) {
        // Include 'running' alongside 'starting' for the same rcloneGroup so a slow postAsync (>5s) that a peer
        // reconciler already promoted to 'running' attaches its job details cleanly instead of stopping the job.
        const [updatedCount] = await taskModelUpdate.call(taskCollection.model, taskPatch, {
          where: { id: taskId, status: ['starting', 'running'], rcloneGroup: runGroup },
        });
        if (updatedCount === 0) {
          const latestTask = await taskRepo.findOne({ filterByTk: taskId }).catch(() => null);
          const latestStatus = String(latestTask?.get('status') ?? 'stopped');
          const latestGroup = String(latestTask?.get('rcloneGroup') ?? '');

          if (latestGroup === runGroup && latestStatus !== 'stopped') {
            // Peer reconciler already settled this exact runGroup while postAsync response was in flight.
            // Never stop the finished/active transfer; ensure workflowJobId is linked and let reconciler resume.
            if (!String(latestTask?.get('workflowJobId') ?? '').trim()) {
              await taskModelUpdate
                .call(
                  taskCollection.model,
                  {
                    rcloneJobId: jobid,
                    rcloneExecuteId: executeId ?? null,
                    workflowJobId: wfJobId,
                    workflowJobMeta,
                    resumePending: true,
                  },
                  { where: { id: taskId, rcloneGroup: runGroup } },
                )
                .catch(() => {});
            }
            this.rclonePlugin.reconciler.kick(50);
            return savedJob;
          }

          if (latestGroup === runGroup) {
            await client.stopJob(jobid, { executeId, group: runGroup }).catch(() => {});
          }
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
        if (typeof (activeTask as { set?: (vals: Record<string, unknown>) => void }).set === 'function') {
          activeTask.set(taskPatch);
        }
      } else {
        await activeTask.update(taskPatch);
      }

      this.rclonePlugin.reconciler.kick(400);
      return savedJob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (ownsStartingAttempt && dispatchedToDaemon && runGroup && savedJob) {
        // Once the RC request has been sent, a network drop/timeout/5xx does NOT prove the daemon rejected it:
        // the transfer may already be running under runGroup. Only fail immediately if a 4xx error is paired
        // with positive verification from the reachable daemon that runGroup is absent; otherwise keep 'starting'
        // so RcloneJobReconciler tracks runGroup to its true outcome.
        const isClient4xx = error instanceof RcloneRcError && error.status >= 400 && error.status < 500;
        let verifiedAbsentOnDaemon = false;
        if (
          isClient4xx &&
          resolvedClient &&
          typeof resolvedClient.findJobByGroup === 'function' &&
          typeof resolvedClient.getStatsGroups === 'function'
        ) {
          try {
            const matched = await resolvedClient.findJobByGroup(runGroup);
            if (!matched) {
              const groups = await resolvedClient.getStatsGroups();
              verifiedAbsentOnDaemon = groups === null || !groups.includes(runGroup);
            }
          } catch {
            verifiedAbsentOnDaemon = false;
          }
        }

        if (!verifiedAbsentOnDaemon) {
          this.rclonePlugin.reconciler.kick(500);
          return savedJob;
        }
      }

      if (taskModel) {
        const failedTaskId = Number(taskModel.get('id'));
        const failedPatch = {
          status: 'failed',
          errorText: message,
          resumePending: false,
          completedAt: new Date(),
        };
        const taskCollection = this.workflow.app.db.getCollection?.(COLLECTIONS.tasks);
        const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
        if (typeof taskModelUpdate === 'function' && Number.isFinite(failedTaskId) && failedTaskId > 0) {
          const whereClause: Record<string, unknown> = ownsStartingAttempt
            ? { id: failedTaskId, status: 'starting', rcloneGroup: runGroup }
            : { id: failedTaskId, status: 'queued' };
          const [updatedFailedCount] = await taskModelUpdate.call(taskCollection.model, failedPatch, {
            where: whereClause,
          });
          if (
            updatedFailedCount > 0 &&
            typeof (taskModel as { set?: (vals: Record<string, unknown>) => void }).set === 'function'
          ) {
            taskModel.set(failedPatch);
          }
        } else if (ownsStartingAttempt || String(taskModel.get('status') ?? '') === 'queued') {
          await taskModel.update(failedPatch);
        }
      }

      if (savedJob) {
        const prevResult = (savedJob.result && typeof savedJob.result === 'object' ? savedJob.result : {}) as Record<
          string,
          unknown
        >;
        savedJob.set({
          status: failOnError ? JOB_STATUS.FAILED : JOB_STATUS.RESOLVED,
          result: {
            ...prevResult,
            taskId: taskModel ? Number(taskModel.get('id')) : 0,
            success: false,
            error: message,
          },
        });
        return savedJob;
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

  async resume(node: FlowNodeModel, job: JobModel, processor: Processor) {
    if (processor?.execution?.status != null && processor.execution.status !== EXECUTION_STATUS.STARTED) {
      return undefined as unknown as JobModel;
    }

    const jobResult = (
      job?.result && typeof job.result === 'object' ? job.result : {}
    ) as Partial<RcloneTransferJobState>;
    const taskId = Number(jobResult.taskId);
    let effectiveJobToken = String(jobResult.resumeToken || `wfjob:${String(job?.id ?? '')}`).trim();
    const jobMeta = (job?.meta && typeof job.meta === 'object' ? job.meta : {}) as Record<string, unknown>;

    const db = this.workflow?.app?.db;
    const clearTaskPendingFlag = async (transaction?: unknown) => {
      if (db && Number.isFinite(taskId) && taskId > 0 && db.getCollection?.(COLLECTIONS.tasks)) {
        const taskCollection = db.getCollection(COLLECTIONS.tasks);
        const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
        if (typeof taskModelUpdate === 'function') {
          await taskModelUpdate
            .call(
              taskCollection.model,
              { resumePending: false, ...(effectiveJobToken ? { resumeConsumedToken: effectiveJobToken } : {}) },
              {
                where: { id: taskId },
                ...(transaction ? { transaction: transaction as never } : {}),
              },
            )
            .catch(() => {});
        }
      }
    };

    const executionId = processor?.execution?.id ?? (job as unknown as { executionId?: number | string })?.executionId;
    const sequelize = (db as unknown as { sequelize?: SequelizeLike } | undefined)?.sequelize;
    const canDriveTransactionally =
      !processor?.transaction &&
      executionId != null &&
      typeof sequelize?.transaction === 'function' &&
      typeof db?.getModel === 'function' &&
      (typeof processor?.run === 'function' || typeof processor?.end === 'function');

    if (canDriveTransactionally && sequelize) {
      const ExecutionDBModel = db.getModel('executions') as unknown as {
        findByPk: (id: number | string, opts?: Record<string, unknown>) => Promise<Model | null>;
        update?: (values: Record<string, unknown>, opts: Record<string, unknown>) => Promise<[number]>;
      };
      const JobsDBModel = db.getModel('jobs') as unknown as {
        findAll: (opts: Record<string, unknown>) => Promise<JobModel[]>;
        bulkCreate?: (rows: Record<string, unknown>[], opts?: Record<string, unknown>) => Promise<unknown>;
      };

      if (typeof ExecutionDBModel?.findByPk === 'function' && typeof JobsDBModel?.findAll === 'function') {
        const isSqlite = sequelize.options?.dialect === 'sqlite';
        const delayInstr = this.workflow?.instructions?.get?.('delay') as
          | { timers?: Map<string, NodeJS.Timeout> }
          | undefined;
        const createdJobIdsInTurn = new Set<string>();
        const secondaryTxs = new Map<string, { sequelize: LedgerSequelize; transaction: SequelizeTxLike }>();
        const dsStepOrdinals = new Map<string, number>();
        const pendingLedgerSlots: Array<{
          dsName: string;
          stepKey: string;
          nodeId: string;
          captured: SecondaryLedgerRecord | null;
        }> = [];
        const committedStepKeysToCleanup: Array<{ sequelize: SequelizeLike; stepKey: string }> = [];

        let activeTx: SequelizeTxLike | null = null;
        const origRun = processor.run?.bind(processor);
        const origExit = processor.exit?.bind(processor);
        const origSaveJob = processor.saveJob?.bind(processor);
        const origGetScopeTransaction = (
          processor as unknown as {
            getScopeTransaction?: (targetNode: FlowNodeModel, dsName?: string) => unknown;
          }
        ).getScopeTransaction?.bind(processor);
        const execTarget = processor.execution as unknown as
          | { update?: (vals: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown> }
          | undefined;
        const origExecUpdate = typeof execTarget?.update === 'function' ? execTarget.update.bind(execTarget) : null;
        let finalExecStatusApplied = false;
        let freshSelfJobRef: JobModel = job;
        let freshMetaRef: Record<string, unknown> = jobMeta;

        const armDurableRetryInTx = async (tx: SequelizeTxLike) => {
          const nextRetryToken = `rtok-${String(freshSelfJobRef?.id ?? job?.id ?? taskId)}-${crypto.randomUUID()}`;
          if (db && Number.isFinite(taskId) && taskId > 0 && db.getCollection?.(COLLECTIONS.tasks)) {
            const taskCollection = db.getCollection(COLLECTIONS.tasks);
            const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
            if (typeof taskModelUpdate === 'function') {
              const [updated] = await taskModelUpdate.call(
                taskCollection.model,
                { resumePending: true, resumeToken: nextRetryToken, resumeConsumedToken: null },
                { where: { id: taskId }, transaction: tx as never },
              );
              if (updated > 0) {
                return;
              }
            }
          }
          if (typeof freshSelfJobRef?.set === 'function') {
            const armedMeta: Record<string, unknown> = {
              ...freshMetaRef,
              orphanResumePending: true,
              orphanDispatchToken: nextRetryToken,
            };
            delete armedMeta.consumedResumeToken;
            freshSelfJobRef.set({ meta: armedMeta });
            await (freshSelfJobRef as unknown as { save: (opts?: Record<string, unknown>) => Promise<unknown> }).save({
              transaction: tx,
            });
          }
        };

        const rearmDurableRetryOutsideTx = async () => {
          const nextRetryToken = `rtok-${String(freshSelfJobRef?.id ?? job?.id ?? taskId)}-${crypto.randomUUID()}`;
          if (db && Number.isFinite(taskId) && taskId > 0 && db.getCollection?.(COLLECTIONS.tasks)) {
            const taskCollection = db.getCollection(COLLECTIONS.tasks);
            const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
            if (typeof taskModelUpdate === 'function') {
              const [updated] = await runWithDbLockRetry<[number]>(() =>
                taskModelUpdate.call(
                  taskCollection.model,
                  { resumePending: true, resumeToken: nextRetryToken, resumeConsumedToken: null },
                  { where: { id: taskId } },
                ),
              ).catch(() => [0]);
              if (updated > 0) {
                return;
              }
            }
          }
          if (db?.getCollection?.('jobs') && freshSelfJobRef?.id != null) {
            const jobCollection = db.getCollection('jobs');
            const jobModelUpdate = (jobCollection?.model as { update?: typeof Model.update } | undefined)?.update;
            const armedMeta: Record<string, unknown> = {
              ...freshMetaRef,
              orphanResumePending: true,
              orphanDispatchToken: nextRetryToken,
            };
            delete armedMeta.consumedResumeToken;
            if (typeof jobModelUpdate === 'function') {
              await runWithDbLockRetry(() =>
                jobModelUpdate.call(jobCollection.model, { meta: armedMeta }, { where: { id: freshSelfJobRef.id } }),
              ).catch(() => {});
            } else if (typeof freshSelfJobRef.save === 'function') {
              freshSelfJobRef.set?.({ meta: armedMeta });
              await runWithDbLockRetry(() => freshSelfJobRef.save()).catch(() => {});
            }
          }
        };

        const flushJobsInActiveTx = async (tx: SequelizeTxLike) => {
          const jobsMap = (processor as unknown as { jobsToSave?: Map<string, JobModel> }).jobsToSave;
          if (!jobsMap || jobsMap.size === 0) {
            return;
          }
          const newBatch: JobModel[] = [];
          for (const candidate of jobsMap.values()) {
            if ((candidate as { isNewRecord?: boolean }).isNewRecord) {
              newBatch.push(candidate);
            } else if (needsJobFlush(candidate)) {
              await (candidate as unknown as { save: (opts?: Record<string, unknown>) => Promise<unknown> }).save({
                transaction: tx,
              });
            }
          }
          if (newBatch.length > 0) {
            if (typeof JobsDBModel.bulkCreate === 'function') {
              await JobsDBModel.bulkCreate(
                newBatch.map((item) =>
                  typeof (item as { toJSON?: () => Record<string, unknown> }).toJSON === 'function'
                    ? item.toJSON()
                    : (item as unknown as Record<string, unknown>),
                ),
                { returning: false, transaction: tx },
              );
              for (const item of newBatch) {
                (item as { isNewRecord: boolean }).isNewRecord = false;
              }
            } else {
              for (const item of newBatch) {
                await (item as unknown as { save: (opts?: Record<string, unknown>) => Promise<unknown> }).save({
                  transaction: tx,
                });
              }
            }
          }
          jobsMap.clear();
        };

        const applyExecutionStatusInTx = async (jobStatus: number, tx: SequelizeTxLike) => {
          const nextExecStatus = mapJobStatusToExecutionStatus(jobStatus, processor);
          if (nextExecStatus === EXECUTION_STATUS.STARTED || typeof ExecutionDBModel.update !== 'function') {
            return;
          }
          const values: { status: number; reason?: string } = { status: nextExecStatus };
          const abortReason = (processor as unknown as { abortReason?: string | null }).abortReason;
          if (nextExecStatus === EXECUTION_STATUS.ABORTED && abortReason) {
            values.reason = abortReason;
          }
          const [affected] = await ExecutionDBModel.update(values, {
            where: { id: executionId, status: EXECUTION_STATUS.STARTED },
            individualHooks: true,
            transaction: tx as never,
          });
          if (affected > 0 && typeof processor.execution?.set === 'function') {
            processor.execution.set(values);
          }
          finalExecStatusApplied = true;
        };

        const commitSecondaryTransactions = async () => {
          for (const [dsName, { sequelize: dsSequelize, transaction: secTx }] of secondaryTxs) {
            for (const slot of pendingLedgerSlots) {
              if (slot.dsName === dsName && slot.captured && slot.captured.status === JOB_STATUS.RESOLVED) {
                await writeSecondaryTxLedger(dsSequelize, secTx, slot.stepKey, slot.captured);
                committedStepKeysToCleanup.push({ sequelize: dsSequelize, stepKey: slot.stepKey });
              }
            }
            await secTx.commit();
          }
          pendingLedgerSlots.length = 0;
          secondaryTxs.clear();
        };

        const cleanupCommittedSecondaryLedger = async () => {
          if (committedStepKeysToCleanup.length === 0) {
            return;
          }
          const bySequelize = new Map<SequelizeLike, string[]>();
          for (const entry of committedStepKeysToCleanup) {
            const list = bySequelize.get(entry.sequelize) ?? [];
            list.push(entry.stepKey);
            bySequelize.set(entry.sequelize, list);
          }
          committedStepKeysToCleanup.length = 0;
          for (const [dsSeq, keys] of bySequelize.entries()) {
            await deleteSecondaryTxLedgerKeys(dsSeq, keys);
          }
        };

        const lockExecution = (tx: SequelizeTxLike) =>
          ExecutionDBModel.findByPk(executionId, {
            transaction: tx,
            ...(!isSqlite && tx.LOCK?.UPDATE ? { lock: tx.LOCK.UPDATE } : {}),
          });
        const readJobs = (tx: SequelizeTxLike) =>
          JobsDBModel.findAll({ where: { executionId }, order: [['id', 'ASC']], transaction: tx });

        try {
          activeTx = await openSerializedTransaction(sequelize);
          const execRow = await lockExecution(activeTx);
          const liveExecStatus = Number(
            execRow?.get?.('status') ?? (execRow as unknown as { status?: number } | null)?.status,
          );
          if (!execRow || liveExecStatus !== EXECUTION_STATUS.STARTED) {
            await clearTaskPendingFlag(activeTx);
            await activeTx.commit();
            activeTx = null;
            if (typeof processor.execution?.set === 'function' && Number.isFinite(liveExecStatus)) {
              processor.execution.set({ status: liveExecStatus });
            }
            return undefined as unknown as JobModel;
          }

          const freshJobs = await readJobs(activeTx);
          syncProcessorJobCaches(processor, freshJobs);

          const freshSelfJob = freshJobs.find((item) => String(item.id) === String(job?.id)) ?? job;
          const freshSelfResult = (
            freshSelfJob?.result && typeof freshSelfJob.result === 'object' ? freshSelfJob.result : {}
          ) as Partial<RcloneTransferJobState>;
          if (freshSelfResult.resumeToken) {
            effectiveJobToken = String(freshSelfResult.resumeToken).trim();
          }
          const freshMeta = (
            freshSelfJob?.meta && typeof freshSelfJob.meta === 'object' ? freshSelfJob.meta : {}
          ) as Record<string, unknown>;
          freshSelfJobRef = freshSelfJob;
          freshMetaRef = freshMeta;
          const consumedMatches = Boolean(
            effectiveJobToken && String(freshMeta.consumedResumeToken ?? '') === effectiveJobToken,
          );
          const explicitNodes =
            Array.isArray(processor.nodes) && processor.nodes.length > 0
              ? (processor.nodes as unknown as FlowNodeLike[])
              : null;
          const hasParallelNode = Boolean(explicitNodes?.some((n) => n.type === 'parallel'));

          const trace = traceWorkflowContinuation(node, freshSelfJob, freshJobs, explicitNodes, consumedMatches);

          if (trace.kind === 'parked') {
            if (freshMeta.orphanResumePending === true && typeof freshSelfJob?.set === 'function') {
              freshSelfJob.set({ meta: { ...freshMeta, orphanResumePending: false } });
              await (freshSelfJob as unknown as { save: (opts?: Record<string, unknown>) => Promise<unknown> }).save({
                transaction: activeTx,
              });
            }
            await clearTaskPendingFlag(activeTx);
            await activeTx.commit();
            activeTx = null;
            return undefined as unknown as JobModel;
          }

          if (trace.kind === 'needs_exit') {
            if (freshMeta.orphanResumePending === true && typeof freshSelfJob?.set === 'function') {
              freshSelfJob.set({ meta: { ...freshMeta, orphanResumePending: false } });
              await (freshSelfJob as unknown as { save: (opts?: Record<string, unknown>) => Promise<unknown> }).save({
                transaction: activeTx,
              });
            }
            await applyExecutionStatusInTx(trace.status, activeTx);
            await clearTaskPendingFlag(activeTx);
            await activeTx.commit();
            activeTx = null;
            if (origExit) {
              await origExit(true);
            }
            const timeoutMgr = (
              this.workflow as unknown as {
                timeoutManager?: { clear?: (id: number | string) => void };
              }
            )?.timeoutManager;
            if (processor.execution?.status !== EXECUTION_STATUS.STARTED) {
              timeoutMgr?.clear?.(executionId);
            }
            return undefined as unknown as JobModel;
          }

          let segmentAnchorId = String(trace.tailJob?.id ?? freshSelfJob?.id ?? '');

          if (typeof freshSelfJob?.set === 'function') {
            freshSelfJob.set({
              meta: { ...freshMeta, consumedResumeToken: effectiveJobToken, orphanResumePending: false },
            });
            const jobsMap = (processor as unknown as { jobsToSave?: Map<string, JobModel> }).jobsToSave;
            jobsMap?.set(String(freshSelfJob.id), freshSelfJob);
          }

          let recordedExitArg: number | true | undefined;
          let hasRecordedExit = false;

          processor.transaction = activeTx as never;

          if (origExecUpdate && execTarget) {
            execTarget.update = (vals: Record<string, unknown>, opts?: Record<string, unknown>) => {
              if (activeTx && (!opts || opts.transaction == null)) {
                return origExecUpdate(vals, { ...(opts ?? {}), transaction: activeTx });
              }
              return origExecUpdate(vals, opts);
            };
          }

          if (origSaveJob) {
            processor.saveJob = ((payload: JobModel | Record<string, unknown>) => {
              const saved = origSaveJob(payload as never);
              if (saved?.id != null && (saved as { isNewRecord?: boolean }).isNewRecord) {
                createdJobIdsInTurn.add(String(saved.id));
              }
              if (saved?.nodeId != null && pendingLedgerSlots.length > 0) {
                const slot = pendingLedgerSlots.find((s) => s.captured === null && s.nodeId === String(saved.nodeId));
                if (slot) {
                  slot.captured = {
                    status: Number(saved.status),
                    result: saved.result ?? null,
                  };
                }
              }
              return saved;
            }) as typeof processor.saveJob;
          }

          (
            processor as unknown as {
              getScopeTransaction: (targetNode: FlowNodeModel, dsName?: string) => unknown;
            }
          ).getScopeTransaction = (targetNode: FlowNodeModel, dsName?: string) => {
            const scoped = origGetScopeTransaction ? origGetScopeTransaction(targetNode, dsName) : null;
            if (scoped) {
              return scoped;
            }
            if (activeTx && dsName && dsName !== 'main' && secondaryTxs.has(dsName)) {
              return secondaryTxs.get(dsName)?.transaction;
            }
            return null;
          };

          if (origExit) {
            processor.exit = (async (s?: number | true) => {
              if (!activeTx) {
                return origExit(s);
              }
              if (s === true) {
                return origExit(true);
              }
              hasRecordedExit = true;
              recordedExitArg = s;
              return null;
            }) as typeof processor.exit;
          }

          let handoffTailId = segmentAnchorId;
          const commitHandoffBeforeExternalNode = async (input?: JobModel | { result: unknown }) => {
            if (!activeTx) {
              return;
            }
            // Persist preceding synchronous jobs and keep resumePending=true BEFORE handing off to an external or
            // non-transactional instruction (e.g. a second Rclone node) so a restart before that node creates its
            // own persisted job row still recovers it without re-running completed Create steps.
            await flushJobsInActiveTx(activeTx);
            if (input && 'id' in input) handoffTailId = String(input.id);
            await armDurableRetryInTx(activeTx);
            await commitSecondaryTransactions();
            const committing = activeTx;
            activeTx = null;
            processor.transaction = null;
            await committing.commit();
            await cleanupCommittedSecondaryLedger();
          };

          if (origRun) {
            processor.run = (async (
              nextNode: FlowNodeModel,
              input?: JobModel | { result: unknown },
              opts?: unknown,
            ) => {
              const nextType = String(nextNode?.type ?? '');
              if (!activeTx && TX_SAFE_INSTRUCTION_TYPES.has(nextType) && !hasParallelNode) {
                activeTx = await openSerializedTransaction(sequelize);
                processor.transaction = activeTx as never;
                const currentExecution = await lockExecution(activeTx);
                const status = currentExecution?.get?.('status') ?? currentExecution?.status;
                const persisted = await readJobs(activeTx);
                if (!currentExecution || Number(status) !== EXECUTION_STATUS.STARTED) {
                  syncProcessorJobCaches(processor, persisted, true);
                  if (currentExecution) processor.execution.set?.({ status: Number(status) });
                  return;
                }
                const anchor = persisted.find((row) => String(row.id) === String(freshSelfJob.id));
                if (!anchor) throw new Error('Rclone resume anchor disappeared during handoff');
                // Rclone may persist its own PENDING job before contacting RC, then resolve it in memory
                // (e.g. failOnError=false). Preserve that transition only for the same still-pending row.
                const localInput = input && 'id' in input && createdJobIdsInTurn.has(String(input.id)) ? input : null;
                const progressJobs =
                  localInput?.status === JOB_STATUS.RESOLVED
                    ? persisted.map((row) =>
                        String(row.id) === String(localInput.id) && row.status === JOB_STATUS.PENDING
                          ? localInput
                          : row,
                      )
                    : persisted;
                const progress = traceWorkflowContinuation(node, anchor, progressJobs, explicitNodes, true);
                dsStepOrdinals.clear();
                if (
                  progress.kind !== 'resume_from_tail' ||
                  (String(progress.tailJob.id) !== handoffTailId &&
                    !createdJobIdsInTurn.has(String(progress.tailJob.id)))
                ) {
                  // A different worker advanced this path while the execution lock was released.
                  syncProcessorJobCaches(processor, persisted, true);
                  if (progress.kind === 'parked') return;
                  if (progress.kind === 'needs_exit') return processor.exit(progress.status);
                  segmentAnchorId = String(progress.tailJob.id);
                  return continueFromTail(progress);
                }
                if (input && typeof input === 'object' && 'id' in input && (input as { id?: unknown }).id != null) {
                  segmentAnchorId = String((input as { id: number | string }).id);
                }
              }

              if (activeTx) {
                if (!TX_SAFE_INSTRUCTION_TYPES.has(nextType)) {
                  await commitHandoffBeforeExternalNode(input);
                } else if (DATA_SOURCE_CRUD_TYPES.has(nextType)) {
                  const dsName = extractCollectionDataSourceName(
                    (nextNode?.config as { collection?: unknown } | undefined)?.collection,
                  );
                  if (dsName !== 'main') {
                    const failLedger = () => {
                      const message = this.rclonePlugin.t(
                        'Cannot use workflow ledger {{table}} on data source {{source}}. Check its schema and permissions.',
                        {
                          table: DS_TX_LEDGER_TABLE,
                          source: dsName,
                        },
                      );
                      return processor.end(
                        nextNode,
                        processor.saveJob({
                          nodeId: nextNode.id,
                          nodeKey: nextNode.key,
                          status: JOB_STATUS.ERROR,
                          upstreamId: input && 'id' in input ? input.id : null,
                          result: { message },
                        }),
                      );
                    };
                    if (!secondaryTxs.has(dsName)) {
                      const dsSequelize = resolveDataSourceSequelize(this.workflow?.app, dsName);
                      if (!dsSequelize) {
                        await commitHandoffBeforeExternalNode(input);
                      } else if (MUTATING_DATA_SOURCE_CRUD_TYPES.has(nextType)) {
                        if (!dsSequelize.query) return failLedger();
                        const ledgerDb = dsSequelize as LedgerSequelize;
                        try {
                          await ensureSecondaryTxLedgerTable(ledgerDb);
                        } catch (error) {
                          if (!ledgerSqlError(error).configuration) throw error;
                          return failLedger();
                        }
                        const secTx = await openSerializedTransaction(dsSequelize);
                        secondaryTxs.set(dsName, { sequelize: ledgerDb, transaction: secTx });
                      }
                    }

                    const secondary = secondaryTxs.get(dsName);
                    if (activeTx && secondary && MUTATING_DATA_SOURCE_CRUD_TYPES.has(nextType)) {
                      const { sequelize: ledgerDb, transaction: secTx } = secondary;
                      const stepOrdinal = (dsStepOrdinals.get(dsName) ?? 0) + 1;
                      dsStepOrdinals.set(dsName, stepOrdinal);
                      const stepKey = `${String(executionId)}:${String(
                        freshSelfJob?.id ?? '',
                      )}:${segmentAnchorId}:${dsName}:${String(nextNode.id)}:${stepOrdinal}`;
                      let priorCommitted: SecondaryLedgerRecord | null;
                      try {
                        priorCommitted = await readSecondaryTxLedger(ledgerDb, secTx, stepKey);
                      } catch (error) {
                        if (!(error instanceof SyntaxError)) throw error;
                        return failLedger();
                      }
                      if (priorCommitted) {
                        committedStepKeysToCleanup.push({ sequelize: ledgerDb, stepKey });
                        const prevJobId =
                          input && typeof input === 'object' && 'id' in input
                            ? (input as { id?: number | string | null }).id ?? null
                            : null;
                        const replayedJob = processor.saveJob({
                          status: priorCommitted.status,
                          result: priorCommitted.result,
                          nodeId: nextNode.id,
                          nodeKey: nextNode.key,
                          upstreamId: prevJobId,
                        });
                        if (processor.execution?.status === EXECUTION_STATUS.ABORTED) {
                          return processor.exit(JOB_STATUS.ABORTED);
                        }
                        if (replayedJob.status === JOB_STATUS.RESOLVED && nextNode.downstream) {
                          return processor.run(nextNode.downstream, replayedJob);
                        }
                        return processor.end(nextNode, replayedJob);
                      }
                      pendingLedgerSlots.push({
                        dsName,
                        stepKey,
                        nodeId: String(nextNode.id),
                        captured: null,
                      });
                    }
                  }
                }
              }
              return origRun(nextNode, input, opts as never);
            }) as typeof processor.run;
          }

          const continueFromTail = async (tail: typeof trace & { kind: 'resume_from_tail' }) => {
            const resolvedTailNode =
              (tail.tailNode ? processor.nodesMap?.get(tail.tailNode.id) : undefined) ??
              (tail.tailNode as FlowNodeModel | undefined) ??
              node;

            if (resolvedTailNode?.type === 'end' && typeof processor.exit === 'function') {
              return processor.exit(tail.tailJob.status);
            } else if (
              tail.tailJob.status === JOB_STATUS.RESOLVED &&
              resolvedTailNode?.downstream &&
              typeof processor.run === 'function'
            ) {
              return processor.run(resolvedTailNode.downstream, tail.tailJob);
            } else if (typeof processor.end === 'function') {
              return processor.end(resolvedTailNode, tail.tailJob);
            }
          };
          await continueFromTail(trace);

          if (activeTx) {
            await flushJobsInActiveTx(activeTx);
            await clearTaskPendingFlag(activeTx);
            if (hasRecordedExit && typeof recordedExitArg === 'number') {
              await applyExecutionStatusInTx(recordedExitArg, activeTx);
            }
            await commitSecondaryTransactions();
            const committing = activeTx;
            activeTx = null;
            processor.transaction = null;
            await committing.commit();
            await cleanupCommittedSecondaryLedger();
          } else {
            // Handoff committed mid-chain before an external node; verify in DB that either the execution closed
            // or the continuation parked at a persisted PENDING job (e.g. Rclone2) before clearing resumePending.
            const postExec = await ExecutionDBModel.findByPk(executionId).catch(() => null);
            const postExecStatus = Number(
              postExec?.get?.('status') ?? (postExec as unknown as { status?: number } | null)?.status,
            );
            let handoffDurablySettled = !postExec || postExecStatus !== EXECUTION_STATUS.STARTED;
            if (!handoffDurablySettled) {
              const postJobs = await JobsDBModel.findAll({
                where: { executionId },
                order: [['id', 'ASC']],
              }).catch(() => null);
              if (Array.isArray(postJobs)) {
                const postTrace = traceWorkflowContinuation(node, freshSelfJob, postJobs, explicitNodes, true);
                handoffDurablySettled = postTrace.kind === 'parked';
              }
            }
            if (handoffDurablySettled) {
              await clearTaskPendingFlag();
              if (freshMeta.orphanResumePending === true && db?.getCollection?.('jobs') && freshSelfJob?.id != null) {
                const jobCollection = db.getCollection('jobs');
                const jobModelUpdate = (jobCollection?.model as { update?: typeof Model.update } | undefined)?.update;
                if (typeof jobModelUpdate === 'function') {
                  await jobModelUpdate
                    .call(
                      jobCollection.model,
                      { meta: { ...freshMeta, consumedResumeToken: effectiveJobToken, orphanResumePending: false } },
                      { where: { id: freshSelfJob.id } },
                    )
                    .catch(() => {});
                }
              }
            }
          }

          if (origExit) {
            await origExit(true);
          }
          const timeoutMgr = (
            this.workflow as unknown as {
              timeoutManager?: {
                clear?: (id: number | string) => void;
                scheduleExecutionTimeout?: (exec: unknown) => void;
              };
            }
          )?.timeoutManager;
          if (processor.execution?.status === EXECUTION_STATUS.STARTED) {
            timeoutMgr?.scheduleExecutionTimeout?.(processor.execution);
          } else if (finalExecStatusApplied) {
            timeoutMgr?.clear?.(executionId);
          }

          return undefined as unknown as JobModel;
        } catch (txError) {
          pendingLedgerSlots.length = 0;
          committedStepKeysToCleanup.length = 0;
          if (delayInstr?.timers && createdJobIdsInTurn.size > 0) {
            for (const jobKey of createdJobIdsInTurn) {
              const handle = delayInstr.timers.get(jobKey);
              if (handle) {
                clearTimeout(handle);
                delayInstr.timers.delete(jobKey);
              }
            }
          }
          if (secondaryTxs.size > 0) {
            for (const { transaction } of secondaryTxs.values()) {
              await transaction.rollback().catch(() => {});
            }
            secondaryTxs.clear();
          }
          if (activeTx) {
            const jobsMap = (processor as unknown as { jobsToSave?: Map<string, JobModel> }).jobsToSave;
            jobsMap?.clear();
            const rollingBack = activeTx;
            activeTx = null;
            processor.transaction = null;
            await rollingBack.rollback().catch(() => {});
          }
          await rearmDurableRetryOutsideTx();
          this.workflow?.app?.logger?.warn?.(
            `[plugin-rclone-manager] Transactional workflow resume rolled back for execution #${String(
              executionId,
            )}; re-armed durable retry: ${String(txError)}`,
          );
          try {
            const wfJobKey = String(freshSelfJobRef?.id ?? job?.id ?? '');
            this.rclonePlugin.reconciler.clearDispatchThrottle(wfJobKey);
            this.rclonePlugin.reconciler.kick(200);
          } catch {
            // Reconciler may not be registered in isolated unit tests
          }
          return undefined as unknown as JobModel;
        } finally {
          processor.transaction = null;
          if (origExecUpdate && execTarget) {
            execTarget.update = origExecUpdate;
          }
          if (origRun) {
            processor.run = origRun;
          }
          if (origExit) {
            processor.exit = origExit;
          }
          if (origSaveJob) {
            processor.saveJob = origSaveJob;
          }
          if (origGetScopeTransaction) {
            (
              processor as unknown as {
                getScopeTransaction: (targetNode: FlowNodeModel, dsName?: string) => unknown;
              }
            ).getScopeTransaction = origGetScopeTransaction;
          }
        }
      }
    }

    let execJobs: JobModel[] | null = Array.isArray(processor?.execution?.jobs)
      ? (processor.execution.jobs as JobModel[])
      : null;

    if (!execJobs && db?.getCollection?.('jobs') && executionId != null) {
      const jobsRepo = db.getRepository?.('jobs') as
        | { find?: (opts: { filter: Record<string, unknown> }) => Promise<JobModel[]> }
        | undefined;
      if (typeof jobsRepo?.find === 'function') {
        execJobs = await jobsRepo.find({ filter: { executionId } }).catch(() => null);
      }
    }

    if (!execJobs && db?.getCollection?.('jobs') && executionId != null && job?.id != null) {
      const jobsRepo = db.getRepository?.('jobs') as
        | { count?: (opts: { filter: Record<string, unknown> }) => Promise<number> }
        | undefined;
      if (typeof jobsRepo?.count === 'function') {
        const byUpstream = await jobsRepo.count({ filter: { executionId, upstreamId: job.id } }).catch(() => 0);
        if (byUpstream > 0) {
          await clearTaskPendingFlag();
          return undefined as unknown as JobModel;
        }
      }
    }

    const explicitNodes =
      Array.isArray(processor?.nodes) && processor.nodes.length > 0
        ? (processor.nodes as unknown as FlowNodeLike[])
        : processor?.nodesMap && processor.nodesMap.size > 0
          ? ([...processor.nodesMap.values()] as unknown as FlowNodeLike[])
          : null;
    const consumedMatches = Boolean(
      effectiveJobToken && String(jobMeta.consumedResumeToken ?? '') === effectiveJobToken,
    );

    if (execJobs && job) {
      const trace = traceWorkflowContinuation(node, job, execJobs, explicitNodes, consumedMatches);
      if (trace.kind === 'parked') {
        await clearTaskPendingFlag();
        return undefined as unknown as JobModel;
      }
      if (trace.kind === 'needs_exit') {
        if (processor?.execution?.status === EXECUTION_STATUS.STARTED && typeof processor.exit === 'function') {
          await processor.exit(trace.status);
        }
        await clearTaskPendingFlag();
        return undefined as unknown as JobModel;
      }
      if (String(trace.tailJob.id) !== String(job.id)) {
        const resolvedTailNode =
          (trace.tailNode ? processor?.nodesMap?.get(trace.tailNode.id) : undefined) ??
          (trace.tailNode as FlowNodeModel | undefined) ??
          node;
        if (resolvedTailNode?.type === 'end' && typeof processor?.exit === 'function') {
          await processor.exit(trace.tailJob.status);
        } else if (
          trace.tailJob.status === JOB_STATUS.RESOLVED &&
          resolvedTailNode?.downstream &&
          typeof processor?.run === 'function'
        ) {
          await processor.run(resolvedTailNode.downstream, trace.tailJob);
        } else if (typeof processor?.end === 'function') {
          await processor.end(resolvedTailNode, trace.tailJob);
        }
        await clearTaskPendingFlag();
        return undefined as unknown as JobModel;
      }
    } else if (consumedMatches) {
      const downstreamNodeId =
        node?.downstream?.id ??
        (node as unknown as { downstreamId?: number | string | null } | undefined)?.downstreamId ??
        null;
      const expectsDownstreamRun = job?.status === JOB_STATUS.RESOLVED && downstreamNodeId != null;
      if (!expectsDownstreamRun) {
        if (processor?.execution?.status === EXECUTION_STATUS.STARTED) {
          const findParent = (
            processor as unknown as { findBranchParentNode?: (n: FlowNodeModel) => FlowNodeModel | null }
          )?.findBranchParentNode;
          const parentNode = typeof findParent === 'function' ? findParent.call(processor, node) : null;
          if (!parentNode && typeof processor.exit === 'function') {
            await processor.exit(job.status);
          } else if (parentNode && typeof processor.end === 'function') {
            await processor.end(node, job);
          }
        }
        await clearTaskPendingFlag();
        return undefined as unknown as JobModel;
      }
    }

    if (typeof job?.set === 'function') {
      job.set({ meta: { ...jobMeta, consumedResumeToken: effectiveJobToken, orphanResumePending: false } });
    }
    return job;
  }
}

export default RcloneTransferInstruction;
