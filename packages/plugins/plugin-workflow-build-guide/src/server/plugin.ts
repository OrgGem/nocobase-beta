/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import {
  abortExecution,
  EXECUTION_REASON,
  EXECUTION_STATUS,
  getExecutionLockKey,
  JOB_STATUS,
} from '@nocobase/plugin-workflow';
import { Plugin } from '@nocobase/server';
import { randomUUID } from 'node:crypto';
import { json, Op, where, type WhereLeftOperand } from 'sequelize';
import { guardManagedWorkflowActions } from './guards';
import { GuideLlmInstruction, GuidePrepareInstruction, GuidePublishInstruction } from './instructions';
import { assertSafeWorkflow, setupWorkflow } from './provision';
import { WORKFLOW_KEY, WORKFLOW_MARKER } from './templates';

type ID = string | number;
type WorkflowRevision = { id: ID; key: string; enabled: boolean };
type ExecutionRecord = { id: ID; status: number | null; get: (field: string) => unknown };
type RunRecord = { id: ID; get: (field: string) => unknown; toJSON: () => unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readModelValue(model: unknown, key: string): unknown {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as { get?: (field: string) => unknown } & Record<string, unknown>;
  return typeof record.get === 'function' ? record.get(key) : record[key];
}

function requireRoot(ctx: Context) {
  if (!Array.isArray(ctx.state?.currentRoles) || !ctx.state.currentRoles.includes('root')) {
    ctx.throw(403, ctx.t('Permission denied', { ns: 'plugin-workflow-build-guide' }));
  }
}

export default class PluginWorkflowBuildGuideServer extends Plugin {
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  private workflowPlugin() {
    return this.app.pm.get('workflow') as WorkflowPlugin | undefined;
  }

  async getActiveRevision(): Promise<WorkflowRevision | null> {
    const revisions = await this.db.getRepository('workflows').find({
      filter: { key: WORKFLOW_KEY, enabled: true },
      sort: ['-id'],
    });
    if (revisions.length !== 1 || !(await assertSafeWorkflow(this.app, revisions[0].id))) return null;
    return { id: revisions[0].id, key: revisions[0].key, enabled: true };
  }

  async canRetryRun(runId: string): Promise<boolean> {
    const run = await this.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
    if (!run || run.get('engine') !== 'workflow' || !['failed', 'cancelled'].includes(String(run.get('status'))))
      return false;
    const current = await this.getActiveRevision();
    if (!current || String(current.id) !== String(run.get('workflowRevisionId'))) return false;
    const space = await this.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: run.get('spaceId') });
    if (!space || space.get('status') === 'building' || space.get('activeRunId')) return false;
    return Boolean(
      await this.db.getRepository('aiBuildGuideRunArtifacts').findOne({ filter: { runId, artifactKey: 'input' } }),
    );
  }

  async cancelRun(runId: string): Promise<boolean> {
    const workflow = this.workflowPlugin();
    if (!workflow) return false;
    const initial = await this.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
    if (!initial || initial.get('engine') !== 'workflow') return false;
    const initialStatus = String(initial.get('status'));
    if (!['queued', 'running', 'unknown'].includes(initialStatus)) return false;
    const initialExecutionId = initial.get('executionId') == null ? null : String(initial.get('executionId'));
    const cancel = async () => {
      const changed = await this.db.sequelize.transaction(async (transaction) => {
        const run = await this.db.getCollection('aiBuildGuideRuns').model.findOne({
          where: { id: runId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          !run ||
          run.get('engine') !== 'workflow' ||
          !['queued', 'running', 'unknown'].includes(String(run.get('status')))
        ) {
          return { changed: false, executionId: null };
        }
        const status = String(run.get('status'));
        const space = await this.db.getCollection('aiBuildGuideSpaces').model.findOne({
          where: { id: run.get('spaceId') },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const ownsSpace =
          space && String(space.get('activeRunId')) === runId && String(space.get('buildRunId')) === runId;
        if (status !== 'unknown' && !ownsSpace) return { changed: false, executionId: null };
        const executionId = run.get('executionId') == null ? null : String(run.get('executionId'));
        await run.update(
          { status: 'cancelled', stage: 'cancelled', errorCode: 'CANCELLED', finishedAt: new Date() },
          { transaction },
        );
        await this.db.getCollection('aiBuildGuideRunSteps').model.update(
          {
            status: 'cancelled',
            errorCode: 'CANCELLED',
            ownerToken: null,
            leaseExpiresAt: null,
            finishedAt: new Date(),
          },
          { where: { runId, status: ['pending', 'running', 'unknown'] }, transaction },
        );
        if (ownsSpace) {
          await space.update(
            {
              status: 'error',
              buildPhase: 'cancelled',
              buildLog: 'CANCELLED',
              activeRunId: null,
              buildHeartbeatAt: new Date(),
            },
            { transaction },
          );
        }
        return { changed: true, executionId };
      });
      return changed;
    };
    const result =
      initialExecutionId == null
        ? await cancel()
        : await (
            await this.app.lockManager.tryAcquire(getExecutionLockKey(initialExecutionId), 60_000)
          ).runExclusive(cancel, 60_000);
    if (!result.changed) return false;
    if (result.executionId != null) {
      const execution = await this.db.getRepository('executions').findOne({ filterByTk: result.executionId });
      if (execution && [EXECUTION_STATUS.QUEUEING, EXECUTION_STATUS.STARTED].includes(execution.status)) {
        const lock = await this.app.lockManager.tryAcquire(getExecutionLockKey(result.executionId), 60_000);
        await lock.runExclusive(
          () => abortExecution(workflow, execution, { reason: EXECUTION_REASON.MANUAL_CANCEL }),
          60_000,
        );
      }
    }
    return true;
  }

  async retryRun(runId: string, requesterId: string): Promise<string> {
    if (!(await this.canRetryRun(runId))) throw new Error('This Build Guide run cannot be retried');
    const previous = await this.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
    const inputArtifact = await this.db.getRepository('aiBuildGuideRunArtifacts').findOne({
      filter: { runId, artifactKey: 'input' },
    });
    if (!previous || !inputArtifact) throw new Error('This Build Guide run cannot be retried');
    const spaceId = String(previous.get('spaceId'));
    const nextRunId = randomUUID();
    const current = await this.getActiveRevision();
    if (!current || String(current.id) !== String(previous.get('workflowRevisionId'))) {
      throw new Error('The pinned Build Guide workflow revision is unavailable');
    }
    const lock = await this.app.lockManager.tryAcquire(`workflow-build-guide:space:${spaceId}`, 60_000);
    await lock.runExclusive(async () => {
      await this.db.sequelize.transaction(async (transaction) => {
        const space = await this.db.getCollection('aiBuildGuideSpaces').model.findOne({
          where: { id: spaceId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const oldRun = await this.db.getCollection('aiBuildGuideRuns').model.findOne({
          where: { id: runId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          !space ||
          !oldRun ||
          !['failed', 'cancelled'].includes(String(oldRun.get('status'))) ||
          space.get('status') === 'building' ||
          space.get('activeRunId')
        ) {
          throw new Error('This Build Guide run cannot be retried');
        }
        await this.db.getRepository('aiBuildGuideRuns').create({
          values: {
            id: nextRunId,
            spaceId,
            engine: 'workflow',
            requesterId,
            workflowKey: WORKFLOW_KEY,
            workflowRevisionId: String(current.id),
            retryOfRunId: runId,
            status: 'queued',
            stage: 'queued',
          },
          transaction,
        });
        await this.db
          .getCollection('aiBuildGuideRunArtifacts')
          .model.create(
            { id: randomUUID(), runId: nextRunId, artifactKey: 'input', payload: inputArtifact.get('payload') },
            { transaction },
          );
        await space.update(
          {
            status: 'building',
            buildPhase: 'queued',
            buildLog: 'Build queued',
            buildRunId: nextRunId,
            activeRunId: nextRunId,
            latestRunId: nextRunId,
            buildQueuedAt: new Date(),
            buildStartedAt: null,
            buildHeartbeatAt: null,
            buildWorkerId: null,
          },
          { transaction },
        );
      });
    }, 60_000);
    return nextRunId;
  }

  private async findExecution(run: { id: ID; workflowRevisionId: ID; executionId?: ID | null }) {
    const repository = this.db.getRepository('executions');
    const execution =
      run.executionId != null
        ? await repository.findOne({ filterByTk: run.executionId, fields: ['id', 'workflowId', 'context', 'status'] })
        : await this.db.getCollection('executions').model.findOne({
            where: {
              workflowId: run.workflowRevisionId,
              [Op.and]: [where(json('context.data.id') as unknown as WhereLeftOperand, Op.eq, String(run.id))],
            },
          });
    if (!execution) return undefined;
    const context: unknown = readModelValue(execution, 'context');
    if (
      String(readModelValue(execution, 'workflowId')) !== String(run.workflowRevisionId) ||
      !isRecord(context) ||
      !isRecord(context.data) ||
      String(context.data.id) !== String(run.id)
    ) {
      return undefined;
    }
    return execution as unknown as ExecutionRecord;
  }

  private async findRunPages(filter: {
    engine: string;
    status: string | string[];
    nativeResumePending?: boolean;
  }): Promise<RunRecord[]> {
    const rows: RunRecord[] = [];
    const pageSize = 100;
    let offset = 0;
    let hasNextPage = true;
    while (hasNextPage) {
      const page = (await this.db.getRepository('aiBuildGuideRuns').find({
        filter,
        sort: ['createdAt', 'id'],
        limit: pageSize,
        offset,
      })) as unknown as RunRecord[];
      rows.push(...page);
      hasNextPage = page.length === pageSize;
      if (hasNextPage) offset += page.length;
    }
    return rows;
  }

  private async clearNativeResumePending(runId: ID, executionId?: ID) {
    await this.db.getCollection('aiBuildGuideRuns').model.update(
      { nativeResumePending: false },
      {
        where: {
          id: runId,
          engine: 'workflow',
          status: 'completed',
          nativeResumePending: true,
          ...(executionId == null ? {} : { executionId: String(executionId) }),
        },
      },
    );
  }

  private async expireOwnedStep(run: { id: ID; spaceId: ID }, executionId: ID, stepId: ID) {
    return this.db.sequelize.transaction(async (transaction) => {
      const currentRun = await this.db.getCollection('aiBuildGuideRuns').model.findOne({
        where: { id: run.id, engine: 'workflow', status: 'running', executionId: String(executionId) },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!currentRun) return false;
      const execution = await this.db.getCollection('executions').model.findOne({
        where: {
          id: executionId,
          workflowId: String(currentRun.get('workflowRevisionId')),
          status: EXECUTION_STATUS.STARTED,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const space = await this.db.getCollection('aiBuildGuideSpaces').model.findOne({
        where: { id: run.spaceId, activeRunId: run.id, buildRunId: run.id, status: 'building' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!execution || !space) return false;
      const step = await this.db.getCollection('aiBuildGuideRunSteps').model.findOne({
        where: { id: stepId, runId: run.id, executionId: String(executionId), status: 'running' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const ownerToken = step?.get('ownerToken');
      const expiry = step?.get('leaseExpiresAt');
      let expiresAt: Date | null = null;
      if (expiry instanceof Date) expiresAt = expiry;
      else if (typeof expiry === 'string' || typeof expiry === 'number') expiresAt = new Date(expiry);
      if (
        !step ||
        typeof ownerToken !== 'string' ||
        !expiresAt ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() > Date.now()
      ) {
        return false;
      }
      await step.update(
        { status: 'unknown', errorCode: 'UNKNOWN_OUTCOME', ownerToken: null, finishedAt: new Date() },
        { transaction },
      );
      await currentRun.update({ status: 'unknown', stage: 'unknown', errorCode: 'UNKNOWN_OUTCOME' }, { transaction });
      await space.update(
        { status: 'error', buildPhase: 'unknown', buildLog: 'UNKNOWN_OUTCOME', activeRunId: null },
        { transaction },
      );
      return true;
    });
  }

  private async settleWorkflowRun(runId: ID, errorCode: string, executionId?: ID, completed = false) {
    await this.db.sequelize.transaction(async (transaction) => {
      const run = await this.db.getCollection('aiBuildGuideRuns').model.findOne({
        where: { id: runId, engine: 'workflow', status: ['queued', 'running'] },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!run || (executionId != null && String(run.get('executionId')) !== String(executionId))) return;
      const space = await this.db.getCollection('aiBuildGuideSpaces').model.findOne({
        where: { id: run.get('spaceId') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const published = completed && space && String(space.get('publishedRunId')) === String(runId);
      const nextStatus = published ? 'completed' : 'failed';
      const nextCode = published ? null : errorCode;
      await run.update(
        {
          status: nextStatus,
          stage: nextStatus,
          errorCode: nextCode,
          finishedAt: new Date(),
        },
        { transaction },
      );
      if (!published) {
        await this.db
          .getCollection('aiBuildGuideRunSteps')
          .model.update(
            { status: 'failed', errorCode, ownerToken: null, leaseExpiresAt: null, finishedAt: new Date() },
            { where: { runId, status: ['pending', 'running'] }, transaction },
          );
        if (space) {
          await space.update(
            { status: 'error', buildPhase: 'failed', buildLog: errorCode, activeRunId: null },
            { where: { id: space.get('id'), activeRunId: runId, buildRunId: runId }, transaction },
          );
        }
      }
    });
  }

  private async reconcile() {
    if (this.reconciling) return;
    const workflow = this.workflowPlugin();
    if (!workflow) return;
    this.reconciling = true;
    try {
      const activeRuns = await this.findRunPages({ engine: 'workflow', status: ['queued', 'running'] });
      const publishCheckpoints = await this.findRunPages({
        engine: 'workflow',
        status: 'completed',
        nativeResumePending: true,
      });

      for (const runRecord of publishCheckpoints) {
        const run = {
          id: runRecord.id as ID,
          workflowRevisionId: runRecord.get('workflowRevisionId') as ID,
          executionId: runRecord.get('executionId') as ID | null,
        };
        const execution = await this.findExecution(run);
        if (!execution) {
          continue;
        }
        if (execution.status === EXECUTION_STATUS.QUEUEING) {
          await workflow.start(execution as never);
          continue;
        }
        if (execution.status !== EXECUTION_STATUS.STARTED) {
          await this.clearNativeResumePending(run.id, run.executionId ?? undefined);
          continue;
        }
        const publishStep = await this.db.getRepository('aiBuildGuideRunSteps').findOne({
          filter: {
            runId: run.id,
            stepKey: 'publish',
            executionId: String(execution.id),
            status: 'completed',
          },
        });
        const job = publishStep
          ? await this.db.getRepository('jobs').findOne({ filterByTk: publishStep.get('jobId') })
          : null;
        if (!job || job.status !== JOB_STATUS.RESOLVED) continue;
        const lock = await this.app.lockManager.tryAcquire(`workflow-build-guide:resume:${run.id}`, 30_000);
        await lock.runExclusive(() => workflow.resume(job), 30_000);
      }

      for (const runRecord of activeRuns) {
        const run = {
          id: runRecord.id as ID,
          spaceId: runRecord.get('spaceId') as ID,
          workflowRevisionId: runRecord.get('workflowRevisionId') as ID,
          executionId: runRecord.get('executionId') as ID | null,
        };
        const revision = await this.db.getRepository('workflows').findOne({ filterByTk: run.workflowRevisionId });
        if (!revision?.enabled || !(await assertSafeWorkflow(this.app, run.workflowRevisionId))) {
          await this.settleWorkflowRun(run.id, 'WORKFLOW_UNAVAILABLE');
          continue;
        }
        let execution = await this.findExecution(run);
        if (execution) {
          if (run.executionId == null) {
            await this.db
              .getCollection('aiBuildGuideRuns')
              .model.update(
                { executionId: String(execution.id) },
                { where: { id: run.id, status: ['queued', 'running'], executionId: null } },
              );
          }
          if (execution.status === EXECUTION_STATUS.QUEUEING) {
            await workflow.start(execution as never);
            continue;
          }
        } else if (runRecord.get('status') === 'queued') {
          const createdAtValue = runRecord.get('createdAt');
          let createdAt: Date | null = null;
          if (createdAtValue instanceof Date) createdAt = createdAtValue;
          else if (typeof createdAtValue === 'string' || typeof createdAtValue === 'number') {
            createdAt = new Date(createdAtValue);
          }
          if (createdAt && Number.isFinite(createdAt.getTime()) && Date.now() - createdAt.getTime() < 15_000) continue;
          await workflow.execute(
            revision as never,
            { data: runRecord.toJSON() },
            { eventKey: `guide-build:${run.id}` },
          );
          execution = await this.findExecution(run);
        }
        if (!execution) continue;
        const executionId = execution.id as ID;
        if (execution.status !== EXECUTION_STATUS.STARTED) {
          await this.settleWorkflowRun(
            run.id,
            'BUILD_FAILED',
            executionId,
            execution.status === EXECUTION_STATUS.RESOLVED,
          );
          continue;
        }
        const runStatus = String(runRecord.get('status'));
        if (runStatus !== 'running') continue;
        const publishing = await this.db.getRepository('aiBuildGuideRunSteps').find({
          filter: { runId: run.id, executionId: String(executionId), stepKey: 'publish', status: 'running' },
          fields: ['jobId'],
        });
        for (const step of publishing) {
          const job = await this.db.getRepository('jobs').findOne({ filterByTk: step.get('jobId') });
          if (!job || job.status !== JOB_STATUS.PENDING) continue;
          const lock = await this.app.lockManager.tryAcquire(`workflow-build-guide:resume:${run.id}`, 30_000);
          await lock.runExclusive(() => workflow.resume(job), 30_000);
        }
        const steps = await this.db.getRepository('aiBuildGuideRunSteps').find({
          filter: {
            runId: run.id,
            executionId: String(executionId),
            status: 'running',
            stepKey: { $ne: 'publish' },
          },
          fields: ['id', 'stepKey', 'leaseExpiresAt'],
        });
        let unknownOutcome = false;
        for (const step of steps) {
          const expiryValue = step.get('leaseExpiresAt');
          const expiry =
            expiryValue instanceof Date ? expiryValue.getTime() : new Date(String(expiryValue ?? '')).getTime();
          if (!Number.isFinite(expiry) || expiry > Date.now()) continue;
          if (await this.expireOwnedStep(run, executionId, step.id as ID)) unknownOutcome = true;
        }
        if (unknownOutcome) continue;

        const completed = await this.db.getRepository('aiBuildGuideRunSteps').find({
          filter: { runId: run.id, executionId: String(executionId), status: 'completed' },
          fields: ['jobId', 'stepKey'],
        });
        for (const step of completed) {
          const job = await this.db.getRepository('jobs').findOne({ filterByTk: step.get('jobId') });
          if (!job || job.status !== JOB_STATUS.RESOLVED) continue;
          const stepKey = String(step.get('stepKey'));
          let shouldResume = false;
          if (stepKey === 'prepare' || stepKey === 'plan') {
            const downstream = await this.db.getRepository('jobs').count({
              filter: { executionId, upstreamId: job.id },
            });
            shouldResume = Number(downstream) === 0;
          } else if (stepKey.startsWith('chapter:')) {
            const chapterMatch = /^chapter:chapter-(\d+)$/.exec(stepKey);
            const index = chapterMatch ? Number(chapterMatch[1]) - 1 : -1;
            if (index >= 0) {
              const loopNode = await this.db.getRepository('flow_nodes').findOne({
                filter: { workflowId: run.workflowRevisionId, key: 'guide_chapters' },
              });
              const loopJobs = loopNode
                ? ((await this.db.getRepository('jobs').find({
                    filter: { executionId, nodeId: loopNode.id, status: JOB_STATUS.PENDING },
                    fields: ['id', 'result'],
                  })) as unknown as Array<{ id: ID; get: (field: string) => unknown }>)
                : [];
              shouldResume = loopJobs.some((loopJob) => {
                const result: unknown = loopJob.get('result');
                return isRecord(result) && result.looped === index && String(job.upstreamId) === String(loopJob.id);
              });
            }
          }
          if (shouldResume) {
            const lock = await this.app.lockManager.tryAcquire(`workflow-build-guide:resume:${run.id}`, 30_000);
            await lock.runExclusive(() => workflow.resume(job), 30_000);
          }
        }
      }
    } catch (error) {
      this.log.error('Build Guide workflow reconciliation failed', {
        errorName: error instanceof Error ? error.name : 'Error',
      });
    } finally {
      this.reconciling = false;
    }
  }

  async load() {
    const workflow = this.workflowPlugin();
    if (workflow?.registerInstruction) {
      workflow.registerInstruction('guide-build-prepare', new GuidePrepareInstruction(workflow));
      workflow.registerInstruction('guide-build-llm', new GuideLlmInstruction(workflow));
      workflow.registerInstruction('guide-build-publish', new GuidePublishInstruction(workflow));
    }
    this.app.resourceManager.use((ctx, next) => guardManagedWorkflowActions(ctx as Context, next));
    this.app.resourceManager.define({
      name: 'workflowBuildGuide',
      actions: {
        status: async (ctx, next) => {
          requireRoot(ctx as Context);
          ctx.body = { workflowKey: WORKFLOW_KEY, revision: await this.getActiveRevision() };
          await next();
        },
        setup: async (ctx, next) => {
          requireRoot(ctx as Context);
          const plugin = this.workflowPlugin();
          if (!plugin) {
            ctx.throw(503, ctx.t('Workflow plugin is unavailable', { ns: 'plugin-workflow-build-guide' }));
            return;
          }
          try {
            ctx.body = await setupWorkflow(this.app, plugin);
          } catch (error) {
            this.log.warn('Build Guide workflow setup failed', {
              errorName: error instanceof Error ? error.name : 'Error',
            });
            ctx.throw(409, ctx.t('Could not set up the Build Guide workflow', { ns: 'plugin-workflow-build-guide' }));
          }
          await next();
        },
      },
    });
    this.app.acl.registerSnippet({
      name: 'pm.plugin-workflow-build-guide.manage',
      actions: ['workflowBuildGuide:status', 'workflowBuildGuide:setup'],
    });
    this.app.on('afterStart', async () => {
      await this.reconcile();
      if (!this.timer) {
        this.timer = setInterval(() => {
          this.reconcile();
        }, 30_000);
      }
    });
    this.app.on('beforeStop', () => this.stop());
    this.app.on('beforeDestroy', () => this.stop());
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
