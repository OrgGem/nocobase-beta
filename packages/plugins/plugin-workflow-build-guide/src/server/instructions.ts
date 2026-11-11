/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  EXECUTION_STATUS,
  Instruction,
  JOB_STATUS,
  type FlowNodeModel,
  type IJob,
  type Processor,
} from '@nocobase/plugin-workflow';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import type { Application } from '@nocobase/server';
import { randomUUID } from 'node:crypto';
import { WORKFLOW_KEY, WORKFLOW_MARKER } from './templates';

type ID = string | number;
type PlainRecord = Record<string, unknown>;
type GuidePlanItem = { title: string; goal?: string; sourceHints?: string[] };
type GuidePlan = { title?: string; chapters: GuidePlanItem[] };
type InputSnapshot = {
  title: string;
  llmService: string;
  model: string;
  systemPrompt: string;
  outputFormat: string;
  targetChapterCount: number;
  chapterGuidance: string;
  documentsText: string;
  sourceHash: string;
};
type InputDescriptor = Omit<InputSnapshot, 'documentsText' | 'sourceHash'> & {
  documents: Array<{ id: ID; updatedAt: string; filename: string; mimetype: string; extname: string }>;
};
type GuideDomain = {
  buildPageMarkdown: (
    provider: unknown,
    space: unknown,
    plan: GuidePlan,
    chapter: GuidePlanItem,
    documentsText: string,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
  buildPlan: (
    provider: unknown,
    space: unknown,
    documentsText: string,
    options?: { signal?: AbortSignal },
  ) => Promise<GuidePlan>;
  createGuideSearchMetadata: (params: {
    chapter: GuidePlanItem;
    guideTitle?: string;
    markdown?: string;
    slug: string;
  }) => { metadata: unknown; searchText: string };
  getLLMProvider: (app: Application, llmService: string, model: string) => Promise<unknown>;
  markdownToCleanHtml: (markdown: string) => Promise<string>;
  materializeBuildGuideInputSnapshot: (app: Application, descriptor: InputDescriptor) => Promise<InputSnapshot>;
  normalizePlan: (rawText: string, title: string, count: number) => GuidePlan;
  slugify: (text: string, fallback: string) => string;
  toPlainText: (value: unknown) => string;
};
type BuildGuideServer = { workflowDomain?: GuideDomain };
type Provider = { chatModel: { invoke(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown> } };
type WorkflowRun = {
  id: ID;
  spaceId: ID;
  engine: string;
  workflowKey: string;
  workflowRevisionId: ID;
  executionId: ID | null;
  status: string;
};
type StepClaim =
  | { kind: 'owned'; stepId: ID; ownerToken: string }
  | { kind: 'completed'; payload: unknown }
  | { kind: 'blocked' };

const ERROR_CODES = new Set([
  'SOURCE_CHANGED',
  'SOURCE_ACCESS_DENIED',
  'INVALID_PLAN',
  'PROVIDER_UNAVAILABLE',
  'UNKNOWN_OUTCOME',
  'PUBLISH_FAILED',
  'CANCELLED',
  'WORKFLOW_UNAVAILABLE',
  'BUILD_FAILED',
]);

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function id(value: unknown): value is ID {
  return typeof value === 'string' || typeof value === 'number';
}

function modelValue(model: unknown, key: string): unknown {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as { get?: (field: string) => unknown } & Record<string, unknown>;
  return typeof record.get === 'function' ? record.get(key) : record[key];
}

function guideDomain(app: Application): GuideDomain {
  const plugin = (app.pm.get('plugin-build-guide-block') || app.pm.get('build-guide-block')) as
    | BuildGuideServer
    | undefined;
  if (!plugin?.workflowDomain) throw new Error('BUILD_GUIDE_PLUGIN_UNAVAILABLE');
  return plugin.workflowDomain;
}

function workflowRunId(processor: Processor): ID {
  const context: unknown = processor.execution.context;
  if (!isRecord(context) || !isRecord(context.data) || !id(context.data.id)) {
    throw new Error('WORKFLOW_CONTEXT_INVALID');
  }
  if (
    context.data.engine !== 'workflow' ||
    String(context.data.workflowRevisionId) !== String(processor.execution.workflowId)
  ) {
    throw new Error('WORKFLOW_REVISION_MISMATCH');
  }
  return context.data.id;
}

async function loadRun(workflow: WorkflowPlugin, processor: Processor): Promise<WorkflowRun> {
  const runId = workflowRunId(processor);
  const run = await workflow.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
  if (
    !run ||
    run.get('engine') !== 'workflow' ||
    run.get('workflowKey') !== WORKFLOW_KEY ||
    String(run.get('workflowRevisionId')) !== String(processor.execution.workflowId) ||
    String(run.get('spaceId')) === ''
  ) {
    throw new Error('WORKFLOW_RUN_INVALID');
  }
  const revision = await workflow.db.getRepository('workflows').findOne({ filterByTk: processor.execution.workflowId });
  const marker = revision?.options?.[WORKFLOW_MARKER];
  if (
    !revision ||
    revision.enabled !== true ||
    revision.key !== WORKFLOW_KEY ||
    !isRecord(marker) ||
    marker.managed !== true ||
    revision.type !== 'collection'
  ) {
    throw new Error('WORKFLOW_REVISION_UNAVAILABLE');
  }
  return run as unknown as WorkflowRun;
}

async function withRunLock<T>(
  workflow: WorkflowPlugin,
  runId: ID,
  callback: (transaction: any) => Promise<T>,
): Promise<T> {
  return workflow.db.sequelize.transaction(async (transaction) => {
    const run = await workflow.db.getCollection('aiBuildGuideRuns').model.findOne({
      where: { id: runId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!run) throw new Error('WORKFLOW_RUN_MISSING');
    return callback(transaction);
  });
}

async function assertCurrentOwner(workflow: WorkflowPlugin, runId: ID, executionId: ID, transaction: any) {
  const run = await workflow.db.getCollection('aiBuildGuideRuns').model.findOne({
    where: { id: runId, engine: 'workflow', status: 'running', executionId: String(executionId) },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const execution = await workflow.db.getCollection('executions').model.findOne({
    where: { id: executionId, workflowId: String(run?.get('workflowRevisionId')), status: EXECUTION_STATUS.STARTED },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const space = run
    ? await workflow.db.getCollection('aiBuildGuideSpaces').model.findOne({
        where: { id: run.get('spaceId'), activeRunId: runId, buildRunId: runId, status: 'building' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
    : null;
  if (!run || !execution || !space) throw new Error('WORKFLOW_RUN_NOT_OWNED');
  return { run, space };
}

async function claimRun(workflow: WorkflowPlugin, processor: Processor, run: WorkflowRun): Promise<boolean> {
  const executionId = processor.execution.id;
  return workflow.db.sequelize.transaction(async (transaction) => {
    const current = await workflow.db.getCollection('aiBuildGuideRuns').model.findOne({
      where: { id: run.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const execution = await workflow.db.getCollection('executions').model.findOne({
      where: { id: executionId, workflowId: String(run.workflowRevisionId), status: EXECUTION_STATUS.STARTED },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const space = await workflow.db.getCollection('aiBuildGuideSpaces').model.findOne({
      where: { id: run.spaceId, buildRunId: run.id, activeRunId: run.id, status: 'building' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!current || !execution || !space || current.get('engine') !== 'workflow') return false;
    const currentExecutionId = current.get('executionId');
    if (
      current.get('status') === 'queued' &&
      (currentExecutionId == null || String(currentExecutionId) === String(executionId))
    ) {
      await current.update(
        {
          executionId: String(executionId),
          status: 'running',
          stage: 'preparing',
          startedAt: new Date(),
        },
        { transaction },
      );
      await space.update(
        { buildPhase: 'preparing', buildStartedAt: new Date(), buildHeartbeatAt: new Date() },
        { transaction },
      );
      return true;
    }
    return current.get('status') === 'running' && String(currentExecutionId) === String(executionId);
  });
}

async function setStage(workflow: WorkflowPlugin, run: WorkflowRun, stage: string, log: string) {
  await withRunLock(workflow, run.id, async (transaction) => {
    const { run: current, space } = await assertCurrentOwner(workflow, run.id, String(run.executionId), transaction);
    await current.update({ stage }, { transaction });
    await space.update({ buildPhase: stage, buildLog: log, buildHeartbeatAt: new Date() }, { transaction });
  });
}

async function claimStep(
  workflow: WorkflowPlugin,
  run: WorkflowRun,
  processor: Processor,
  stepKey: string,
  job: { id: ID; nodeId: ID },
): Promise<StepClaim> {
  const ownerToken = randomUUID();
  return withRunLock(workflow, run.id, async (transaction) => {
    await assertCurrentOwner(workflow, run.id, processor.execution.id, transaction);
    const steps = workflow.db.getCollection('aiBuildGuideRunSteps').model;
    const current = await steps.findOne({
      where: { runId: run.id, stepKey },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (current?.get('status') === 'completed') {
      const artifact = await workflow.db.getCollection('aiBuildGuideRunArtifacts').model.findOne({
        where: { runId: run.id, artifactKey: current.get('artifactKey') },
        transaction,
      });
      return { kind: 'completed', payload: artifact?.get('payload') };
    }
    if (current && ['running', 'pending', 'unknown'].includes(String(current.get('status'))))
      return { kind: 'blocked' };
    const values = {
      runId: run.id,
      stepKey,
      executionId: String(processor.execution.id),
      jobId: String(job.id),
      attempt: current ? Number(current.get('attempt') || 1) + 1 : 1,
      ownerToken,
      status: 'running',
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
    if (current) {
      await current.update(values, { transaction });
      return { kind: 'owned', stepId: current.get('id') as ID, ownerToken };
    }
    const created = await steps.create(values, { transaction });
    return { kind: 'owned', stepId: created.get('id') as ID, ownerToken };
  });
}

async function savePrivateResult(
  workflow: WorkflowPlugin,
  run: WorkflowRun,
  processor: Processor,
  stepKey: string,
  stepId: ID,
  ownerToken: string,
  jobId: ID,
  artifactKey: string,
  payload: unknown,
  result: unknown,
  stage: string,
  progress?: number,
) {
  await withRunLock(workflow, run.id, async (transaction) => {
    const { run: current, space } = await assertCurrentOwner(workflow, run.id, processor.execution.id, transaction);
    const step = await workflow.db.getCollection('aiBuildGuideRunSteps').model.findOne({
      where: { id: stepId, runId: run.id, stepKey, ownerToken, status: 'running' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!step) throw new Error('WORKFLOW_STEP_NOT_OWNED');
    await workflow.db
      .getCollection('aiBuildGuideRunArtifacts')
      .model.create({ id: randomUUID(), runId: run.id, artifactKey, payload }, { transaction });
    const [jobUpdated] = await workflow.db
      .getCollection('jobs')
      .model.update(
        { status: JOB_STATUS.RESOLVED, result },
        { where: { id: jobId, executionId: processor.execution.id, status: JOB_STATUS.PENDING }, transaction },
      );
    if (!jobUpdated) throw new Error('WORKFLOW_JOB_NOT_PENDING');
    await step.update(
      { status: 'completed', artifactKey, finishedAt: new Date(), leaseExpiresAt: null },
      { transaction },
    );
    await current.update({ stage, ...(progress == null ? {} : { completedCount: progress }) }, { transaction });
    await space.update({ buildPhase: stage, buildHeartbeatAt: new Date() }, { transaction });
  });
}

async function failRun(
  workflow: WorkflowPlugin,
  run: WorkflowRun,
  executionId: ID,
  code: string,
  stepId?: ID,
  jobId?: ID,
) {
  const errorCode = ERROR_CODES.has(code) ? code : 'BUILD_FAILED';
  await workflow.db.sequelize.transaction(async (transaction) => {
    const current = await workflow.db.getCollection('aiBuildGuideRuns').model.findOne({
      where: { id: run.id, executionId: String(executionId), status: 'running' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!current) return;
    if (stepId) {
      await workflow.db.getCollection('aiBuildGuideRunSteps').model.update(
        {
          status: errorCode === 'UNKNOWN_OUTCOME' ? 'unknown' : 'failed',
          errorCode,
          finishedAt: new Date(),
          ownerToken: null,
        },
        { where: { id: stepId, runId: run.id, executionId: String(executionId), status: 'running' }, transaction },
      );
    }
    if (jobId) {
      await workflow.db
        .getCollection('jobs')
        .model.update(
          { status: JOB_STATUS.ERROR, result: { runId: run.id, errorCode } },
          { where: { id: jobId, executionId, status: JOB_STATUS.PENDING }, transaction },
        );
    }
    const status = errorCode === 'UNKNOWN_OUTCOME' ? 'unknown' : 'failed';
    await current.update(
      { status, stage: status, errorCode, finishedAt: status === 'failed' ? new Date() : null },
      { transaction },
    );
    await workflow.db
      .getCollection('aiBuildGuideSpaces')
      .model.update(
        { status: 'error', buildPhase: status, buildLog: errorCode, activeRunId: null, buildHeartbeatAt: new Date() },
        { where: { id: run.spaceId, activeRunId: run.id, buildRunId: run.id }, transaction },
      );
  });
}

function chapterKey(index: number) {
  return `chapter-${index + 1}`;
}

function createRunAbortHandle(workflow: WorkflowPlugin, runId: ID, processor: Processor) {
  const background = processor.createBackgroundAbortHandle();
  const controller = new AbortController();
  let checking = false;
  const abortFromProcessor = () => {
    if (!controller.signal.aborted) controller.abort(background.signal.reason);
  };
  if (background.signal.aborted) abortFromProcessor();
  else background.signal.addEventListener('abort', abortFromProcessor, { once: true });
  const checkRun = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const run = await workflow.db.getRepository('aiBuildGuideRuns').findOne({
        filterByTk: runId,
        fields: ['id', 'status'],
      });
      if (!run || run.get('status') !== 'running') {
        controller.abort(new Error('Build Guide run is no longer active'));
      }
    } catch (error) {
      processor.logger.warn('Build Guide cancellation check failed', {
        errorName: error instanceof Error ? error.name : 'Error',
        runId: String(runId),
      });
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => {
    checkRun().catch((error: unknown) => {
      processor.logger.warn('Build Guide cancellation check failed', {
        errorName: error instanceof Error ? error.name : 'Error',
        runId: String(runId),
      });
    });
  }, 1_000);
  return {
    signal: controller.signal,
    throwIfAborted() {
      background.throwIfAborted();
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    dispose() {
      clearInterval(timer);
      background.signal.removeEventListener('abort', abortFromProcessor);
      background.dispose();
    },
  };
}

function readPlan(payload: unknown): GuidePlan {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.chapters) ||
    !payload.chapters.every((item) => isRecord(item) && typeof item.title === 'string')
  ) {
    throw new Error('INVALID_PLAN');
  }
  return payload as unknown as GuidePlan;
}

async function hasUnconsumedLinearCheckpoint(
  workflow: WorkflowPlugin,
  processor: Processor,
  job: IJob,
  stepKey: 'prepare' | 'plan',
  artifactKey: 'prepare' | 'plan',
): Promise<boolean> {
  const result: unknown = job.result;
  const runId = isRecord(result) && id(result.runId) ? result.runId : null;
  if (runId == null || job.status !== JOB_STATUS.RESOLVED) return false;

  const executionId = processor.execution.id;
  const run = await workflow.db.getRepository('aiBuildGuideRuns').findOne({
    filter: {
      id: runId,
      engine: 'workflow',
      status: 'running',
      executionId: String(executionId),
    },
  });
  if (!run) return false;

  const step = await workflow.db.getRepository('aiBuildGuideRunSteps').findOne({
    filter: {
      runId,
      stepKey,
      executionId: String(executionId),
      jobId: String(job.id),
      status: 'completed',
    },
  });
  if (!step || step.get('artifactKey') !== artifactKey || typeof step.get('ownerToken') !== 'string') return false;

  const artifact = await workflow.db.getRepository('aiBuildGuideRunArtifacts').findOne({
    filter: { runId, artifactKey },
  });
  if (!artifact) return false;

  const downstreamCount = await workflow.db.getRepository('jobs').count({
    filter: { executionId, upstreamId: job.id },
  });
  return Number(downstreamCount) === 0;
}

async function publishRun(
  workflow: WorkflowPlugin,
  run: WorkflowRun,
  processor: Processor,
  jobId: ID,
  stepId: ID,
  ownerToken: string,
  plan: GuidePlan,
  chapters: PlainRecord[],
) {
  const combinedMarkdown = chapters.map((chapter) => chapter.generatedMarkdown).join('\n\n---\n\n');
  if (!combinedMarkdown.trim()) throw new Error('INVALID_PLAN');
  const combinedHtml = await guideDomain(workflow.app).markdownToCleanHtml(combinedMarkdown);
  return workflow.db.sequelize.transaction(async (transaction) => {
    const { run: current, space } = await assertCurrentOwner(workflow, run.id, processor.execution.id, transaction);
    const step = await workflow.db.getCollection('aiBuildGuideRunSteps').model.findOne({
      where: { id: stepId, runId: run.id, stepKey: 'publish', ownerToken, status: 'running' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!step) throw new Error('WORKFLOW_STEP_NOT_OWNED');
    const pages = workflow.db.getCollection('aiBuildGuidePages').model;
    const previousPages = await pages.findAll({
      where: { spaceId: run.spaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const page of previousPages) await page.destroy({ transaction });
    for (const [index, chapter] of chapters.entries()) {
      await pages.create(
        {
          spaceId: run.spaceId,
          sort: index + 1,
          title: chapter.title,
          slug: chapter.slug,
          goal: chapter.goal,
          planItem: chapter.planItem,
          status: 'completed',
          runId: run.id,
          published: true,
          generatedMarkdown: chapter.generatedMarkdown,
          generatedHtml: chapter.generatedHtml,
          searchMetadata: chapter.searchMetadata,
          searchText: chapter.searchText,
        },
        { transaction },
      );
    }
    const [spaceUpdated] = await workflow.db.getCollection('aiBuildGuideSpaces').model.update(
      {
        status: 'completed',
        buildPhase: 'completed',
        buildLog: `Built ${chapters.length} chapters successfully`,
        generatedMarkdown: combinedMarkdown,
        generatedHtml: combinedHtml,
        planJson: plan,
        pageCount: chapters.length,
        published: true,
        publishedRunId: run.id,
        latestRunId: run.id,
        activeRunId: null,
        buildHeartbeatAt: new Date(),
      },
      { where: { id: run.spaceId, buildRunId: run.id, activeRunId: run.id }, transaction },
    );
    if (!spaceUpdated) throw new Error('WORKFLOW_RUN_NOT_OWNED');
    await current.update(
      {
        status: 'completed',
        stage: 'completed',
        expectedCount: chapters.length,
        completedCount: chapters.length,
        nativeResumePending: true,
        finishedAt: new Date(),
      },
      { transaction },
    );
    await workflow.db.getCollection('aiBuildGuideRunArtifacts').model.create(
      {
        id: randomUUID(),
        runId: run.id,
        artifactKey: 'publish',
        payload: { markdown: combinedMarkdown, html: combinedHtml },
      },
      { transaction },
    );
    const [jobUpdated] = await workflow.db
      .getCollection('jobs')
      .model.update(
        { status: JOB_STATUS.RESOLVED, result: { runId: run.id, stage: 'completed', pageCount: chapters.length } },
        { where: { id: jobId, executionId: processor.execution.id, status: JOB_STATUS.PENDING }, transaction },
      );
    if (!jobUpdated) throw new Error('WORKFLOW_JOB_NOT_PENDING');
    await step.update(
      { status: 'completed', artifactKey: 'publish', finishedAt: new Date(), leaseExpiresAt: null },
      { transaction },
    );
    return workflow.db.getRepository('jobs').findOne({ filterByTk: jobId, transaction });
  });
}

async function publishCheckpoint(
  workflow: WorkflowPlugin,
  run: WorkflowRun,
  processor: Processor,
  jobId: ID,
  stepId: ID,
  ownerToken: string,
) {
  try {
    const planArtifact = await workflow.db.getRepository('aiBuildGuideRunArtifacts').findOne({
      filter: { runId: run.id, artifactKey: 'plan' },
    });
    const planPayload: unknown = planArtifact?.get('payload');
    const plan = readPlan(isRecord(planPayload) ? planPayload.plan : null);
    const domain = guideDomain(workflow.app);
    const keys = plan.chapters.map((_chapter, index) => chapterKey(index));
    const savedArtifacts = (await workflow.db.getRepository('aiBuildGuideRunArtifacts').find({
      filter: { runId: run.id },
      appends: [],
    })) as unknown as Array<{ get: (field: string) => unknown }>;
    const chapters = keys.map((key) => {
      const artifact = savedArtifacts.find((item) => modelValue(item, 'artifactKey') === `chapter:${key}`);
      const chapter: unknown = modelValue(artifact, 'payload');
      return isRecord(chapter) && chapter.status === 'completed' ? chapter : null;
    });
    if (chapters.some((chapter) => !chapter)) throw new Error('INVALID_PLAN');
    const job = await publishRun(workflow, run, processor, jobId, stepId, ownerToken, plan, chapters as PlainRecord[]);
    if (job) await resumeSavedJob(workflow, jobId, processor);
  } catch (error) {
    const code = error instanceof Error && error.message === 'INVALID_PLAN' ? 'INVALID_PLAN' : 'PUBLISH_FAILED';
    await failRun(workflow, run, processor.execution.id, code, stepId, jobId);
    await resumeSavedJob(workflow, jobId, processor);
  }
}

async function resumeSavedJob(workflow: WorkflowPlugin, jobId: ID, processor?: Processor) {
  const job = await workflow.db.getRepository('jobs').findOne({ filterByTk: jobId });
  if (!job) return;
  try {
    await workflow.resume(job);
  } catch (error) {
    processor?.logger.error('Build Guide checkpoint was saved but workflow resume failed', {
      errorName: error instanceof Error ? error.name : 'Error',
      jobId: String(jobId),
    });
  }
}

export class GuidePrepareInstruction extends Instruction {
  async run(_node: FlowNodeModel, input: unknown, processor: Processor) {
    const run = await loadRun(this.workflow, processor);
    if (!(await claimRun(this.workflow, processor, run))) {
      await processor.exit();
      return;
    }
    const job = processor.saveJob({
      status: JOB_STATUS.PENDING,
      nodeId: _node.id,
      nodeKey: _node.key,
      upstreamId: isRecord(input) && id(input.id) ? input.id : null,
      result: { runId: run.id, stage: 'preparing' },
    });
    const step = await claimStep(this.workflow, run, processor, 'prepare', job);
    if (step.kind === 'completed') {
      job.set({ status: JOB_STATUS.RESOLVED, result: { runId: run.id, stage: 'preparing' } });
      return job;
    }
    if (step.kind !== 'owned') {
      job.set({ status: JOB_STATUS.ERROR, result: { runId: run.id, errorCode: 'BUILD_FAILED' } });
      return job;
    }
    const existingInput = await this.workflow.db.getRepository('aiBuildGuideRunArtifacts').findOne({
      filter: { runId: run.id, artifactKey: 'input' },
    });
    const rawDescriptor: unknown = existingInput?.get('payload');
    if (!isRecord(rawDescriptor)) {
      await processor.exit();
      await failRun(this.workflow, run, processor.execution.id, 'SOURCE_ACCESS_DENIED', step.stepId, job.id);
      await resumeSavedJob(this.workflow, job.id, processor);
      return;
    }
    await this.workflow.db.getRepository('aiBuildGuideRunSteps').update({
      filterByTk: step.stepId,
      values: { artifactKey: 'input' },
    });
    const abort = createRunAbortHandle(this.workflow, run.id, processor);
    await processor.exit();
    const finish = async () => {
      try {
        const domain = guideDomain(this.workflow.app);
        const snapshot = await domain.materializeBuildGuideInputSnapshot(
          this.workflow.app,
          rawDescriptor as unknown as InputDescriptor,
        );
        await withRunLock(this.workflow, run.id, async (transaction) => {
          await assertCurrentOwner(this.workflow, run.id, processor.execution.id, transaction);
          await this.workflow.db
            .getCollection('aiBuildGuideRunArtifacts')
            .model.create(
              { id: randomUUID(), runId: run.id, artifactKey: 'source-snapshot', payload: snapshot },
              { transaction },
            );
        });
        await savePrivateResult(
          this.workflow,
          run,
          processor,
          'prepare',
          step.stepId,
          step.ownerToken,
          job.id,
          'prepare',
          { ready: true },
          { runId: run.id, stage: 'preparing' },
          'planning',
        );
        await resumeSavedJob(this.workflow, job.id, processor);
      } catch (error) {
        const code =
          error instanceof Error && error.message === 'A source attachment changed before snapshotting'
            ? 'SOURCE_CHANGED'
            : 'SOURCE_ACCESS_DENIED';
        await failRun(this.workflow, run, processor.execution.id, code, step.stepId, job.id);
        await resumeSavedJob(this.workflow, job.id, processor);
      } finally {
        abort.dispose();
      }
    };
    finish().catch((error: unknown) => {
      processor.logger.error('Build Guide source snapshot could not be recorded', {
        errorName: error instanceof Error ? error.name : 'Error',
      });
    });
  }

  async resume(_node: FlowNodeModel, job: IJob, processor: Processor): Promise<IJob | void> {
    if (job.status === JOB_STATUS.PENDING) {
      await processor.exit();
      return;
    }
    const canContinue = await hasUnconsumedLinearCheckpoint(this.workflow, processor, job, 'prepare', 'prepare');
    if (!canContinue) {
      await processor.exit(true);
      return;
    }
    return job;
  }
}

export class GuideLlmInstruction extends Instruction {
  async run(node: FlowNodeModel, input: unknown, processor: Processor) {
    const run = await loadRun(this.workflow, processor);
    const mode = node.config.mode;
    if (mode !== 'plan' && mode !== 'chapter') throw new Error('Invalid managed LLM instruction mode');
    const chapterKeyValue: unknown =
      mode === 'chapter' ? processor.getParsedValue(node.config.chapterKey, node.id) : null;
    const requestedChapterKey = typeof chapterKeyValue === 'string' ? chapterKeyValue : null;
    if (mode === 'chapter' && !requestedChapterKey) throw new Error('Invalid chapter key');
    const stepKey = mode === 'plan' ? 'plan' : `chapter:${requestedChapterKey}`;
    const job = processor.saveJob({
      status: JOB_STATUS.PENDING,
      nodeId: node.id,
      nodeKey: node.key,
      upstreamId: isRecord(input) && id(input.id) ? input.id : null,
      result: { runId: run.id, stage: mode, ...(requestedChapterKey ? { chapterKey: requestedChapterKey } : {}) },
    });
    const claim = await claimStep(this.workflow, run, processor, stepKey, job);
    if (claim.kind === 'completed') {
      const result =
        mode === 'plan' && isRecord(claim.payload)
          ? { runId: run.id, chapterKeys: claim.payload.chapterKeys }
          : { runId: run.id, chapterKey: requestedChapterKey };
      job.set({ status: JOB_STATUS.RESOLVED, result });
      return job;
    }
    if (claim.kind !== 'owned') {
      job.set({ status: JOB_STATUS.ERROR, result: { runId: run.id, errorCode: 'UNKNOWN_OUTCOME' } });
      await failRun(this.workflow, run, processor.execution.id, 'UNKNOWN_OUTCOME');
      return job;
    }
    const abort = createRunAbortHandle(this.workflow, run.id, processor);
    await processor.exit();
    const finish = async () => {
      try {
        const domain = guideDomain(this.workflow.app);
        const inputArtifact = await this.workflow.db.getRepository('aiBuildGuideRunArtifacts').findOne({
          filter: { runId: run.id, artifactKey: 'source-snapshot' },
        });
        const snapshot = inputArtifact?.get('payload') as InputSnapshot | undefined;
        if (!snapshot || typeof snapshot.documentsText !== 'string') throw new Error('SOURCE_ACCESS_DENIED');
        let provider: Provider;
        try {
          provider = (await domain.getLLMProvider(this.workflow.app, snapshot.llmService, snapshot.model)) as Provider;
        } catch (_error) {
          throw new Error('PROVIDER_UNAVAILABLE');
        }
        const promptSpace = { get: (key?: string) => (key ? snapshot[key as keyof InputSnapshot] : snapshot) };
        if (mode === 'plan') {
          const response = await provider.chatModel.invoke(
            [
              new SystemMessage(snapshot.systemPrompt),
              new HumanMessage(
                `Create exactly ${snapshot.targetChapterCount} distinct, user-facing chapters for a guide titled "${snapshot.title}". Return only JSON with title and chapters containing title, goal, and sourceHints. Guidance: ${snapshot.chapterGuidance}\nSource documents:\n${snapshot.documentsText}`,
              ),
            ],
            { signal: abort.signal },
          );
          abort.throwIfAborted();
          const plan = domain.normalizePlan(
            domain.toPlainText(isRecord(response) ? response.content : response),
            snapshot.title || 'User guide',
            snapshot.targetChapterCount,
          );
          if (!plan.chapters.length || plan.chapters.length !== snapshot.targetChapterCount)
            throw new Error('INVALID_PLAN');
          const keys = plan.chapters.map((_chapter, index) => chapterKey(index));
          await savePrivateResult(
            this.workflow,
            run,
            processor,
            stepKey,
            claim.stepId,
            claim.ownerToken,
            job.id,
            'plan',
            { plan, chapterKeys: keys },
            { runId: run.id, chapterKeys: keys },
            'writing_chapter',
            0,
          );
          await this.workflow.db.getRepository('aiBuildGuideRuns').update({
            filterByTk: run.id,
            values: { expectedCount: keys.length },
          });
        } else {
          const planArtifact = await this.workflow.db.getRepository('aiBuildGuideRunArtifacts').findOne({
            filter: { runId: run.id, artifactKey: 'plan' },
          });
          const planPayload: unknown = planArtifact?.get('payload');
          const plan = readPlan(isRecord(planPayload) ? planPayload.plan : null);
          const chapterMatch = requestedChapterKey ? /^chapter-(\d+)$/.exec(requestedChapterKey) : null;
          const index = chapterMatch ? Number(chapterMatch[1]) - 1 : -1;
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= plan.chapters.length ||
            requestedChapterKey !== chapterKeyFor(index)
          ) {
            throw new Error('INVALID_PLAN');
          }
          const chapter = plan.chapters[index];
          const markdown = await domain.buildPageMarkdown(
            provider,
            promptSpace,
            plan,
            chapter,
            snapshot.documentsText,
            { signal: abort.signal },
          );
          abort.throwIfAborted();
          const html = await domain.markdownToCleanHtml(markdown);
          const slug = domain.slugify(chapter.title, `chapter-${index + 1}`);
          const { metadata, searchText } = domain.createGuideSearchMetadata({
            chapter,
            guideTitle: plan.title || snapshot.title,
            markdown,
            slug,
          });
          const payload = {
            status: 'completed',
            chapterKey: requestedChapterKey,
            sort: index + 1,
            title: chapter.title,
            slug,
            goal: chapter.goal,
            planItem: chapter,
            generatedMarkdown: markdown,
            generatedHtml: html,
            searchMetadata: metadata,
            searchText,
          };
          const completedCount = await this.workflow.db.getRepository('aiBuildGuideRunArtifacts').count({
            filter: { runId: run.id, artifactKey: { $like: 'chapter:%' } },
          });
          await savePrivateResult(
            this.workflow,
            run,
            processor,
            stepKey,
            claim.stepId,
            claim.ownerToken,
            job.id,
            `chapter:${requestedChapterKey}`,
            payload,
            { runId: run.id, chapterKey: requestedChapterKey },
            'writing_chapter',
            Number(completedCount) + 1,
          );
        }
        await resumeSavedJob(this.workflow, job.id, processor);
      } catch (error) {
        const code =
          error instanceof Error && error.message === 'PROVIDER_UNAVAILABLE'
            ? 'PROVIDER_UNAVAILABLE'
            : error instanceof Error && error.message === 'INVALID_PLAN'
              ? 'INVALID_PLAN'
              : error instanceof Error && error.message === 'SOURCE_ACCESS_DENIED'
                ? 'SOURCE_ACCESS_DENIED'
                : 'UNKNOWN_OUTCOME';
        await failRun(this.workflow, run, processor.execution.id, code, claim.stepId, job.id);
        await resumeSavedJob(this.workflow, job.id, processor);
      } finally {
        abort.dispose();
      }
    };
    finish().catch((error: unknown) => {
      processor.logger.error('Build Guide LLM result could not be recorded', {
        errorName: error instanceof Error ? error.name : 'Error',
      });
    });
  }

  async resume(_node: FlowNodeModel, job: IJob, processor: Processor): Promise<IJob | void> {
    if (job.status === JOB_STATUS.PENDING) {
      await processor.exit();
      return;
    }
    if (_node.config.mode === 'plan' && job.status === JOB_STATUS.RESOLVED) {
      const canContinue = await hasUnconsumedLinearCheckpoint(this.workflow, processor, job, 'plan', 'plan');
      if (!canContinue) {
        await processor.exit(true);
        return;
      }
      return job;
    }
    if (_node.config.mode !== 'chapter' || job.status !== JOB_STATUS.RESOLVED) return job;
    const jobResult: unknown = job.result;
    const chapterKey = isRecord(jobResult) && typeof jobResult.chapterKey === 'string' ? jobResult.chapterKey : null;
    const chapterMatch = chapterKey ? /^chapter-(\d+)$/.exec(chapterKey) : null;
    const index = chapterMatch ? Number(chapterMatch[1]) - 1 : -1;
    const runId = isRecord(jobResult) && id(jobResult.runId) ? jobResult.runId : null;
    const upstreamJobId = id(job.upstreamId) ? job.upstreamId : null;
    if (index < 0 || runId == null || upstreamJobId == null) {
      await processor.exit(true);
      return;
    }
    const loopNode = await this.workflow.db.getRepository('flow_nodes').findOne({
      filter: { workflowId: processor.execution.workflowId, key: 'guide_chapters' },
    });
    const currentRun = await this.workflow.db.getRepository('aiBuildGuideRuns').findOne({
      filter: {
        id: runId,
        engine: 'workflow',
        status: 'running',
        executionId: String(processor.execution.id),
      },
    });
    const loopJob = await this.workflow.db.getRepository('jobs').findOne({ filterByTk: upstreamJobId });
    const step = await this.workflow.db.getRepository('aiBuildGuideRunSteps').findOne({
      filter: {
        runId,
        stepKey: `chapter:${chapterKey}`,
        executionId: String(processor.execution.id),
        jobId: String(job.id),
        status: 'completed',
      },
    });
    const loopResult: unknown = loopJob?.get('result');
    const artifactKey = step?.get('artifactKey');
    const artifact =
      typeof artifactKey === 'string'
        ? await this.workflow.db.getRepository('aiBuildGuideRunArtifacts').findOne({ filter: { runId, artifactKey } })
        : null;
    const isCurrentIteration = Boolean(
      loopNode &&
        loopJob &&
        String(loopJob.get('executionId')) === String(processor.execution.id) &&
        String(loopJob.get('nodeId')) === String(loopNode.id) &&
        loopJob.status === JOB_STATUS.PENDING &&
        isRecord(loopResult) &&
        loopResult.looped === index &&
        step &&
        typeof step.get('ownerToken') === 'string' &&
        currentRun &&
        artifact,
    );
    if (!isCurrentIteration) {
      await processor.exit(true);
      return;
    }
    return job;
  }
}

export class GuidePublishInstruction extends Instruction {
  async run(node: FlowNodeModel, input: unknown, processor: Processor) {
    const run = await loadRun(this.workflow, processor);
    const job = processor.saveJob({
      status: JOB_STATUS.PENDING,
      nodeId: node.id,
      nodeKey: node.key,
      upstreamId: isRecord(input) && id(input.id) ? input.id : null,
      result: { runId: run.id, stage: 'publishing' },
    });
    const claim = await claimStep(this.workflow, run, processor, 'publish', job);
    if (claim.kind === 'completed') {
      job.set({ status: JOB_STATUS.RESOLVED, result: { runId: run.id, stage: 'completed' } });
      return job;
    }
    if (claim.kind !== 'owned') {
      job.set({ status: JOB_STATUS.ERROR, result: { runId: run.id, errorCode: 'PUBLISH_FAILED' } });
      await failRun(this.workflow, run, processor.execution.id, 'PUBLISH_FAILED');
      return job;
    }
    await setStage(this.workflow, run, 'publishing', 'Publishing completed guide');
    await processor.exit();
    await publishCheckpoint(this.workflow, run, processor, job.id, claim.stepId, claim.ownerToken);
  }

  async resume(_node: FlowNodeModel, job: IJob, processor: Processor): Promise<IJob | void> {
    if (job.status !== JOB_STATUS.PENDING) return job;
    const run = await loadRun(this.workflow, processor);
    const jobId = id(job.id) ? job.id : null;
    if (jobId == null) {
      await processor.exit(true);
      return;
    }
    await processor.exit();
    const checkpoint = await this.workflow.db.getRepository('aiBuildGuideRunSteps').findOne({
      filter: {
        runId: run.id,
        stepKey: 'publish',
        executionId: String(processor.execution.id),
        jobId: String(jobId),
        status: 'running',
      },
    });
    if (!checkpoint || typeof checkpoint.get('ownerToken') !== 'string') return;
    await publishCheckpoint(
      this.workflow,
      run,
      processor,
      jobId,
      checkpoint.get('id') as ID,
      checkpoint.get('ownerToken') as string,
    );
    return;
  }
}

function chapterKeyFor(index: number) {
  return chapterKey(index);
}
