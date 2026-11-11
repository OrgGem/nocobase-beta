/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { LLMProviderMeta } from '@nocobase/plugin-ai';
import { LLMProvider } from '@nocobase/plugin-ai';
import { getApp } from '@nocobase/plugin-workflow-test';
import type { MockServer } from '@nocobase/test';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import { JOB_STATUS } from '@nocobase/plugin-workflow';
import PluginBuildGuideBlockServer from '../../../../plugin-build-guide-block/src/server/plugin';
import PluginWorkflowBuildGuideServer from '../plugin';
import { vi } from 'vitest';

const llmService = 'build-guide-native-test-llm';
const llmModel = 'build-guide-native-test-model';
const providerCalls: string[] = [];
const providerDiagnostics: string[] = [];
let failNextPlan = false;
type Deferred = { promise: Promise<void>; resolve: () => void };
type PlanGate = { started: Deferred; release: Deferred };
let nextPlanGate: PlanGate | null = null;

function createDeferred(): Deferred {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

function gateNextPlan(): PlanGate {
  const gate = { started: createDeferred(), release: createDeferred() };
  nextPlanGate = gate;
  return gate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function promptText(input: unknown): string {
  if (!Array.isArray(input)) return String(input);
  return input
    .map((message) => (isRecord(message) && typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

class DeterministicGuideProvider extends LLMProvider {
  createModel() {
    providerDiagnostics.push('model-created');
    return {
      invoke: async (input: unknown) => {
        providerDiagnostics.push('model-invoked');
        const prompt = promptText(input);
        if (prompt.includes('Create exactly') && prompt.includes('distinct, user-facing chapters')) {
          providerCalls.push('plan');
          const gate = nextPlanGate;
          if (gate) {
            nextPlanGate = null;
            providerDiagnostics.push('plan-blocked');
            gate.started.resolve();
            await gate.release.promise;
            providerDiagnostics.push('plan-released');
          }
          if (failNextPlan) {
            failNextPlan = false;
            throw new Error('PROVIDER_UNAVAILABLE');
          }
          return {
            content: JSON.stringify({
              title: 'Native workflow fixture',
              chapters: [
                { title: 'First chapter', goal: 'Complete the first user task.', sourceHints: [] },
                { title: 'Second chapter', goal: 'Complete the second user task.', sourceHints: [] },
              ],
            }),
          };
        }
        if (prompt.includes('Write one chapter for a user guide')) {
          const title = prompt.match(/Chapter to write:\s*\{\s*"title":\s*"([^"]+)"/)?.[1];
          if (!title) throw new Error('Chapter title missing from test prompt');
          providerCalls.push(`chapter:${title}`);
          return { content: `## ${title}\n\nDeterministic content for ${title}.` };
        }
        throw new Error('Unexpected deterministic provider prompt');
      },
    };
  }
}

async function waitForValue<T>(
  load: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    const value = await load();
    lastValue = value;
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

describe('Build Guide managed native Workflow execution', () => {
  let app: MockServer;

  beforeAll(async () => {
    providerCalls.length = 0;
    providerDiagnostics.length = 0;
    failNextPlan = false;
    app = await getApp({
      acl: true,
      skipSupervisor: true,
      plugins: [
        'ai',
        'workflow-loop',
        [PluginBuildGuideBlockServer, { name: 'plugin-build-guide-block' }],
        [PluginWorkflowBuildGuideServer, { name: 'plugin-workflow-build-guide' }],
      ],
    });
    const aiPlugin = app.pm.get('ai') as unknown as {
      aiManager: { llmProviders: Map<string, LLMProviderMeta> };
    };
    aiPlugin.aiManager.llmProviders.set('build-guide-native-test-provider', {
      title: 'Build Guide native workflow test provider',
      provider: DeterministicGuideProvider,
    });
    await app.db.getRepository('llmServices').create({
      values: {
        name: llmService,
        title: 'Build Guide native workflow test LLM',
        provider: 'build-guide-native-test-provider',
        options: {},
        enabled: true,
        enabledModels: { mode: 'custom', models: [{ value: llmModel, label: 'Deterministic Build Guide' }] },
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.destroy();
  });

  it('builds and publishes two chapters through the native loop workflow', async () => {
    const admin = await app.db.getRepository('users').findOne();
    if (!admin) throw new Error('The disposable test database has no root user');
    const agent = await app.agent().loginUsingId(admin.id);

    const setup = await agent.resource('workflowBuildGuide').setup();
    expect(setup.status).toBe(200);
    expect(setup.body.data).toMatchObject({ enabled: true, blockers: [] });

    const space = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: {
        title: 'Native workflow fixture',
        engine: 'workflow',
        llmService,
        model: llmModel,
        systemPrompt: 'PRIVATE-PROMPT-MUST-NOT-LEAK',
        outputFormat: 'markdown',
        targetChapterCount: 2,
        chapterGuidance: 'Cover the two fixture tasks.',
        status: 'draft',
      },
    });
    const spaceId = String(space.get('id'));
    const build = await agent.resource('aiBuildGuideSpaces').build({ filterByTk: spaceId });
    expect(build.status).toBe(200);
    const runId: unknown = build.body.data?.runId;
    expect(typeof runId).toBe('string');

    const runRecord = await waitForValue(
      async () => {
        const record = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
        return record
          ? {
              status: String(record.get('status')),
              stage: String(record.get('stage')),
              executionId: record.get('executionId'),
              workflowRevisionId: String(record.get('workflowRevisionId')),
            }
          : null;
      },
      (record) => record !== null && ['completed', 'failed'].includes(record.status),
      'native Build Guide run to finish',
      20_000,
    ).catch(async (error: unknown) => {
      const currentRun = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
      const steps = await app.db.getRepository('aiBuildGuideRunSteps').find({ filter: { runId } });
      const executions = currentRun
        ? await app.db
            .getRepository('executions')
            .find({ filter: { workflowId: currentRun.get('workflowRevisionId') }, sort: ['-id'], limit: 3 })
        : [];
      const jobs = await Promise.all(
        executions.map((execution) =>
          app.db.getRepository('jobs').find({ filter: { executionId: execution.id }, sort: ['id'] }),
        ),
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; run=${JSON.stringify({
          status: currentRun?.get('status'),
          stage: currentRun?.get('stage'),
          executionId: currentRun?.get('executionId'),
        })}; executions=${JSON.stringify(
          executions.map((execution) => ({
            id: execution.id,
            status: execution.get('status'),
            context: execution.get('context'),
          })),
        )}; jobs=${JSON.stringify(
          jobs.flat().map((job) => ({
            nodeKey: job.get('nodeKey'),
            status: job.get('status'),
            result: job.get('result'),
          })),
        )}; steps=${JSON.stringify(
          steps.map((step) => ({
            stepKey: step.get('stepKey'),
            status: step.get('status'),
            errorCode: step.get('errorCode'),
          })),
        )}; providerCalls=${JSON.stringify(providerCalls)}; providerDiagnostics=${JSON.stringify(providerDiagnostics)}`,
      );
    });
    expect(runRecord.status).toBe('completed');

    const statusResponse = await agent.resource('aiBuildGuideRuns').getStatus({ filterByTk: runId });
    expect(statusResponse.status).toBe(200);
    const terminal = statusResponse.body.data;
    expect(terminal.status).toBe('completed');
    expect(terminal.engine).toBe('workflow');
    expect(terminal.completedCount).toBe(2);
    expect(terminal.canCancel).toBe(false);
    expect(terminal.canRetry).toBe(false);
    expect(terminal.executionId).toBeTruthy();
    expect(terminal.steps.map((step: { stepKey: string; status: string }) => [step.stepKey, step.status])).toEqual([
      ['prepare', 'completed'],
      ['plan', 'completed'],
      ['chapter:chapter-1', 'completed'],
      ['chapter:chapter-2', 'completed'],
      ['publish', 'completed'],
    ]);

    const publishedSpace = await app.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: spaceId });
    expect(publishedSpace?.get('status')).toBe('completed');
    expect(publishedSpace?.get('published')).toBe(true);
    expect(publishedSpace?.get('publishedRunId')).toBe(runId);
    const pages = await app.db.getRepository('aiBuildGuidePages').find({ filter: { spaceId }, sort: ['sort'] });
    expect(pages.map((page) => page.get('title'))).toEqual(['First chapter', 'Second chapter']);
    expect(pages.every((page) => page.get('published') === true && String(page.get('runId')) === runId)).toBe(true);

    const artifacts = await app.db.getRepository('aiBuildGuideRunArtifacts').find({ filter: { runId }, appends: [] });
    const inputArtifact = artifacts.find((artifact) => artifact.get('artifactKey') === 'input');
    const snapshotArtifact = artifacts.find((artifact) => artifact.get('artifactKey') === 'source-snapshot');
    expect(inputArtifact?.get('payload')).toMatchObject({
      title: 'Native workflow fixture',
      targetChapterCount: 2,
      documents: [],
    });
    expect(snapshotArtifact?.get('payload')).toMatchObject({ documentsText: '' });

    const execution = await app.db.getRepository('executions').findOne({ filterByTk: terminal.executionId });
    const jobs = await app.db.getRepository('jobs').find({ filter: { executionId: terminal.executionId } });
    const executionEvidence = JSON.stringify({
      context: execution?.get('context'),
      jobs: jobs.map((job) => job.get('result')),
    });
    expect(executionEvidence).not.toContain('PRIVATE-PROMPT-MUST-NOT-LEAK');
    expect(executionEvidence).not.toContain('Deterministic content');
    expect(providerCalls).toEqual(['plan', 'chapter:First chapter', 'chapter:Second chapter']);
  }, 120_000);

  it('retries a provider failure after Prepare from the immutable input descriptor', async () => {
    providerCalls.length = 0;
    providerDiagnostics.length = 0;
    failNextPlan = true;

    const admin = await app.db.getRepository('users').findOne();
    if (!admin) throw new Error('The disposable test database has no root user');
    const agent = await app.agent().loginUsingId(admin.id);
    const setup = await agent.resource('workflowBuildGuide').setup();
    expect(setup.status).toBe(200);
    expect(setup.body.data).toMatchObject({ enabled: true, blockers: [] });

    const space = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: {
        title: 'Retry fixture guide',
        engine: 'workflow',
        llmService,
        model: llmModel,
        systemPrompt: 'PRIVATE-RETRY-PROMPT-MUST-NOT-LEAK',
        outputFormat: 'markdown',
        targetChapterCount: 2,
        chapterGuidance: 'Cover the two fixture tasks.',
        status: 'draft',
      },
    });
    const spaceId = String(space.get('id'));
    const firstBuild = await agent.resource('aiBuildGuideSpaces').build({ filterByTk: spaceId });
    expect(firstBuild.status).toBe(200);
    const failedRunId: unknown = firstBuild.body.data?.runId;
    expect(typeof failedRunId).toBe('string');

    const failedRun = await waitForValue(
      async () => {
        const record = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: failedRunId });
        return record
          ? {
              status: String(record.get('status')),
              stage: String(record.get('stage')),
              errorCode: String(record.get('errorCode')),
            }
          : null;
      },
      (run) => run !== null && run.status === 'failed',
      'provider failure to be recorded safely',
      20_000,
    );
    expect(failedRun).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_UNAVAILABLE' });
    expect(providerCalls).toEqual(['plan']);

    const failedStatus = await agent.resource('aiBuildGuideRuns').getStatus({ filterByTk: failedRunId });
    expect(failedStatus.status).toBe(200);
    expect(failedStatus.body.data).toMatchObject({
      status: 'failed',
      stage: 'failed',
      errorCode: 'PROVIDER_UNAVAILABLE',
      canCancel: false,
      canRetry: true,
    });
    expect(
      failedStatus.body.data.steps.map((step: { stepKey: string; status: string }) => [step.stepKey, step.status]),
    ).toEqual([
      ['prepare', 'completed'],
      ['plan', 'failed'],
    ]);

    const failedArtifacts = await app.db
      .getRepository('aiBuildGuideRunArtifacts')
      .find({ filter: { runId: failedRunId }, appends: [] });
    const inputArtifact = failedArtifacts.find((artifact) => artifact.get('artifactKey') === 'input');
    expect(inputArtifact?.get('payload')).toMatchObject({ documents: [], targetChapterCount: 2 });
    expect(failedArtifacts.some((artifact) => artifact.get('artifactKey') === 'source-snapshot')).toBe(true);
    expect(failedArtifacts.some((artifact) => String(artifact.get('artifactKey')).startsWith('chapter:'))).toBe(false);
    expect(await app.db.getRepository('aiBuildGuidePages').count({ filter: { spaceId } })).toBe(0);
    const failedSpace = await app.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: spaceId });
    expect(failedSpace?.get('published')).toBe(false);

    const retry = await agent.resource('aiBuildGuideRuns').retry({ filterByTk: failedRunId });
    expect(retry.status).toBe(200);
    const retryRunId: unknown = retry.body.data?.runId;
    expect(typeof retryRunId).toBe('string');
    expect(retryRunId).not.toBe(failedRunId);

    const retriedRun = await waitForValue(
      async () => {
        const record = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: retryRunId });
        return record
          ? {
              status: String(record.get('status')),
              stage: String(record.get('stage')),
              errorCode: record.get('errorCode'),
            }
          : null;
      },
      (run) => run !== null && run.status === 'completed',
      'retried native Build Guide run to publish',
      20_000,
    );
    expect(retriedRun.status).toBe('completed');

    const retryStatus = await agent.resource('aiBuildGuideRuns').getStatus({ filterByTk: retryRunId });
    expect(retryStatus.body.data).toMatchObject({
      status: 'completed',
      completedCount: 2,
      canCancel: false,
      canRetry: false,
    });
    expect(
      retryStatus.body.data.steps.map((step: { stepKey: string; status: string }) => [step.stepKey, step.status]),
    ).toEqual([
      ['prepare', 'completed'],
      ['plan', 'completed'],
      ['chapter:chapter-1', 'completed'],
      ['chapter:chapter-2', 'completed'],
      ['publish', 'completed'],
    ]);

    const retryArtifacts = await app.db
      .getRepository('aiBuildGuideRunArtifacts')
      .find({ filter: { runId: retryRunId }, appends: [] });
    const retriedInput = retryArtifacts.find((artifact) => artifact.get('artifactKey') === 'input');
    const retriedSnapshot = retryArtifacts.find((artifact) => artifact.get('artifactKey') === 'source-snapshot');
    expect(retriedInput?.get('payload')).toEqual(inputArtifact?.get('payload'));
    expect(retriedSnapshot?.get('payload')).toMatchObject({ documentsText: '' });
    expect(retryArtifacts.some((artifact) => artifact.get('artifactKey') === 'plan')).toBe(true);
    expect(
      retryArtifacts.filter((artifact) => String(artifact.get('artifactKey')).startsWith('chapter:')),
    ).toHaveLength(2);

    const pages = await app.db.getRepository('aiBuildGuidePages').find({ filter: { spaceId }, sort: ['sort'] });
    expect(pages.map((page) => page.get('title'))).toEqual(['First chapter', 'Second chapter']);
    expect(pages.every((page) => String(page.get('runId')) === retryRunId && page.get('published') === true)).toBe(
      true,
    );
    const publishedSpace = await app.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: spaceId });
    expect(publishedSpace?.get('published')).toBe(true);
    expect(publishedSpace?.get('publishedRunId')).toBe(retryRunId);
    expect(providerCalls).toEqual(['plan', 'plan', 'chapter:First chapter', 'chapter:Second chapter']);
  }, 120_000);

  it('reconciles a completed Prepare checkpoint when the resume notification is lost', async () => {
    providerCalls.length = 0;
    providerDiagnostics.length = 0;
    failNextPlan = false;

    const admin = await app.db.getRepository('users').findOne();
    if (!admin) throw new Error('The disposable test database has no root user');
    const agent = await app.agent().loginUsingId(admin.id);
    const setup = await agent.resource('workflowBuildGuide').setup();
    expect(setup.status).toBe(200);

    const space = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: {
        title: 'Lost resume fixture',
        engine: 'workflow',
        llmService,
        model: llmModel,
        systemPrompt: 'PRIVATE-RESUME-PROMPT-MUST-NOT-LEAK',
        outputFormat: 'markdown',
        targetChapterCount: 2,
        chapterGuidance: 'Cover the two fixture tasks.',
        status: 'draft',
      },
    });
    const spaceId = String(space.get('id'));
    const workflow = app.pm.get('workflow') as WorkflowPlugin;
    const originalResume = workflow.resume.bind(workflow);
    let droppedResume = false;
    const resumeSpy = vi.spyOn(workflow, 'resume').mockImplementation(async (job) => {
      if (!droppedResume) {
        droppedResume = true;
        throw new Error('Injected lost resume notification');
      }
      await originalResume(job);
    });
    try {
      const build = await agent.resource('aiBuildGuideSpaces').build({ filterByTk: spaceId });
      expect(build.status).toBe(200);
      const runId: unknown = build.body.data?.runId;
      expect(typeof runId).toBe('string');

      const checkpoint = await waitForValue(
        async () => {
          const run = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
          const step = await app.db
            .getRepository('aiBuildGuideRunSteps')
            .findOne({ filter: { runId, stepKey: 'prepare' } });
          const job = step ? await app.db.getRepository('jobs').findOne({ filterByTk: step.get('jobId') }) : null;
          return {
            droppedResume,
            runStatus: run?.get('status'),
            stepStatus: step?.get('status'),
            jobStatus: job?.get('status'),
          };
        },
        (state) => state.droppedResume && state.stepStatus === 'completed' && state.jobStatus === JOB_STATUS.RESOLVED,
        'Prepare checkpoint after a lost resume notification',
      );
      expect(checkpoint.runStatus).toBe('running');
      expect(providerCalls).toEqual([]);

      const adapter = app.pm.get('plugin-workflow-build-guide') as unknown as { reconcile: () => Promise<void> };
      await adapter.reconcile();

      const completed = await waitForValue(
        async () => {
          const run = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
          return run ? String(run.get('status')) : 'missing';
        },
        (status) => status === 'completed' || status === 'failed' || status === 'unknown',
        'reconciled Build Guide run to finish',
        20_000,
      );
      expect(completed).toBe('completed');
      expect(providerCalls).toEqual(['plan', 'chapter:First chapter', 'chapter:Second chapter']);
      expect(await app.db.getRepository('aiBuildGuidePages').count({ filter: { spaceId } })).toBe(2);
    } finally {
      resumeSpy.mockRestore();
    }
  }, 120_000);

  it.each(['prepare', 'plan'] as const)(
    'does not duplicate the native graph after concurrent %s resume signals',
    async (resumeBoundary) => {
      providerCalls.length = 0;
      providerDiagnostics.length = 0;
      failNextPlan = false;

      const admin = await app.db.getRepository('users').findOne();
      if (!admin) throw new Error('The disposable test database has no root user');
      const agent = await app.agent().loginUsingId(admin.id);
      const setup = await agent.resource('workflowBuildGuide').setup();
      expect(setup.status).toBe(200);

      const space = await app.db.getRepository('aiBuildGuideSpaces').create({
        values: {
          title: `Duplicate ${resumeBoundary} resume fixture`,
          engine: 'workflow',
          llmService,
          model: llmModel,
          systemPrompt: 'PRIVATE-DUPLICATE-BOUNDARY-PROMPT-MUST-NOT-LEAK',
          outputFormat: 'markdown',
          targetChapterCount: 2,
          chapterGuidance: 'Cover the two fixture tasks.',
          status: 'draft',
        },
      });
      const spaceId = String(space.get('id'));
      const workflow = app.pm.get('workflow') as WorkflowPlugin;
      const originalResume = workflow.resume.bind(workflow);
      let runId: string | undefined;
      let duplicatedResume = false;
      const resumeSpy = vi.spyOn(workflow, 'resume').mockImplementation(async (job) => {
        const result: unknown = job.result;
        const matchesBoundary =
          isRecord(result) &&
          result.runId === runId &&
          (resumeBoundary === 'prepare' ? result.stage === 'preparing' : Array.isArray(result.chapterKeys));
        if (matchesBoundary && !duplicatedResume) {
          duplicatedResume = true;
          await Promise.all([originalResume(job), originalResume(job)]);
          return;
        }
        await originalResume(job);
      });
      try {
        const build = await agent.resource('aiBuildGuideSpaces').build({ filterByTk: spaceId });
        expect(build.status).toBe(200);
        const runIdValue: unknown = build.body.data?.runId;
        expect(typeof runIdValue).toBe('string');
        runId = runIdValue;

        const completed = await waitForValue(
          async () => {
            const run = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
            return run ? String(run.get('status')) : 'missing';
          },
          (status) => status === 'completed' || status === 'failed' || status === 'unknown',
          `duplicate ${resumeBoundary} resume run to finish`,
          20_000,
        );
        expect(completed).toBe('completed');
        expect(duplicatedResume).toBe(true);
        expect(providerCalls).toEqual(['plan', 'chapter:First chapter', 'chapter:Second chapter']);
        const pages = await app.db.getRepository('aiBuildGuidePages').find({ filter: { spaceId }, sort: ['sort'] });
        expect(pages).toHaveLength(2);
        expect(pages.map((page) => page.get('title'))).toEqual(['First chapter', 'Second chapter']);
        expect(pages.every((page) => String(page.get('runId')) === runId)).toBe(true);
      } finally {
        resumeSpy.mockRestore();
      }
    },
  );

  it('ignores a duplicate resume signal for a completed chapter loop iteration', async () => {
    providerCalls.length = 0;
    providerDiagnostics.length = 0;
    failNextPlan = false;

    const admin = await app.db.getRepository('users').findOne();
    if (!admin) throw new Error('The disposable test database has no root user');
    const agent = await app.agent().loginUsingId(admin.id);
    const setup = await agent.resource('workflowBuildGuide').setup();
    expect(setup.status).toBe(200);

    const space = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: {
        title: 'Duplicate resume fixture',
        engine: 'workflow',
        llmService,
        model: llmModel,
        systemPrompt: 'PRIVATE-DUPLICATE-PROMPT-MUST-NOT-LEAK',
        outputFormat: 'markdown',
        targetChapterCount: 2,
        chapterGuidance: 'Cover the two fixture tasks.',
        status: 'draft',
      },
    });
    const spaceId = String(space.get('id'));
    const workflow = app.pm.get('workflow') as WorkflowPlugin;
    const originalResume = workflow.resume.bind(workflow);
    let runId: string | undefined;
    let duplicatedChapterResume = false;
    const resumeSpy = vi.spyOn(workflow, 'resume').mockImplementation(async (job) => {
      const result: unknown = job.result;
      const isFirstChapter =
        isRecord(result) && result.runId === runId && result.chapterKey === 'chapter-1' && !duplicatedChapterResume;
      if (isFirstChapter) {
        duplicatedChapterResume = true;
        await Promise.all([originalResume(job), originalResume(job)]);
        return;
      }
      await originalResume(job);
    });
    try {
      const build = await agent.resource('aiBuildGuideSpaces').build({ filterByTk: spaceId });
      expect(build.status).toBe(200);
      const runIdValue: unknown = build.body.data?.runId;
      expect(typeof runIdValue).toBe('string');
      runId = runIdValue;

      const completed = await waitForValue(
        async () => {
          const run = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
          return run ? String(run.get('status')) : 'missing';
        },
        (status) => status === 'completed' || status === 'failed' || status === 'unknown',
        'duplicate-resume Build Guide run to finish',
        20_000,
      );
      expect(completed).toBe('completed');
      expect(duplicatedChapterResume).toBe(true);
      expect(providerCalls).toEqual(['plan', 'chapter:First chapter', 'chapter:Second chapter']);
      const pages = await app.db.getRepository('aiBuildGuidePages').find({ filter: { spaceId }, sort: ['sort'] });
      expect(pages).toHaveLength(2);
      expect(pages.map((page) => page.get('title'))).toEqual(['First chapter', 'Second chapter']);
      expect(pages.every((page) => String(page.get('runId')) === runId)).toBe(true);
    } finally {
      resumeSpy.mockRestore();
    }
  }, 120_000);

  it('cancels a pending native build over HTTP and fences the late provider result', async () => {
    providerCalls.length = 0;
    providerDiagnostics.length = 0;
    failNextPlan = false;

    const admin = await app.db.getRepository('users').findOne();
    if (!admin) throw new Error('The disposable test database has no root user');
    const manager = await app.agent().loginUsingId(admin.id);
    const setup = await manager.resource('workflowBuildGuide').setup();
    expect(setup.status).toBe(200);
    const space = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: {
        title: 'Pending cancellation fixture',
        engine: 'workflow',
        llmService,
        model: llmModel,
        systemPrompt: 'PRIVATE-CANCEL-PROMPT-MUST-NOT-LEAK',
        outputFormat: 'markdown',
        targetChapterCount: 2,
        chapterGuidance: 'Cover the two fixture tasks.',
        status: 'draft',
      },
    });
    const spaceId = String(space.get('id'));
    const gate = gateNextPlan();
    try {
      const build = await manager.resource('aiBuildGuideSpaces').build({ filterByTk: spaceId });
      expect(build.status).toBe(200);
      const runId: unknown = build.body.data?.runId;
      expect(typeof runId).toBe('string');
      await waitForValue(
        async () => providerDiagnostics.includes('plan-blocked'),
        Boolean,
        'native plan provider call to pause before cancellation',
        20_000,
      );

      const runningStatus = await manager.resource('aiBuildGuideRuns').getStatus({ filterByTk: runId });
      expect(runningStatus.status).toBe(200);
      expect(runningStatus.body.data).toMatchObject({ status: 'running', canCancel: true, canRetry: false });
      const cancelStartedAt = Date.now();
      const cancel = await manager.resource('aiBuildGuideRuns').cancel({ filterByTk: runId });
      const cancelDurationMs = Date.now() - cancelStartedAt;
      expect(cancel.status).toBe(200);
      expect(cancelDurationMs).toBeLessThan(5_000);
      expect(cancel.body.data).toEqual({ status: 'cancelled', runId });

      gate.release.resolve();
      await waitForValue(
        async () => providerDiagnostics.includes('plan-released'),
        Boolean,
        'late plan provider result to return after cancellation',
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      const run = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
      const step = await app.db.getRepository('aiBuildGuideRunSteps').findOne({ filter: { runId, stepKey: 'plan' } });
      const currentSpace = await app.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: spaceId });
      expect(run?.get('status')).toBe('cancelled');
      expect(run?.get('errorCode')).toBe('CANCELLED');
      expect(step?.get('status')).toBe('cancelled');
      expect(currentSpace?.get('published')).toBe(false);
      expect(currentSpace?.get('publishedRunId')).toBeFalsy();
      expect(currentSpace?.get('activeRunId')).toBeFalsy();
      expect(await app.db.getRepository('aiBuildGuidePages').count({ filter: { spaceId } })).toBe(0);
      expect(providerCalls).toEqual(['plan']);
    } finally {
      gate.release.resolve();
      nextPlanGate = null;
    }
  }, 120_000);

  it('settles an expired unknown run once without changing a replacement Space owner', async () => {
    providerCalls.length = 0;
    providerDiagnostics.length = 0;
    failNextPlan = false;

    const admin = await app.db.getRepository('users').findOne();
    if (!admin) throw new Error('The disposable test database has no root user');
    const manager = await app.agent().loginUsingId(admin.id);
    const setup = await manager.resource('workflowBuildGuide').setup();
    expect(setup.status).toBe(200);
    const space = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: {
        title: 'Unknown owner fixture',
        engine: 'workflow',
        llmService,
        model: llmModel,
        systemPrompt: 'PRIVATE-UNKNOWN-PROMPT-MUST-NOT-LEAK',
        outputFormat: 'markdown',
        targetChapterCount: 2,
        chapterGuidance: 'Cover the two fixture tasks.',
        status: 'draft',
      },
    });
    const spaceId = String(space.get('id'));
    const gate = gateNextPlan();
    try {
      const build = await manager.resource('aiBuildGuideSpaces').build({ filterByTk: spaceId });
      expect(build.status).toBe(200);
      const runId: unknown = build.body.data?.runId;
      expect(typeof runId).toBe('string');
      await waitForValue(
        async () => providerDiagnostics.includes('plan-blocked'),
        Boolean,
        'native plan provider call before lease expiry',
        20_000,
      );

      const planStep = await app.db
        .getRepository('aiBuildGuideRunSteps')
        .findOne({ filter: { runId, stepKey: 'plan', status: 'running' } });
      if (!planStep) throw new Error('Expected the plan step to be owned while the provider call is held');
      await app.db
        .getCollection('aiBuildGuideRunSteps')
        .model.update(
          { leaseExpiresAt: new Date(Date.now() - 1_000) },
          { where: { id: planStep.get('id'), runId, status: 'running' } },
        );
      const adapter = app.pm.get('plugin-workflow-build-guide') as unknown as { reconcile: () => Promise<void> };
      await adapter.reconcile();
      const unknownRun = await waitForValue(
        async () => {
          const run = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
          return run ? { status: String(run.get('status')), errorCode: run.get('errorCode') } : null;
        },
        (state) => state?.status === 'unknown',
        'expired plan step to settle as unknown',
        20_000,
      );
      expect(unknownRun.errorCode).toBe('UNKNOWN_OUTCOME');

      const replacementOwnerId = `replacement-owner-${Date.now()}`;
      await app.db.getRepository('aiBuildGuideSpaces').update({
        filterByTk: spaceId,
        values: {
          status: 'building',
          buildPhase: 'planning',
          activeRunId: replacementOwnerId,
          buildRunId: replacementOwnerId,
        },
      });
      const unknownStatus = await manager.resource('aiBuildGuideRuns').getStatus({ filterByTk: runId });
      expect(unknownStatus.status).toBe(200);
      expect(unknownStatus.body.data).toMatchObject({ status: 'unknown', canCancel: true, canRetry: false });

      const firstCancel = await manager.resource('aiBuildGuideRuns').cancel({ filterByTk: runId });
      expect(firstCancel.status).toBe(200);
      const repeatedCancel = await manager.resource('aiBuildGuideRuns').cancel({ filterByTk: runId });
      expect(repeatedCancel.status).toBe(409);
      const afterCancelSpace = await app.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: spaceId });
      expect(afterCancelSpace?.get('status')).toBe('building');
      expect(afterCancelSpace?.get('activeRunId')).toBe(replacementOwnerId);
      expect(afterCancelSpace?.get('buildRunId')).toBe(replacementOwnerId);

      gate.release.resolve();
      await waitForValue(
        async () => providerDiagnostics.includes('plan-released'),
        Boolean,
        'late plan result to return after unknown cancellation',
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      await adapter.reconcile();

      const finalRun = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
      const finalStep = await app.db
        .getRepository('aiBuildGuideRunSteps')
        .findOne({ filter: { runId, stepKey: 'plan' } });
      const finalSpace = await app.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: spaceId });
      expect(finalRun?.get('status')).toBe('cancelled');
      expect(finalRun?.get('errorCode')).toBe('CANCELLED');
      expect(finalStep?.get('status')).toBe('cancelled');
      expect(finalSpace?.get('status')).toBe('building');
      expect(finalSpace?.get('activeRunId')).toBe(replacementOwnerId);
      expect(finalSpace?.get('buildRunId')).toBe(replacementOwnerId);
      expect(finalSpace?.get('published')).toBe(false);
      expect(finalSpace?.get('publishedRunId')).toBeFalsy();
      expect(await app.db.getRepository('aiBuildGuidePages').count({ filter: { spaceId } })).toBe(0);
      expect(providerCalls).toEqual(['plan']);
    } finally {
      gate.release.resolve();
      nextPlanGate = null;
    }
  }, 120_000);

  it('scopes native execution and job reads to the caller’s accessible Space and blocks retargeted private data', async () => {
    providerCalls.length = 0;
    providerDiagnostics.length = 0;
    failNextPlan = false;

    const admin = await app.db.getRepository('users').findOne();
    if (!admin) throw new Error('The disposable test database has no root user');
    const manager = await app.agent().loginUsingId(admin.id);
    const setup = await manager.resource('workflowBuildGuide').setup();
    expect(setup.status).toBe(200);

    const createAndBuild = async (title: string) => {
      const space = await app.db.getRepository('aiBuildGuideSpaces').create({
        values: {
          title,
          engine: 'workflow',
          llmService,
          model: llmModel,
          systemPrompt: `PRIVATE-${title}-PROMPT-MUST-NOT-LEAK`,
          outputFormat: 'markdown',
          targetChapterCount: 2,
          chapterGuidance: 'Cover the two fixture tasks.',
          status: 'draft',
        },
      });
      const spaceId = String(space.get('id'));
      const build = await manager.resource('aiBuildGuideSpaces').build({ filterByTk: spaceId });
      expect(build.status).toBe(200);
      const runId: unknown = build.body.data?.runId;
      expect(typeof runId).toBe('string');
      const state = await waitForValue(
        async () => {
          const run = await app.db.getRepository('aiBuildGuideRuns').findOne({ filterByTk: runId });
          return run ? String(run.get('status')) : 'missing';
        },
        (status) => status === 'completed' || status === 'failed' || status === 'unknown',
        `${title} workflow run to finish`,
        20_000,
      );
      expect(state).toBe('completed');
      const runStatus = await manager.resource('aiBuildGuideRuns').getStatus({ filterByTk: runId });
      expect(runStatus.status).toBe(200);
      const executionId: unknown = runStatus.body.data?.executionId;
      expect(executionId).toBeTruthy();
      return { spaceId, runId: String(runId), executionId: String(executionId) };
    };

    const own = await createAndBuild('Scoped own guide');
    const foreign = await createAndBuild('Scoped foreign guide');
    const ownPrepareJob = await app.db
      .getRepository('jobs')
      .findOne({ filter: { executionId: own.executionId, nodeKey: 'guide_prepare' } });
    const foreignPrepareJob = await app.db
      .getRepository('jobs')
      .findOne({ filter: { executionId: foreign.executionId, nodeKey: 'guide_prepare' } });
    if (!ownPrepareJob || !foreignPrepareJob) throw new Error('Expected Prepare jobs for both workflow runs');

    await app.db.getRepository('roles').create({ values: { name: 'guide-scope-reader', title: 'Guide scope reader' } });
    const readerUser = await app.db
      .getRepository('users')
      .create({ values: { username: 'guide-scope-reader', roles: ['guide-scope-reader'] } });
    app.acl.define({
      role: 'guide-scope-reader',
      actions: {
        'aiBuildGuideSpaces:get': { filter: { id: own.spaceId } },
        'aiBuildGuideRuns:getStatus': {},
        'aiBuildGuidePages:list': {},
        'aiBuildGuidePages:get': {},
        'executions:get': {},
        'executions:list': {},
        'executions.jobs:list': {},
        'jobs:get': {},
        'jobs:list': {},
        'workflows:get': {},
        'workflows:list': {},
        'workflows.executions:list': {},
        'flow_nodes:get': {},
      },
    });
    const reader = await app.agent().login(readerUser, 'guide-scope-reader');

    const ownRunStatus = await reader.resource('aiBuildGuideRuns').getStatus({ filterByTk: own.runId });
    const foreignRunStatus = await reader.resource('aiBuildGuideRuns').getStatus({ filterByTk: foreign.runId });
    expect(ownRunStatus.status).toBe(200);
    expect([403, 404]).toContain(foreignRunStatus.status);

    const executionList = await reader.resource('executions').list({
      filter: { id: { $in: [Number(own.executionId), Number(foreign.executionId)] } },
      fields: ['id', 'workflowId'],
    });
    expect(executionList.status).toBe(200);
    expect(executionList.body.data.map((record: { id: string | number }) => String(record.id))).toEqual([
      own.executionId,
    ]);
    const ownExecution = await reader.resource('executions').get({
      filterByTk: own.executionId,
      appends: ['jobs', 'jobs.node'],
    });
    expect(ownExecution.status).toBe(200);
    const foreignExecutionWithEmptyPage = await reader.resource('executions').get({
      filterByTk: foreign.executionId,
      limit: 0,
      offset: 1,
    });
    expect([403, 404]).toContain(foreignExecutionWithEmptyPage.status);
    const foreignExecution = await reader.resource('executions').get({ filterByTk: foreign.executionId });
    expect([403, 404]).toContain(foreignExecution.status);
    const foreignExecutionListWithOffset = await reader.resource('executions').list({
      filter: { id: foreign.executionId },
      page: 1,
      pageSize: 1,
      limit: 0,
      offset: 1,
    });
    expect(foreignExecutionListWithOffset.status).toBe(200);
    expect(foreignExecutionListWithOffset.body.data).toHaveLength(0);

    const jobList = await reader.resource('jobs').list({
      filter: { id: { $in: [ownPrepareJob.id, foreignPrepareJob.id] } },
      fields: ['id', 'executionId', 'nodeId'],
    });
    expect(jobList.status).toBe(200);
    expect(jobList.body.data.map((record: { id: string | number }) => String(record.id))).toEqual([
      String(ownPrepareJob.id),
    ]);
    expect((await reader.resource('jobs').get({ filterByTk: ownPrepareJob.id })).status).toBe(200);
    expect([403, 404]).toContain((await reader.resource('jobs').get({ filterByTk: foreignPrepareJob.id })).status);
    const ownJobWithParent = await reader.resource('jobs').get({
      filterByTk: ownPrepareJob.id,
      appends: ['execution'],
    });
    expect(ownJobWithParent.status).toBe(200);
    const foreignJobWithParent = await reader.resource('jobs').get({
      filterByTk: foreignPrepareJob.id,
      appends: ['execution'],
    });
    expect([403, 404]).toContain(foreignJobWithParent.status);

    const managedWorkflowId = String(setup.body.data.workflowId);
    const workflowWithExecutions = await reader.resource('workflows').get({
      filterByTk: managedWorkflowId,
      appends: ['executions', 'executions.jobs'],
      fields: ['id', 'executions.id', 'executions.jobs.id', 'executions.jobs.result'],
    });
    expect(workflowWithExecutions.status).toBe(200);
    expect(JSON.stringify(workflowWithExecutions.body.data)).not.toContain(own.executionId);
    expect(JSON.stringify(workflowWithExecutions.body.data)).not.toContain(foreign.executionId);
    const workflowListWithExecutions = await reader.resource('workflows').list({
      filter: { id: managedWorkflowId },
      appends: ['executions'],
      fields: ['id', 'executions.id'],
    });
    expect(workflowListWithExecutions.status).toBe(200);
    expect(JSON.stringify(workflowListWithExecutions.body.data)).not.toContain(foreign.executionId);
    const workflowListWithIgnoredSelectors = await reader.resource('workflows').list({
      filterByTk: 'ignored-list-filter-by-tk',
      filter: { id: managedWorkflowId },
      page: 1,
      pageSize: 10,
      limit: 0,
      offset: 999,
      appends: ['executions', 'executions.jobs'],
      fields: ['id', 'executions.id', 'executions.jobs.id'],
    });
    expect(workflowListWithIgnoredSelectors.status).toBe(200);
    expect(workflowListWithIgnoredSelectors.body.data).toHaveLength(1);
    expect(workflowListWithIgnoredSelectors.body.data[0]).not.toHaveProperty('executions');
    expect(JSON.stringify(workflowListWithIgnoredSelectors.body.data)).not.toContain(foreign.executionId);
    const workflowExecutionHistory = await reader.resource('workflows.executions', managedWorkflowId).list({
      appends: ['jobs'],
      fields: ['id', 'jobs.id'],
    });
    expect(workflowExecutionHistory.status).toBe(200);
    expect(workflowExecutionHistory.body.data.map((record: { id: string | number }) => String(record.id))).toEqual([
      own.executionId,
    ]);

    const inputArtifact = await app.db
      .getRepository('aiBuildGuideRunArtifacts')
      .findOne({ filter: { runId: own.runId, artifactKey: 'input' } });
    const prepareStep = await app.db
      .getRepository('aiBuildGuideRunSteps')
      .findOne({ filter: { runId: own.runId, stepKey: 'prepare' } });
    if (!inputArtifact || !prepareStep) throw new Error('Expected private run artifacts and steps');
    const retargetedArtifact = await manager.resource('aiBuildGuideSpaces').get({
      filterByTk: inputArtifact.get('id'),
      targetCollection: 'aiBuildGuideRunArtifacts',
      fields: ['id', 'payload'],
    });
    expect(retargetedArtifact.status).not.toBe(200);
    expect(retargetedArtifact.text).not.toContain(`PRIVATE-Scoped own guide-PROMPT-MUST-NOT-LEAK`);
    const retargetedStep = await manager.resource('aiBuildGuidePages').get({
      filterByTk: prepareStep.get('id'),
      targetCollection: 'aiBuildGuideRunSteps',
      fields: ['id', 'stepKey', 'status'],
    });
    expect(retargetedStep.status).not.toBe(200);
    expect(
      (await manager.resource('aiBuildGuideRunArtifacts').list({ targetCollection: 'aiBuildGuideSpaces' })).status,
    ).toBe(403);

    const privatePage = await app.db.getRepository('aiBuildGuidePages').create({
      values: {
        spaceId: own.spaceId,
        runId: own.runId,
        title: 'PRIVATE-UNPUBLISHED-PAGE-MUST-NOT-LEAK',
        slug: 'private-unpublished-page',
        status: 'pending',
        published: false,
        generatedMarkdown: 'PRIVATE-UNPUBLISHED-CONTENT',
      },
    });
    const pageList = await manager.resource('aiBuildGuidePages').list({
      filter: { spaceId: own.spaceId },
      appends: ['space'],
    });
    expect(pageList.status).toBe(200);
    expect(pageList.body.data.map((page: { id: string | number }) => String(page.id))).not.toContain(
      String(privatePage.get('id')),
    );
    expect(pageList.body.data.every((page: Record<string, unknown>) => !('space' in page))).toBe(true);
    const pagesFromSpace = await reader.resource('aiBuildGuideSpaces').get({
      filterByTk: own.spaceId,
      appends: ['pages'],
    });
    expect(pagesFromSpace.status).toBe(200);
    expect(pagesFromSpace.body.data).not.toHaveProperty('pages');
    expect(JSON.stringify(pagesFromSpace.body.data)).not.toContain('PRIVATE-UNPUBLISHED-PAGE-MUST-NOT-LEAK');
    const pageFieldsFromSpace = await reader.resource('aiBuildGuideSpaces').get({
      filterByTk: own.spaceId,
      fields: ['id', 'latestRunId', 'pages.title'],
    });
    expect(pageFieldsFromSpace.status).toBe(200);
    expect(pageFieldsFromSpace.body.data).not.toHaveProperty('pages');
    const directPrivateFieldRead = await reader.resource('aiBuildGuideSpaces').get({
      filterByTk: own.spaceId,
      fields: ['id', 'generatedMarkdown', 'buildLog', 'latestRunId'],
    });
    expect(directPrivateFieldRead.status).toBe(200);
    expect(directPrivateFieldRead.body.data).not.toHaveProperty('generatedMarkdown');
    expect(directPrivateFieldRead.body.data).not.toHaveProperty('buildLog');
    const directPrivateAssociationWrite = await manager.resource('aiBuildGuideSpaces').update({
      filterByTk: own.spaceId,
      values: { pages: [privatePage.get('id')] },
    });
    expect(directPrivateAssociationWrite.status).toBe(403);
    const compoundPrivateAssociationWrite = await manager.resource('aiBuildGuideSpaces').update({
      filterByTk: own.spaceId,
      updateAssociationValues: { pages: [privatePage.get('id')] },
    });
    expect(compoundPrivateAssociationWrite.status).toBe(403);
    const compoundPrivateFieldWrite = await manager.resource('aiBuildGuideSpaces').updateOrCreate({
      filterByTk: own.spaceId,
      values: { activeRunId: foreign.runId },
    });
    expect(compoundPrivateFieldWrite.status).toBe(403);
  }, 120_000);

  it('blocks direct managed workflow mutations and scans the full bulk destroy target set', async () => {
    const admin = await app.db.getRepository('users').findOne();
    if (!admin) throw new Error('The disposable test database has no root user');
    const manager = await app.agent().loginUsingId(admin.id);
    const setup = await manager.resource('workflowBuildGuide').setup();
    expect(setup.status).toBe(200);
    const workflowId = String(setup.body.data.workflowId);
    const node = await app.db.getRepository('flow_nodes').findOne({ filter: { workflowId, key: 'guide_prepare' } });
    const run = await app.db
      .getRepository('aiBuildGuideRuns')
      .findOne({ filter: { engine: 'workflow', workflowRevisionId: workflowId, status: 'completed' } });
    if (!node || !run) throw new Error('Expected a managed workflow node and completed execution fixture');
    const execution = await app.db.getRepository('executions').findOne({ filter: { workflowId } });
    if (!execution) throw new Error('Expected a native execution for the managed workflow');
    const job = await app.db
      .getRepository('jobs')
      .findOne({ filter: { executionId: execution.id, nodeKey: 'guide_prepare' } });
    if (!job) throw new Error('Expected a Prepare job for the managed execution');

    const mutationResponses = [];
    mutationResponses.push(
      await manager.resource('workflows').update({ filterByTk: workflowId, values: { enabled: false } }),
    );
    mutationResponses.push(await manager.resource('workflows').sync({ filterByTk: workflowId }));
    mutationResponses.push(await manager.resource('workflows').revision({ filterByTk: workflowId }));
    mutationResponses.push(
      await manager.resource('workflows').execute({ filterByTk: workflowId, values: { data: {} } }),
    );
    mutationResponses.push(await manager.resource('workflows').destroy({ filterByTk: workflowId }));
    mutationResponses.push(
      await manager.resource('flow_nodes').update({ filterByTk: node.id, values: { title: 'Tampered trigger' } }),
    );
    mutationResponses.push(await manager.resource('executions').rerun({ filterByTk: execution.id }));
    mutationResponses.push(
      await manager.resource('jobs').resume({ filterByTk: job.id, values: { status: JOB_STATUS.RESOLVED } }),
    );
    mutationResponses.push(
      await manager.resource('workflows').updateOrCreate({ filterByTk: workflowId, values: { enabled: false } }),
    );
    expect(mutationResponses.map((response) => response.status)).toEqual(Array(9).fill(403));
    expect(await app.db.getRepository('workflows').findOne({ filterByTk: workflowId })).toBeTruthy();

    const ordinaryWorkflows = await app.db.getRepository('workflows').createMany({
      records: Array.from({ length: 101 }, (_, index) => ({
        key: `bulk-guard-fixture-${index}-${Date.now()}`,
        title: `Bulk guard fixture ${index}`,
        type: 'collection',
        enabled: false,
        config: { collection: 'aiBuildGuideSpaces' },
        options: {},
      })),
    });
    const firstFixtureId = Math.min(...ordinaryWorkflows.map((workflowRecord) => Number(workflowRecord.id)));
    const marker = await app.db.getRepository('workflows').create({
      values: {
        key: `bulk-guard-managed-${Date.now()}`,
        title: 'Managed workflow beyond the first 100 matches',
        type: 'collection',
        enabled: false,
        config: { collection: 'main:aiBuildGuideRuns' },
        options: {},
      },
    });
    const bulkDestroy = await manager.resource('workflows').destroy({ filter: { id: { $gte: firstFixtureId } } });
    expect(bulkDestroy.status).toBe(403);
    expect(await app.db.getRepository('workflows').findOne({ filterByTk: marker.get('id') })).toBeTruthy();

    const activeSpace = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: { title: 'Active space deletion guard', status: 'building', engine: 'workflow' },
    });
    const draftSpace = await app.db.getRepository('aiBuildGuideSpaces').create({
      values: { title: 'Draft space deletion guard', status: 'draft', engine: 'legacy' },
    });
    const mixedSpaceDestroy = await manager.resource('aiBuildGuideSpaces').destroy({
      filter: { id: { $in: [activeSpace.get('id'), draftSpace.get('id')] } },
    });
    expect(mixedSpaceDestroy.status).toBe(403);
    expect(
      await app.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: activeSpace.get('id') }),
    ).toBeTruthy();
    expect(await app.db.getRepository('aiBuildGuideSpaces').findOne({ filterByTk: draftSpace.get('id') })).toBeTruthy();
  }, 120_000);
});
