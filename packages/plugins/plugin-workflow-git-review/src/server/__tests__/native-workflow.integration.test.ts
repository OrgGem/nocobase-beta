/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LLMProviderMeta } from '@nocobase/plugin-ai';
import { LLMProvider } from '@nocobase/plugin-ai';
import { EXECUTION_STATUS, JOB_STATUS } from '@nocobase/plugin-workflow';
import { getApp } from '@nocobase/plugin-workflow-test';
import LockManager from '@nocobase/lock-manager';
import type { MockServer } from '@nocobase/test';
import PluginGitManagerServer from '../../../../plugin-git-manager/src/server/plugin';
import { resolveBackgroundReviewRoles } from '../../../../plugin-git-manager/src/server/actions/review';
import { provision, supportsRuntime } from '../provision';
import PluginWorkflowGitReviewServer from '../plugin';
import { reconcileRequests } from '../reconcile';
import { buildTemplate } from '../templates';
import { assertSafeWorkflow } from '../safe-graph';
import { vi } from 'vitest';

type RecordGetter = { get(name: string): unknown };

type ReviewFixture = {
  repositoryId: number;
  flowId: number;
  workflowId: number;
  headSha: string;
  remoteUrl: string;
};

const structuredReview = {
  verdict: 'no_findings',
  findings: [],
  coverage: { summary: 'All changed lines were reviewed.', limitations: [] },
};

const llmInvocations: Array<{ sessionId?: string; messages: string }> = [];
const pendingJobSnapshots: Array<{ sessionId: string; jobId: number | string | null; status: unknown }> = [];
let providerTestApp: MockServer | undefined;
let nextProviderOutcome: 'resolve' | 'reject' | 'deferred' = 'resolve';
let resolveDeferredProvider: (() => void) | null = null;

function deterministicResponse() {
  return {
    parsed: structuredReview,
    raw: {
      id: `mock-${llmInvocations.length}`,
      content: 'deterministic-provider-review-output',
      additional_kwargs: {},
      response_metadata: { finish_reason: 'stop' },
      tool_calls: [],
    },
  };
}

class DeterministicReviewProvider extends LLMProvider {
  createModel() {
    return null;
  }

  async invoke(context: Parameters<LLMProvider['invoke']>[0]) {
    const sessionId = this.requestContext.sessionId;
    llmInvocations.push({
      sessionId,
      messages: JSON.stringify(context.messages),
    });
    const match = sessionId?.match(/^workflow-(\d+)-(\d+)$/);
    if (!providerTestApp || !match) throw new Error('Expected a native workflow session and test database');
    const job = await providerTestApp.db.getRepository('jobs').findOne({
      filter: { executionId: Number(match[1]), nodeId: Number(match[2]) },
    });
    pendingJobSnapshots.push({
      sessionId,
      jobId: job ? (job.get('id') as number | string) : null,
      status: job?.get('status'),
    });

    const outcome = nextProviderOutcome;
    nextProviderOutcome = 'resolve';
    if (outcome === 'reject') throw new Error('deterministic immediate provider rejection');
    if (outcome === 'deferred') {
      return new Promise((resolve) => {
        resolveDeferredProvider = () => resolve(deterministicResponse());
      });
    }
    return deterministicResponse();
  }
}

function numericId(record: RecordGetter): number {
  const id = Number(record.get('id'));
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Expected a positive database ID');
  return id;
}

function runGit(repositoryPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim();
}

function createLocalRepository(root: string, name: string, remoteUrl: string): string {
  const repositoryPath = join(root, name);
  mkdirSync(repositoryPath);
  execFileSync('git', ['init', '--initial-branch=main', repositoryPath], { stdio: 'ignore' });
  writeFileSync(join(repositoryPath, 'review-fixture.txt'), 'before\n');
  execFileSync(
    'git',
    ['-C', repositoryPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '-A'],
    { stdio: 'ignore' },
  );
  execFileSync(
    'git',
    ['-C', repositoryPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'],
    { stdio: 'ignore' },
  );
  execFileSync('git', ['-C', repositoryPath, 'remote', 'add', 'origin', remoteUrl], { stdio: 'ignore' });
  return runGit(repositoryPath, ['rev-parse', 'HEAD']);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function stubGitLab(): { fetchMock: typeof fetch; postedBodies: string[] } {
  const postedBodies: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method || 'GET').toUpperCase();
    if (url.pathname.endsWith('/user')) return jsonResponse({ id: 501 });
    if (url.pathname.includes('/merge_requests/') && url.pathname.endsWith('/notes')) {
      if (method === 'POST') {
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { body?: unknown }).body : undefined;
        if (typeof body !== 'string') throw new Error('Expected a review note body');
        postedBodies.push(body);
        return jsonResponse({ id: 800 + postedBodies.length });
      }
      return jsonResponse([]);
    }
    if (url.pathname.includes('/merge_requests/')) {
      return jsonResponse({
        iid: Number(url.pathname.split('/').at(-1)),
        sha: 'b'.repeat(40),
        diff_refs: { head_sha: 'b'.repeat(40), base_sha: 'a'.repeat(40) },
        source_branch: 'main',
      });
    }
    if (url.pathname.includes('/repository/compare')) {
      return jsonResponse({
        diffs: [
          { old_path: 'review-fixture.txt', new_path: 'review-fixture.txt', diff: '@@ -1 +1 @@\n-before\n+after' },
        ],
      });
    }
    const projectSegment = url.pathname.match(/\/projects\/([^/]+)/)?.[1];
    if (projectSegment) {
      const project = decodeURIComponent(projectSegment);
      const fullReview = project.includes('full-review');
      return jsonResponse({
        id: fullReview ? 502 : 501,
        web_url: fullReview ? 'https://gitlab.test/group/full-review' : 'https://gitlab.test/group/quick-review',
      });
    }
    throw new Error(`Unexpected test provider request: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock as typeof fetch);
  return { fetchMock: fetchMock as typeof fetch, postedBodies };
}

async function waitForValue<T>(
  load: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('Git review native Workflow execution', () => {
  let app: MockServer;
  let fixtureRoot: string;
  let actorId: number;
  let actorRoles: string[];
  let quick: ReviewFixture;
  let full: ReviewFixture;
  let originalRepoRoot: string | undefined;
  let postedBodies: string[];

  beforeAll(async () => {
    llmInvocations.length = 0;
    pendingJobSnapshots.length = 0;
    fixtureRoot = mkdtempSync(join(tmpdir(), 'git-review-native-workflow-'));
    originalRepoRoot = process.env.GIT_REPOS_BASE_PATH;
    process.env.GIT_REPOS_BASE_PATH = fixtureRoot;
    const quickUrl = 'https://gitlab.test/group/quick-review.git';
    const fullUrl = 'https://gitlab.test/group/full-review.git';
    const quickHead = createLocalRepository(fixtureRoot, 'quick-review', quickUrl);
    const fullHead = createLocalRepository(fixtureRoot, 'full-review', fullUrl);

    app = await getApp({
      plugins: [
        'error-handler',
        'data-source-main',
        'ai',
        'workflow-manual',
        [PluginGitManagerServer, { name: 'git-manager' }],
        [PluginWorkflowGitReviewServer, { name: 'workflow-git-review' }],
      ],
      skipSupervisor: true,
    });
    providerTestApp = app;
    const gitManager = app.pm.get('git-manager') as PluginGitManagerServer;
    gitManager.reviewService.stop();

    const actor = await app.db.getRepository('users').findOne();
    if (!actor) throw new Error('The disposable test database has no review approver');
    actorId = numericId(actor);
    actorRoles = await resolveBackgroundReviewRoles(app.db, actorId);

    const aiPlugin = app.pm.get('ai') as unknown as {
      aiManager: { llmProviders: Map<string, LLMProviderMeta> };
    };
    aiPlugin.aiManager.llmProviders.set('review-test-provider', {
      title: 'Deterministic review test provider',
      provider: DeterministicReviewProvider,
    });

    const account = await app.db.getRepository('gitAccounts').create({
      values: {
        name: 'Native workflow test account',
        provider: 'gitlab',
        baseUrl: 'https://gitlab.test',
        username: 'workflow-test',
        pat: 'test-only-token',
      },
    });
    const accountId = numericId(account);
    const createProject = async (
      name: string,
      localPath: string,
      remoteUrl: string,
      headSha: string,
      workflowKey: string,
      template: 'quick' | 'full',
    ): Promise<ReviewFixture> => {
      const repository = await app.db.getRepository('gitRepositories').create({
        values: { name, repoUrl: remoteUrl, localPath, defaultBranch: 'main', gitAccountId: accountId },
      });
      const repositoryId = numericId(repository);
      const flow = await app.db.getRepository('gitReviewFlows').create({
        values: {
          name: `${template} native workflow`,
          repositoryId,
          enabled: true,
          triggerMode: 'both',
          reviewOnNewCommits: false,
          aiEmployeeUsername: 'native-review-test',
          llmService: 'native-review-test-llm',
          model: 'deterministic-review-model',
          postMode: 'manual',
        },
      });
      const flowId = numericId(flow);
      await app.db
        .getCollection('gitReviewFlows')
        .model.update({ createdById: actorId, workflowKey }, { where: { id: flowId } });
      return { repositoryId, flowId, workflowId: 0, headSha, remoteUrl };
    };

    await app.db.getRepository('llmServices').create({
      values: {
        name: 'native-review-test-llm',
        title: 'Native review test LLM',
        provider: 'review-test-provider',
        options: {},
        enabled: true,
        enabledModels: {
          mode: 'custom',
          models: [{ value: 'deterministic-review-model', label: 'Deterministic review' }],
        },
      },
    });
    await app.db.getRepository('aiEmployees').create({
      values: {
        username: 'native-review-test',
        nickname: 'Review Test',
        about: 'A deterministic review fixture.',
        defaultPrompt: 'Review the supplied source evidence.',
        modelSettings: {
          enabled: true,
          llmService: 'native-review-test-llm',
          model: 'deterministic-review-model',
        },
        enabled: true,
        builtIn: false,
        category: 'business',
      },
    });

    quick = await createProject('Quick Review', 'quick-review', quickUrl, quickHead, 'native-review-quick', 'quick');
    full = await createProject('Full Review', 'full-review', fullUrl, fullHead, 'native-review-full', 'full');
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.destroy();
    providerTestApp = undefined;
    if (originalRepoRoot === undefined) delete process.env.GIT_REPOS_BASE_PATH;
    else process.env.GIT_REPOS_BASE_PATH = originalRepoRoot;
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    nextProviderOutcome = 'resolve';
    const finishDeferredProvider = resolveDeferredProvider;
    resolveDeferredProvider = null;
    finishDeferredProvider?.();
    if (finishDeferredProvider) await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('runs Quick and Full native LLM graphs, holds manual approvals, then executes the queued same-target rerun', async () => {
    expect(supportsRuntime(app)).toBe(true);
    const { postedBodies: outboundBodies } = stubGitLab();
    postedBodies = outboundBodies;

    const quickSetup = await provision(app, { flowId: quick.flowId, template: 'quick', approverIds: [actorId] });
    const fullSetup = await provision(app, { flowId: full.flowId, template: 'full', approverIds: [actorId] });
    expect(quickSetup.blockers).toEqual([]);
    expect(fullSetup.blockers).toEqual([]);
    expect(quickSetup.enabled).toBe(true);
    expect(fullSetup.enabled).toBe(true);

    const initialQuickWorkflowId = Number(quickSetup.workflowId);
    const initialQuickNodes = await app.db.getRepository('flow_nodes').find({
      filter: { workflowId: initialQuickWorkflowId },
      sort: ['id'],
    });
    const idempotentSetup = await provision(app, { flowId: quick.flowId, template: 'quick', approverIds: [actorId] });
    const idempotentNodes = await app.db.getRepository('flow_nodes').find({
      filter: { workflowId: initialQuickWorkflowId },
      sort: ['id'],
    });
    expect(idempotentSetup.workflowId).toBe(initialQuickWorkflowId);
    expect(idempotentNodes.map((node) => node.id)).toEqual(initialQuickNodes.map((node) => node.id));

    const repairedSetup = await provision(app, {
      flowId: quick.flowId,
      template: 'quick',
      approverIds: [actorId],
      createRevision: true,
    });
    expect(repairedSetup.blockers).toEqual([]);
    expect(repairedSetup.enabled).toBe(true);
    expect(repairedSetup.workflowId).not.toBe(initialQuickWorkflowId);
    expect(repairedSetup.workflowKey).toBe(quickSetup.workflowKey);
    quick.workflowId = Number(repairedSetup.workflowId);
    const repairedNodes = await app.db.getRepository('flow_nodes').find({
      filter: { workflowId: quick.workflowId },
      sort: ['id'],
    });
    expect(repairedNodes).toHaveLength(initialQuickNodes.length);
    const boundFlow = await app.db.getRepository('gitReviewFlows').findOne({ filterByTk: quick.flowId });
    expect(boundFlow?.workflowId).toBe(quick.workflowId);
    const oldRevision = await app.db.getRepository('workflows').findOne({ filterByTk: initialQuickWorkflowId });
    const currentRevision = await app.db.getRepository('workflows').findOne({ filterByTk: quick.workflowId });
    expect(oldRevision?.options?.gitReview?.frozen).toBe(true);
    expect(currentRevision?.options?.gitReview?.frozen).toBe(true);

    quick.workflowId = Number(quickSetup.workflowId);
    full.workflowId = Number(fullSetup.workflowId);
    const quickWorkflow = await app.db.getRepository('workflows').findOne({ filterByTk: quick.workflowId });
    const fullWorkflow = await app.db.getRepository('workflows').findOne({ filterByTk: full.workflowId });
    expect(quickWorkflow?.options?.gitReview?.approverIds).toEqual([actorId]);
    expect(typeof quickWorkflow?.options?.gitReview?.approverIds?.[0]).toBe('number');
    await expect(assertSafeWorkflow(app, quick.workflowId, 'manual')).resolves.toBeTruthy();
    await expect(assertSafeWorkflow(app, full.workflowId, 'manual')).resolves.toBeTruthy();

    const quickNodes = await app.db
      .getRepository('flow_nodes')
      .find({ filter: { workflowId: quick.workflowId }, sort: ['id'] });
    const fullNodes = await app.db
      .getRepository('flow_nodes')
      .find({ filter: { workflowId: full.workflowId }, sort: ['id'] });
    expect(quickNodes.some((node) => node.type === 'ai-employee')).toBe(false);
    expect(quickNodes.filter((node) => node.type === 'git-review-llm')).toHaveLength(2);
    expect(fullNodes.some((node) => node.type === 'ai-employee')).toBe(false);
    expect(fullNodes.filter((node) => node.type === 'git-review-llm')).toHaveLength(4);
    expect(
      buildTemplate({
        template: 'full',
        username: 'native-review-test',
        persona: 'Review code',
        llmService: 'native-review-test-llm',
        model: 'deterministic-review-model',
        userId: actorId,
        approverIds: [actorId],
        postMode: 'manual',
      }).filter((node) => node.type === 'git-review-llm'),
    ).toHaveLength(4);

    const manager = app.pm.get('git-manager') as PluginGitManagerServer;
    const terminalStatusEvents: Array<{ executionId: number | string; status: number | string }> = [];
    const onExecutionStatus = manager.reviewService.onExecutionStatus.bind(manager.reviewService);
    vi.spyOn(manager.reviewService, 'onExecutionStatus').mockImplementation(async (executionId, status) => {
      terminalStatusEvents.push({ executionId, status });
      await onExecutionStatus(executionId, status);
    });
    const enqueueMR = (fixture: ReviewFixture, mrIid: number) =>
      manager.reviewService.enqueue({
        flowId: fixture.flowId,
        repositoryId: fixture.repositoryId,
        targetType: 'mr',
        mrIid,
        triggeredBy: 'manual',
        userId: actorId,
        actorRoles,
      });

    const quickFirstId = await enqueueMR(quick, 7);
    const quickRerunId = await enqueueMR(quick, 7);
    const fullReviewId = await enqueueMR(full, 8);
    expect(new Set([quickFirstId, quickRerunId, fullReviewId]).size).toBe(3);

    const reviewRequests = app.db.getRepository('gitReviewRequests');
    const firstRequest = await waitForValue(
      () => reviewRequests.findOne({ filter: { reviewId: quickFirstId } }),
      (request) => Boolean(request?.executionId != null && request?.aiSettled && request?.resultFingerprint),
      'Quick review result',
    );
    const fullRequest = await waitForValue(
      () => reviewRequests.findOne({ filter: { reviewId: fullReviewId } }),
      (request) => Boolean(request?.executionId != null && request?.aiSettled && request?.resultFingerprint),
      'Full review result',
    );
    const secondQuickInbox = await app.db
      .getRepository('gitReviewInbox')
      .findOne({ filter: { reviewId: quickRerunId } });
    expect(secondQuickInbox?.get('state')).toBe('queued');

    const manualTasks = app.db.getRepository('workflowManualTasks');
    const firstTask = await waitForValue(
      () => manualTasks.findOne({ filter: { executionId: firstRequest?.executionId, status: 0 } }),
      (task) => task != null,
      'Quick native manual approval task',
    );
    const fullTask = await waitForValue(
      () => manualTasks.findOne({ filter: { executionId: fullRequest?.executionId, status: 0 } }),
      (task) => task != null,
      'Full native manual approval task',
    );
    expect(typeof firstTask.userId).toBe('number');
    expect(typeof fullTask.userId).toBe('number');
    expect(firstTask.userId).toBe(actorId);
    expect(fullTask.userId).toBe(actorId);
    expect(firstTask.result).toBeNull();

    const projectLocks = await app.db.getRepository('gitReviewProjects').find({ sort: ['projectKey'] });
    expect(projectLocks).toHaveLength(2);
    expect(new Set(projectLocks.map((project) => project.projectKey)).size).toBe(2);
    expect(projectLocks.every((project) => project.activeInboxId != null)).toBe(true);

    const firstReview = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: quickFirstId });
    const firstFingerprint = String(firstRequest.resultFingerprint);
    expect(
      createHash('sha256')
        .update(firstReview?.reviewMarkdown || '', 'utf8')
        .digest('hex'),
    ).toBe(firstFingerprint);
    const approver = await app.db.getRepository('users').findOne({ filterByTk: actorId });
    if (!approver) throw new Error('Expected the assigned test approver');
    const agent = await app.agent().login(approver);

    const wrongApproval = await agent.resource('workflowManualTasks').submit({
      filterByTk: firstTask.id,
      values: { result: { review: { fingerprint: '0'.repeat(64) }, _: 'approve' } },
    });
    expect(wrongApproval.status).toBe(403);

    const firstApproval = await agent.resource('workflowManualTasks').submit({
      filterByTk: firstTask.id,
      values: { result: { review: { fingerprint: firstFingerprint }, _: 'approve' } },
    });
    expect(firstApproval.status).toBe(202);

    let secondRequest: Awaited<ReturnType<typeof reviewRequests.findOne>>;
    try {
      secondRequest = await waitForValue(
        () => reviewRequests.findOne({ filter: { reviewId: quickRerunId } }),
        (request) => Boolean(request?.executionId != null && request?.aiSettled && request?.resultFingerprint),
        'queued same-target Quick rerun execution after first approval',
        5_000,
      );
    } catch (error) {
      const firstInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: quickFirstId } });
      const secondInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: quickRerunId } });
      const firstReview = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: quickFirstId });
      const firstProject =
        firstInbox &&
        (await app.db.getRepository('gitReviewProjects').findOne({ filter: { projectKey: firstInbox.projectKey } }));
      const firstExecution =
        firstRequest?.executionId &&
        (await app.db.getRepository('executions').findOne({ filterByTk: firstRequest.executionId }));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; terminal events ${JSON.stringify(
          terminalStatusEvents,
        )}; state ${JSON.stringify({
          firstInbox: { state: firstInbox?.state, id: firstInbox?.id },
          secondInbox: { state: secondInbox?.state, id: secondInbox?.id },
          firstProject: { activeInboxId: firstProject?.activeInboxId },
          firstRequest: {
            executionId: firstRequest?.executionId,
            aiSettled: firstRequest?.aiSettled,
            resultFingerprint: firstRequest?.resultFingerprint,
            fenced: firstRequest?.fenced,
            postClaim: firstRequest?.postClaim,
          },
          firstReview: {
            status: firstReview?.status,
            postStatus: firstReview?.postStatus,
            error: firstReview?.error,
            postedNoteId: firstReview?.postedNoteId,
          },
          firstExecution: { status: firstExecution?.status, reason: firstExecution?.reason },
        })}`,
      );
    }
    expect(secondRequest.executionId).not.toBe(firstRequest.executionId);
    const secondTask = await waitForValue(
      () => manualTasks.findOne({ filter: { executionId: secondRequest.executionId, status: 0 } }),
      (task) => task != null,
      'second native manual approval task',
    );

    const fullExecutionId = String(fullRequest.executionId);
    const fullCalls = llmInvocations.filter(
      (invocation) => invocation.sessionId?.startsWith(`workflow-${fullExecutionId}-`),
    );
    expect(fullCalls).toHaveLength(4);
    expect(fullCalls[3].messages).toContain('deterministic-provider-review-output');
    expect(pendingJobSnapshots.length).toBeGreaterThanOrEqual(8);
    expect(
      pendingJobSnapshots.every((snapshot) => snapshot.jobId != null && snapshot.status === JOB_STATUS.PENDING),
    ).toBe(true);

    const fullFingerprint = String(fullRequest.resultFingerprint);
    const fullApproval = await agent.resource('workflowManualTasks').submit({
      filterByTk: fullTask.id,
      values: { result: { review: { fingerprint: fullFingerprint }, _: 'approve' } },
    });
    expect(fullApproval.status).toBe(202);

    const secondFingerprint = String(secondRequest.resultFingerprint);
    const secondApproval = await agent.resource('workflowManualTasks').submit({
      filterByTk: secondTask.id,
      values: { result: { review: { fingerprint: secondFingerprint }, _: 'approve' } },
    });
    expect(secondApproval.status).toBe(202);

    await waitForValue(
      () => app.db.getRepository('gitReviewProjects').find({ sort: ['projectKey'] }),
      (projects) => projects.every((project) => project.activeInboxId == null),
      'all project reservations to settle after approved publication',
    );
    const reviews = await app.db.getRepository('gitCodeReviews').find({ sort: ['id'] });
    expect(reviews).toHaveLength(3);
    expect(reviews.every((review) => review.status === 'completed' && review.postStatus === 'posted')).toBe(true);
    expect(postedBodies).toHaveLength(3);
    expect(new Set(postedBodies).size).toBe(3);
    expect(actorRoles.length).toBeGreaterThan(0);
  }, 120_000);

  it('scopes native workflow job history and cross-target reads to Git repository access', async () => {
    const manager = app.pm.get('git-manager') as PluginGitManagerServer;
    const { postedBodies: outboundBodies } = stubGitLab();
    postedBodies = outboundBodies;
    const setup = await provision(app, { flowId: quick.flowId, template: 'quick', approverIds: [actorId] });
    quick.workflowId = Number(setup.workflowId);

    const reviewId = await manager.reviewService.enqueue({
      flowId: quick.flowId,
      repositoryId: quick.repositoryId,
      targetType: 'mr',
      mrIid: 96,
      triggeredBy: 'manual',
      userId: actorId,
      actorRoles,
    });
    const request = await waitForValue(
      () => app.db.getRepository('gitReviewRequests').findOne({ filter: { reviewId } }),
      (row) => Boolean(row?.executionId != null && row.aiSettled && row.resultFingerprint),
      'managed execution for HTTP read authorization',
    );
    const executionId = Number(request.executionId);
    const contextJob = await app.db.getRepository('jobs').findOne({
      filter: { executionId, nodeKey: 'gr_context', status: JOB_STATUS.RESOLVED },
    });
    const task = await waitForValue(
      () =>
        app.db.getRepository('workflowManualTasks').findOne({ filter: { executionId, status: JOB_STATUS.PENDING } }),
      (row) => row != null,
      'manual approval while exercising workflow history reads',
    );
    if (!contextJob || !task) throw new Error('Expected a managed context job and manual task');
    let approvalSent = false;
    try {
      const contextResult = contextJob.get('result') as { diff?: unknown };
      if (typeof contextResult.diff !== 'string' || !contextResult.diff.includes('@@ -1 +1 @@'))
        throw new Error('Expected the persisted context job to contain the source diff');
      const contextJobId = contextJob.get('id') as number | string;
      const workflowId = Number(request.workflowId);
      const actionNames = [
        'workflows:get',
        'workflows:list',
        'workflows.executions:list',
        'executions:get',
        'executions:list',
        'executions.jobs:list',
        'jobs:get',
        'jobs:list',
        'workflowReviewJobReferences:get',
      ];
      const defineReader = async (roleName: string, repositoryScope?: number) => {
        const role = app.acl.define({ role: roleName });
        for (const action of actionNames) role.grantAction(action);
        if (repositoryScope != null) {
          role.grantAction('gitManager:mergeRequestDetail', { filter: { id: { $in: [repositoryScope] } } });
        }
        const user = await app.db.getRepository('users').create({
          values: { nickname: roleName, roles: [{ name: roleName }] },
        });
        return app.agent().login(user, roleName);
      };
      const workflowOnlyReader = await defineReader(`review-workflow-reader-${reviewId}`);
      const repositoryReader = await defineReader(`review-repository-reader-${reviewId}`, quick.repositoryId);
      const containsDiff = (body: unknown) => JSON.stringify(body ?? null)?.includes('@@ -1 +1 @@') ?? false;

      const authorizedJob = await repositoryReader.resource('jobs').get({
        filterByTk: contextJobId,
        fields: ['id', 'result'],
      });
      expect(authorizedJob.status).toBe(200);
      expect(containsDiff(authorizedJob.body.data)).toBe(true);
      const deniedJob = await workflowOnlyReader.resource('jobs').get({
        filterByTk: contextJobId,
        fields: ['id', 'result'],
      });
      expect(deniedJob.status).toBe(403);

      const authorizedWorkflowHistory = await repositoryReader.resource('workflows').get({
        filterByTk: workflowId,
        appends: ['executions', 'executions.jobs'],
        fields: ['id', 'executions.id', 'executions.jobs.id', 'executions.jobs.result'],
      });
      expect(authorizedWorkflowHistory.status).toBe(200);
      expect(containsDiff(authorizedWorkflowHistory.body.data)).toBe(true);
      const deniedWorkflowHistory = await workflowOnlyReader.resource('workflows').get({
        filterByTk: workflowId,
        appends: ['executions', 'executions.jobs'],
        fields: ['id', 'executions.id', 'executions.jobs.id', 'executions.jobs.result'],
      });
      expect(deniedWorkflowHistory.status).toBe(200);
      expect(containsDiff(deniedWorkflowHistory.body.data)).toBe(false);

      const authorizedWorkflowExecutions = await repositoryReader.resource('workflows.executions', workflowId).list({
        appends: ['jobs'],
        fields: ['id', 'jobs.id', 'jobs.result'],
      });
      expect(authorizedWorkflowExecutions.status).toBe(200);
      expect(containsDiff(authorizedWorkflowExecutions.body.data)).toBe(true);
      const deniedWorkflowExecutions = await workflowOnlyReader.resource('workflows.executions', workflowId).list({
        appends: ['jobs'],
        fields: ['id', 'jobs.id', 'jobs.result'],
      });
      expect(deniedWorkflowExecutions.status).toBe(200);
      expect(containsDiff(deniedWorkflowExecutions.body.data)).toBe(false);

      const authorizedJobHistory = await repositoryReader.resource('executions.jobs', executionId).list({
        nodeId: Number(contextJob.get('nodeId')),
      });
      expect(authorizedJobHistory.status).toBe(200);
      expect(
        authorizedJobHistory.body.data.items.some(
          (item: { id: number | string }) => String(item.id) === String(contextJobId),
        ),
      ).toBe(true);
      const deniedJobHistory = await workflowOnlyReader.resource('executions.jobs', executionId).list({
        nodeId: Number(contextJob.get('nodeId')),
      });
      expect(deniedJobHistory.status).toBe(403);

      const authorizedCrossTarget = await repositoryReader.resource('workflows').get({
        filterByTk: contextJobId,
        targetCollection: 'jobs',
        fields: ['id', 'result'],
      });
      expect(authorizedCrossTarget.status).toBe(403);
      const deniedCrossTarget = await workflowOnlyReader.resource('workflows').get({
        filterByTk: contextJobId,
        targetCollection: 'jobs',
        fields: ['id', 'result'],
      });
      expect(deniedCrossTarget.status).toBe(403);
      const redirectedCollectionList = await workflowOnlyReader.resource('workflows').list({
        targetCollection: 'jobs',
        filter: { executionId },
        fields: ['id', 'result'],
      });
      expect(redirectedCollectionList.status).toBe(403);

      const unrelatedWorkflow = await app.db.getRepository('workflows').create({
        values: {
          title: `unrelated workflow ${reviewId}`,
          type: 'collection',
          config: { mode: 1, collection: 'gitRepositories' },
          enabled: false,
          current: true,
          sync: false,
        },
      });
      const unrelatedExecution = await app.db.getRepository('executions').create({
        values: {
          workflowId: unrelatedWorkflow.get('id'),
          key: unrelatedWorkflow.get('key'),
          eventKey: `unrelated-review-read-${reviewId}`,
          status: EXECUTION_STATUS.RESOLVED,
          context: { data: {} },
          dispatched: true,
        },
      });
      const unrelatedJobId = Number(`${Date.now()}${reviewId}`);
      await app.db.getRepository('jobs').create({
        values: {
          id: unrelatedJobId,
          executionId: unrelatedExecution.get('id'),
          upstreamId: contextJobId,
          nodeKey: 'ordinary-node',
          status: JOB_STATUS.RESOLVED,
          result: { content: 'unrelated workflow result' },
        },
      });
      const unrelatedWorkflowRead = await workflowOnlyReader.resource('workflows').get({
        filterByTk: unrelatedWorkflow.get('id'),
      });
      expect(unrelatedWorkflowRead.status).toBe(200);
      const unrelatedJobRead = await workflowOnlyReader.resource('jobs').get({ filterByTk: unrelatedJobId });
      expect(unrelatedJobRead.status).toBe(200);
      expect(unrelatedJobRead.body.data.result).toEqual({ content: 'unrelated workflow result' });
      const authorizedUnrelatedUpstream = await repositoryReader.resource('jobs').get({
        filterByTk: unrelatedJobId,
        appends: ['upstream'],
        fields: ['id', 'upstream.id', 'upstream.result'],
      });
      expect(authorizedUnrelatedUpstream.status).toBe(200);
      expect(containsDiff(authorizedUnrelatedUpstream.body.data)).toBe(true);
      const deniedUnrelatedUpstream = await workflowOnlyReader.resource('jobs').get({
        filterByTk: unrelatedJobId,
        appends: ['upstream'],
        fields: ['id', 'upstream.id', 'upstream.result'],
      });
      expect(deniedUnrelatedUpstream.status).toBe(200);
      expect(containsDiff(deniedUnrelatedUpstream.body.data)).toBe(false);
      const authorizedUpstreamWithoutId = await repositoryReader.resource('jobs').get({
        filterByTk: unrelatedJobId,
        appends: ['upstream'],
        fields: ['id', 'upstream.result'],
      });
      expect(authorizedUpstreamWithoutId.status).toBe(200);
      expect(containsDiff(authorizedUpstreamWithoutId.body.data)).toBe(true);
      const deniedUpstreamWithoutId = await workflowOnlyReader.resource('jobs').get({
        filterByTk: unrelatedJobId,
        appends: ['upstream'],
        fields: ['id', 'upstream.result'],
      });
      expect(deniedUpstreamWithoutId.status).toBe(200);
      expect(containsDiff(deniedUpstreamWithoutId.body.data)).toBe(false);

      const authorizedUpstreamAction = await repositoryReader.resource('jobs.upstream', unrelatedJobId).get({
        filterByTk: unrelatedJobId,
        fields: ['id', 'result'],
      });
      expect(authorizedUpstreamAction.status).toBe(200);
      expect(containsDiff(authorizedUpstreamAction.body.data)).toBe(true);
      const deniedUpstreamAction = await workflowOnlyReader.resource('jobs.upstream', unrelatedJobId).get({
        filterByTk: unrelatedJobId,
        fields: ['id', 'result'],
      });
      expect(deniedUpstreamAction.status).toBe(200);
      expect(containsDiff(deniedUpstreamAction.body.data)).toBe(false);
      const deniedUpstreamActionWithoutId = await workflowOnlyReader.resource('jobs.upstream', unrelatedJobId).get({
        filterByTk: unrelatedJobId,
        fields: ['result'],
      });
      expect(deniedUpstreamActionWithoutId.status).toBe(200);
      expect(containsDiff(deniedUpstreamActionWithoutId.body.data)).toBe(false);

      const executionReferenceJobId = unrelatedJobId + 1;
      await app.db.getRepository('jobs').create({
        values: {
          id: executionReferenceJobId,
          executionId,
          nodeKey: 'unrelated-execution-reference',
          status: JOB_STATUS.RESOLVED,
          result: { content: 'execution reference' },
        },
      });
      const authorizedExecutionAction = await repositoryReader.resource('jobs.execution', executionReferenceJobId).get({
        filterByTk: unrelatedExecution.get('id'),
        appends: ['jobs'],
        fields: ['id', 'jobs.id', 'jobs.result'],
      });
      expect(authorizedExecutionAction.status).toBe(200);
      expect(containsDiff(authorizedExecutionAction.body.data)).toBe(true);
      const deniedExecutionAction = await workflowOnlyReader.resource('jobs.execution', executionReferenceJobId).get({
        filterByTk: unrelatedExecution.get('id'),
        appends: ['jobs'],
        fields: ['id', 'jobs.id', 'jobs.result'],
      });
      expect([200, 403]).toContain(deniedExecutionAction.status);
      expect(containsDiff(deniedExecutionAction.body.data)).toBe(false);
      const deniedExecutionActionWithoutJobId = await workflowOnlyReader
        .resource('jobs.execution', executionReferenceJobId)
        .get({
          filterByTk: unrelatedExecution.get('id'),
          appends: ['jobs'],
          fields: ['jobs.result'],
        });
      expect([200, 403]).toContain(deniedExecutionActionWithoutJobId.status);
      expect(containsDiff(deniedExecutionActionWithoutJobId.body.data)).toBe(false);

      app.db.collection({
        name: 'workflowReviewJobReferences',
        fields: [
          { type: 'string', name: 'jobNodeKey' },
          {
            type: 'belongsTo',
            name: 'job',
            target: 'jobs',
            foreignKey: 'jobNodeKey',
            targetKey: 'nodeKey',
            constraints: false,
          },
        ],
      });
      await app.db.sync();
      const targetKeyNode = `review-target-${reviewId}`;
      await app.db.getRepository('jobs').create({
        values: {
          id: unrelatedJobId + 2,
          executionId,
          nodeKey: targetKeyNode,
          status: JOB_STATUS.RESOLVED,
          result: { diff: contextResult.diff },
        },
      });
      const jobReference = await app.db.getRepository('workflowReviewJobReferences').create({
        values: { jobNodeKey: targetKeyNode },
      });
      const authorizedTargetKey = await repositoryReader.resource('workflowReviewJobReferences').get({
        filterByTk: jobReference.get('id'),
        appends: ['job'],
        fields: ['id', 'job.id', 'job.result'],
      });
      expect(authorizedTargetKey.status).toBe(200);
      expect(containsDiff(authorizedTargetKey.body.data)).toBe(true);
      const deniedTargetKey = await workflowOnlyReader.resource('workflowReviewJobReferences').get({
        filterByTk: jobReference.get('id'),
        appends: ['job'],
        fields: ['id', 'job.id', 'job.result'],
      });
      expect(deniedTargetKey.status).toBe(200);
      expect(containsDiff(deniedTargetKey.body.data)).toBe(false);
      const authorizedTargetKeyWithoutId = await repositoryReader.resource('workflowReviewJobReferences').get({
        filterByTk: jobReference.get('id'),
        appends: ['job'],
        fields: ['id', 'job.result'],
      });
      expect(authorizedTargetKeyWithoutId.status).toBe(200);
      expect(containsDiff(authorizedTargetKeyWithoutId.body.data)).toBe(true);
      const deniedTargetKeyWithoutId = await workflowOnlyReader.resource('workflowReviewJobReferences').get({
        filterByTk: jobReference.get('id'),
        appends: ['job'],
        fields: ['id', 'job.result'],
      });
      expect(deniedTargetKeyWithoutId.status).toBe(200);
      expect(containsDiff(deniedTargetKeyWithoutId.body.data)).toBe(false);

      const authorizedOptionedAppend = await repositoryReader.resource('workflows').get({
        filterByTk: unrelatedWorkflow.get('id'),
        appends: ['executions.jobs.upstream(recursively=true)'],
        fields: [
          'id',
          'executions.id',
          'executions.jobs.id',
          'executions.jobs.upstream.id',
          'executions.jobs.upstream.result',
        ],
      });
      expect(authorizedOptionedAppend.status).toBe(200);
      expect(containsDiff(authorizedOptionedAppend.body.data)).toBe(true);
      const deniedOptionedAppend = await workflowOnlyReader.resource('workflows').get({
        filterByTk: unrelatedWorkflow.get('id'),
        appends: ['executions.jobs.upstream(recursively=true)'],
        fields: [
          'id',
          'executions.id',
          'executions.jobs.id',
          'executions.jobs.upstream.id',
          'executions.jobs.upstream.result',
        ],
      });
      expect(deniedOptionedAppend.status).toBe(200);
      expect(containsDiff(deniedOptionedAppend.body.data)).toBe(false);

      const approver = await app.db.getRepository('users').findOne({ filterByTk: actorId });
      if (!approver) throw new Error('Expected the persisted manual approver');
      const approval = await (await app.agent().login(approver)).resource('workflowManualTasks').submit({
        filterByTk: task.id,
        values: { result: { review: { fingerprint: String(request.resultFingerprint) }, _: 'approve' } },
      });
      expect(approval.status).toBe(202);
      approvalSent = true;
      await waitForValue(
        () => app.db.getRepository('gitReviewProjects').find({ filter: { activeInboxId: { $ne: null } } }),
        (projects) => projects.length === 0,
        'managed HTTP read fixture publication to release its project reservation',
      );
    } finally {
      if (!approvalSent) {
        try {
          const currentTask = await app.db.getRepository('workflowManualTasks').findOne({ filterByTk: task.id });
          const approver = await app.db.getRepository('users').findOne({ filterByTk: actorId });
          if (currentTask?.get('status') === JOB_STATUS.PENDING && approver) {
            await (await app.agent().login(approver)).resource('workflowManualTasks').submit({
              filterByTk: task.id,
              values: { result: { review: { fingerprint: String(request.resultFingerprint) }, _: 'approve' } },
            });
          }
        } catch (_error) {
          // Keep the source assertion as the reported failure if cleanup cannot submit the task.
        }
      }
    }
  }, 120_000);

  it('deduplicates a predecessor resume while the next managed LLM call is pending', async () => {
    const manager = app.pm.get('git-manager') as PluginGitManagerServer;
    const provider = stubGitLab();
    postedBodies = provider.postedBodies;
    resolveDeferredProvider = null;
    nextProviderOutcome = 'deferred';
    const beforeCalls = llmInvocations.length;
    const reviewId = await manager.reviewService.enqueue({
      flowId: quick.flowId,
      repositoryId: quick.repositoryId,
      targetType: 'mr',
      mrIid: 12,
      triggeredBy: 'manual',
      userId: actorId,
      actorRoles,
    });
    const requests = app.db.getRepository('gitReviewRequests');
    const request = await waitForValue(
      () => requests.findOne({ filter: { reviewId } }),
      (row) => Boolean(row?.executionId != null),
      'managed LLM replay execution',
    );
    const resolveInvocation = await waitForValue(
      async () => resolveDeferredProvider,
      (resolver) => typeof resolver === 'function',
      'deferred first LLM provider call',
    );
    const executionId = Number(request.executionId);
    const executionPrefix = `workflow-${executionId}-`;
    const initialCalls = llmInvocations.filter((invocation) => invocation.sessionId?.startsWith(executionPrefix));
    expect(initialCalls).toHaveLength(1);
    const initialSnapshot = pendingJobSnapshots.at(-1);
    expect(initialSnapshot?.sessionId).toBe(initialCalls[0].sessionId);
    if (!initialSnapshot?.jobId) throw new Error('Expected the provider to observe its persisted pending job');
    const initialLlmJob = await app.db.getRepository('jobs').findOne({ filterByTk: initialSnapshot.jobId });
    expect(initialLlmJob?.get('status')).toBe(JOB_STATUS.PENDING);
    const llmNodeId = Number(initialCalls[0].sessionId?.slice(executionPrefix.length));
    const initialExecutionJobs = await app.db.getRepository('jobs').find({ filter: { executionId } });
    const initialLlmJobs = initialExecutionJobs.filter((job) => String(job.get('nodeId')) === String(llmNodeId));
    expect(initialLlmJobs).toHaveLength(1);
    expect(initialLlmJobs[0].get('nodeKey')).toBe('gr_correctness');

    const contextJob = await app.db.getRepository('jobs').findOne({
      filter: { executionId, nodeKey: 'gr_context', status: JOB_STATUS.RESOLVED },
    });
    if (!contextJob) throw new Error('Expected the resolved context job to replay');
    const workflow = app.pm.get('workflow') as unknown as { resume(job: unknown): Promise<void> };
    const llmService = await app.db
      .getRepository('llmServices')
      .findOne({ filter: { name: 'native-review-test-llm' } });
    if (!llmService) throw new Error('Expected the configured deterministic LLM service');
    const llmServiceName = String(llmService.get('name'));
    await app.db.getCollection('llmServices').model.update({ enabled: false }, { where: { name: llmServiceName } });
    try {
      await workflow.resume(contextJob);
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await app.db.getCollection('llmServices').model.update({ enabled: true }, { where: { name: llmServiceName } });
    }

    const jobsAfterReplay = (await app.db.getRepository('jobs').find({ filter: { executionId } })).filter(
      (job) => String(job.get('nodeId')) === String(llmNodeId),
    );
    const callsAfterReplay = llmInvocations.filter((invocation) => invocation.sessionId?.startsWith(executionPrefix));
    expect(jobsAfterReplay).toHaveLength(1);
    expect(jobsAfterReplay[0].get('status')).toBe(JOB_STATUS.PENDING);
    expect(callsAfterReplay).toHaveLength(1);

    resolveInvocation();
    resolveDeferredProvider = null;
    const requestAfterSettlement = await waitForValue(
      () => requests.findOne({ filterByTk: request.id }),
      (row) => Boolean(row?.aiSettled && row.resultFingerprint),
      'review result after deferred provider completion',
    );
    const task = await waitForValue(
      () => app.db.getRepository('workflowManualTasks').findOne({ filter: { executionId, status: 0 } }),
      (row) => row != null,
      'manual approval after replay completion',
    );
    const synthesisJob = await app.db.getRepository('jobs').findOne({
      filter: { executionId, nodeKey: 'gr_synthesis', status: JOB_STATUS.RESOLVED },
    });
    const manualJob = await app.db.getRepository('jobs').findOne({
      filter: { executionId, nodeKey: 'gr_approval' },
    });
    if (!synthesisJob || !manualJob) throw new Error('Expected persisted synthesis and manual jobs');
    const jobsBeforeLateReplay = await app.db.getRepository('jobs').find({ filter: { executionId } });
    const tasksBeforeLateReplay = await app.db.getRepository('workflowManualTasks').find({ filter: { executionId } });
    const invocationsBeforeLateReplay = llmInvocations.filter(
      (invocation) => invocation.sessionId?.startsWith(executionPrefix),
    );
    const lockManagerA = new LockManager();
    const lockManagerB = new LockManager();
    const originalTryAcquire = app.lockManager.tryAcquire.bind(app.lockManager);
    let nextLockManager = 0;
    const tryAcquireSpy = vi.spyOn(app.lockManager, 'tryAcquire').mockImplementation((key, timeout) => {
      if (String(key) === `workflow:execution:${executionId}`) {
        const lockManager = nextLockManager++ % 2 === 0 ? lockManagerA : lockManagerB;
        return lockManager.tryAcquire(key, timeout);
      }
      return originalTryAcquire(key, timeout);
    });
    try {
      await Promise.all([workflow.resume(synthesisJob), workflow.resume(synthesisJob)]);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      tryAcquireSpy.mockRestore();
      await Promise.all([lockManagerA.close(), lockManagerB.close()]);
    }
    const jobsAfterLateReplay = await app.db.getRepository('jobs').find({ filter: { executionId } });
    const tasksAfterLateReplay = await app.db.getRepository('workflowManualTasks').find({ filter: { executionId } });
    const invocationsAfterLateReplay = llmInvocations.filter(
      (invocation) => invocation.sessionId?.startsWith(executionPrefix),
    );
    expect(jobsAfterLateReplay).toHaveLength(jobsBeforeLateReplay.length);
    expect(tasksAfterLateReplay).toHaveLength(tasksBeforeLateReplay.length);
    expect(invocationsAfterLateReplay).toHaveLength(invocationsBeforeLateReplay.length);
    const user = await app.db.getRepository('users').findOne({ filterByTk: actorId });
    if (!user) throw new Error('Expected the persisted manual approver');
    const approver = await app.agent().login(user);
    const approval = await approver.resource('workflowManualTasks').submit({
      filterByTk: task.id,
      values: { result: { review: { fingerprint: String(requestAfterSettlement.resultFingerprint) }, _: 'approve' } },
    });
    expect(approval.status).toBe(202);
    await waitForValue(
      () => app.db.getRepository('gitReviewProjects').find({ filter: { activeInboxId: { $ne: null } } }),
      (projects) => projects.length === 0,
      'project reservation release after replayed review publication',
    );
    const finalJobs = (await app.db.getRepository('jobs').find({ filter: { executionId } })).filter(
      (job) => String(job.get('nodeId')) === String(llmNodeId),
    );
    const finalCalls = llmInvocations.filter((invocation) => invocation.sessionId?.startsWith(executionPrefix));
    expect(finalJobs).toHaveLength(1);
    expect(finalJobs[0].get('status')).toBe(JOB_STATUS.RESOLVED);
    expect(finalCalls).toHaveLength(2);
    expect(finalCalls.length).toBe(llmInvocations.length - beforeCalls);
  }, 120_000);

  it('reconciles a terminal LLM job after its resume delivery fails without invoking the provider again', async () => {
    const manager = app.pm.get('git-manager') as PluginGitManagerServer;
    const provider = stubGitLab();
    postedBodies = provider.postedBodies;
    nextProviderOutcome = 'resolve';
    const workflowPlugin = app.pm.get('workflow') as Parameters<typeof reconcileRequests>[1];
    const workflow = workflowPlugin as unknown as { resume(job: unknown): Promise<void> };
    const originalResume = workflow.resume.bind(workflow);
    let injectedResumeFailure = false;
    const resumeSpy = vi.spyOn(workflow, 'resume').mockImplementation(async (job) => {
      const record = job as RecordGetter;
      if (
        !injectedResumeFailure &&
        record.get('nodeKey') === 'gr_correctness' &&
        record.get('status') === JOB_STATUS.RESOLVED
      ) {
        injectedResumeFailure = true;
        throw new Error('test-only queue handoff failure after terminal job persistence');
      }
      return originalResume(job);
    });
    try {
      const reviewId = await manager.reviewService.enqueue({
        flowId: quick.flowId,
        repositoryId: quick.repositoryId,
        targetType: 'mr',
        mrIid: 61,
        triggeredBy: 'manual',
        userId: actorId,
        actorRoles,
      });
      const requests = app.db.getRepository('gitReviewRequests');
      const request = await waitForValue(
        () => requests.findOne({ filter: { reviewId } }),
        (row) => Boolean(row?.executionId != null),
        'execution before forced resume handoff failure',
      );
      const executionId = Number(request.executionId);
      const correctnessJob = await waitForValue(
        () =>
          app.db.getRepository('jobs').findOne({
            filter: { executionId, nodeKey: 'gr_correctness', status: JOB_STATUS.RESOLVED },
          }),
        (job) => job != null,
        'terminal correctness job persisted before resume failure',
      );
      expect(injectedResumeFailure).toBe(true);
      expect(correctnessJob.get('result')).toMatchObject({ structuredContent: structuredReview });
      expect(
        await app.db.getRepository('jobs').findOne({ filter: { executionId, nodeKey: 'gr_synthesis' } }),
      ).toBeNull();
      const correctnessNode = await app.db.getRepository('flow_nodes').findOne({
        filter: { workflowId: request.workflowId, key: 'gr_correctness' },
      });
      if (!correctnessNode) throw new Error('Expected the configured correctness review node');
      const correctnessSessionId = `workflow-${executionId}-${correctnessNode.id}`;
      const executionPrefix = `workflow-${executionId}-`;
      const correctnessInvocationCount = () =>
        llmInvocations.filter((invocation) => invocation.sessionId === correctnessSessionId).length;
      expect(correctnessInvocationCount()).toBe(1);

      await reconcileRequests(app, workflowPlugin);
      const settledRequest = await waitForValue(
        () => requests.findOne({ filterByTk: request.id }),
        (row) => Boolean(row?.aiSettled && row.resultFingerprint),
        'settled review after durable continuation reconciliation',
      );
      const task = await waitForValue(
        () => app.db.getRepository('workflowManualTasks').findOne({ filter: { executionId, status: 0 } }),
        (row) => row != null,
        'manual approval after reconciled LLM continuation',
      );
      const executionJobs = await app.db.getRepository('jobs').find({ filter: { executionId } });
      expect(executionJobs.filter((job) => job.get('nodeKey') === 'gr_correctness')).toHaveLength(1);
      expect(executionJobs.filter((job) => job.get('nodeKey') === 'gr_synthesis')).toHaveLength(1);
      expect(correctnessInvocationCount()).toBe(1);

      const user = await app.db.getRepository('users').findOne({ filterByTk: actorId });
      if (!user) throw new Error('Expected the persisted manual approver');
      const approver = await app.agent().login(user);
      const approval = await approver.resource('workflowManualTasks').submit({
        filterByTk: task.id,
        values: {
          result: { review: { fingerprint: String(settledRequest.resultFingerprint) }, _: 'approve' },
        },
      });
      expect(approval.status).toBe(202);
      await waitForValue(
        () => app.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId }),
        (review) => review?.postStatus === 'posted',
        'publication after reconciled and approved result',
      );
      const finalCalls = llmInvocations.filter((invocation) => invocation.sessionId?.startsWith(executionPrefix));
      expect(finalCalls).toHaveLength(2);
      expect(provider.postedBodies).toHaveLength(1);
    } finally {
      resumeSpy.mockRestore();
    }
  }, 120_000);

  it('rebuilds an orphan native approval job with its original id from the durable task checkpoint', async () => {
    const manager = app.pm.get('git-manager') as PluginGitManagerServer;
    const provider = stubGitLab();
    postedBodies = provider.postedBodies;
    const setup = await provision(app, { flowId: quick.flowId, template: 'quick', approverIds: [actorId] });
    quick.workflowId = Number(setup.workflowId);
    const beforeCalls = llmInvocations.length;
    const reviewId = await manager.reviewService.enqueue({
      flowId: quick.flowId,
      repositoryId: quick.repositoryId,
      targetType: 'mr',
      mrIid: 97,
      triggeredBy: 'manual',
      userId: actorId,
      actorRoles,
    });
    const requests = app.db.getRepository('gitReviewRequests');
    const request = await waitForValue(
      () => requests.findOne({ filter: { reviewId } }),
      (row) => Boolean(row?.executionId != null && row.aiSettled && row.resultFingerprint),
      'settled review before simulating a missing manual job',
    );
    const executionId = Number(request.executionId);
    const taskRepository = app.db.getRepository('workflowManualTasks');
    const task = await waitForValue(
      () => taskRepository.findOne({ filter: { executionId, status: JOB_STATUS.PENDING } }),
      (row) => row != null,
      'durable native approval task',
    );
    const originalManualJobId = task.get('jobId') as number | string;
    const manualJobs = app.db.getRepository('jobs');
    const originalManualJob = await manualJobs.findOne({ filterByTk: originalManualJobId });
    if (!originalManualJob) throw new Error('Expected the native manual job before simulating a crash gap');
    const llmNodeIds = new Set(
      (
        await app.db
          .getRepository('flow_nodes')
          .find({ filter: { workflowId: request.workflowId, type: 'git-review-llm' } })
      ).map((node) => String(node.id)),
    );
    const invocationCount = () =>
      llmInvocations.filter((call) => call.sessionId?.startsWith(`workflow-${executionId}-`)).length;
    expect(invocationCount()).toBe(llmNodeIds.size);

    await app.db.getCollection('jobs').model.destroy({ where: { id: originalManualJobId } });
    const orphanTask = await taskRepository.findOne({ filterByTk: task.id });
    expect(orphanTask).toBeTruthy();
    expect(String(orphanTask?.get('jobId'))).toBe(String(originalManualJobId));
    expect(await manualJobs.findOne({ filterByTk: originalManualJobId })).toBeNull();

    const workflowPlugin = app.pm.get('workflow') as Parameters<typeof reconcileRequests>[1];
    await reconcileRequests(app, workflowPlugin);
    const restoredManualJob = await waitForValue(
      () => manualJobs.findOne({ filter: { executionId, nodeKey: 'gr_approval' } }),
      (row) => row != null,
      'manual job restored from the saved task after reconciliation',
    );
    expect(String(restoredManualJob.get('id'))).toBe(String(originalManualJobId));
    const restoredTasks = await taskRepository.find({ filter: { executionId, nodeId: task.nodeId } });
    expect(restoredTasks).toHaveLength(1);
    expect(String(restoredTasks[0].get('jobId'))).toBe(String(originalManualJobId));
    expect(invocationCount()).toBe(llmNodeIds.size);

    const approver = await app.db.getRepository('users').findOne({ filterByTk: actorId });
    if (!approver) throw new Error('Expected the persisted manual approver');
    const approval = await (await app.agent().login(approver)).resource('workflowManualTasks').submit({
      filterByTk: task.id,
      values: { result: { review: { fingerprint: String(request.resultFingerprint) }, _: 'approve' } },
    });
    expect(approval.status).toBe(202);
    await waitForValue(
      () => app.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId }),
      (review) => review?.postStatus === 'posted',
      'publication after orphan task recovery',
    );
    expect(provider.postedBodies).toHaveLength(1);
    expect(llmInvocations.length - beforeCalls).toBe(llmNodeIds.size);
  }, 120_000);

  it('reconciles a confirmed publication checkpoint gap without sending another provider request', async () => {
    const manager = app.pm.get('git-manager') as PluginGitManagerServer;
    const provider = stubGitLab();
    postedBodies = provider.postedBodies;
    const setup = await provision(app, { flowId: quick.flowId, template: 'quick', approverIds: [actorId] });
    quick.workflowId = Number(setup.workflowId);
    const beforeCalls = llmInvocations.length;
    const originalPublish = manager.reviewService.publish.bind(manager.reviewService);
    let injectedGap = false;
    const publishSpy = vi.spyOn(manager.reviewService, 'publish').mockImplementation(async (...args) => {
      const result = await originalPublish(...args);
      if (!injectedGap && result.status === 'posted') {
        injectedGap = true;
        return { status: 'in_progress' };
      }
      return result;
    });
    try {
      const reviewId = await manager.reviewService.enqueue({
        flowId: quick.flowId,
        repositoryId: quick.repositoryId,
        targetType: 'mr',
        mrIid: 98,
        triggeredBy: 'manual',
        userId: actorId,
        actorRoles,
      });
      const request = await waitForValue(
        () => app.db.getRepository('gitReviewRequests').findOne({ filter: { reviewId } }),
        (row) => Boolean(row?.executionId != null && row.aiSettled && row.resultFingerprint),
        'settled review before publication checkpoint gap',
      );
      const executionId = Number(request.executionId);
      const task = await waitForValue(
        () =>
          app.db.getRepository('workflowManualTasks').findOne({ filter: { executionId, status: JOB_STATUS.PENDING } }),
        (row) => row != null,
        'manual approval before publication checkpoint gap',
      );
      const approver = await app.db.getRepository('users').findOne({ filterByTk: actorId });
      if (!approver) throw new Error('Expected the persisted manual approver');
      const approval = await (await app.agent().login(approver)).resource('workflowManualTasks').submit({
        filterByTk: task.id,
        values: { result: { review: { fingerprint: String(request.resultFingerprint) }, _: 'approve' } },
      });
      expect(approval.status).toBe(202);
      await waitForValue(
        () => app.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId }),
        (review) => review?.postStatus === 'posted',
        'remote publication receipt before workflow checkpoint reconciliation',
      );
      expect(injectedGap).toBe(true);
      expect(provider.postedBodies).toHaveLength(1);
      expect(await app.db.getRepository('jobs').findOne({ filter: { executionId, nodeKey: 'gr_publish' } })).toBeNull();

      const workflowPlugin = app.pm.get('workflow') as Parameters<typeof reconcileRequests>[1];
      await reconcileRequests(app, workflowPlugin);
      const publishJob = await waitForValue(
        () => app.db.getRepository('jobs').findOne({ filter: { executionId, nodeKey: 'gr_publish' } }),
        (row) => row?.get('status') === JOB_STATUS.RESOLVED,
        'durable publication job after reconciliation',
      );
      expect(publishJob.get('result')).toMatchObject({ fingerprint: request.resultFingerprint, postMode: 'manual' });
      expect(provider.postedBodies).toHaveLength(1);
      expect(llmInvocations.length - beforeCalls).toBe(2);
    } finally {
      publishSpy.mockRestore();
    }
  }, 120_000);

  it('runs a commit review through the manual-policy graph without creating a manual task or posting', async () => {
    const manager = app.pm.get('git-manager') as PluginGitManagerServer;
    const provider = stubGitLab();
    postedBodies = provider.postedBodies;
    await expect(assertSafeWorkflow(app, quick.workflowId, 'disabled')).resolves.toBeTruthy();
    const reviewId = await manager.reviewService.enqueue({
      flowId: quick.flowId,
      repositoryId: quick.repositoryId,
      targetType: 'commit',
      commitSha: quick.headSha,
      triggeredBy: 'manual',
      userId: actorId,
      actorRoles,
    });
    const requests = app.db.getRepository('gitReviewRequests');
    const request = await waitForValue(
      () => requests.findOne({ filter: { reviewId } }),
      (row) => Boolean(row?.executionId != null && row.aiSettled && row.resultFingerprint),
      'native commit review through the manual-policy graph',
    );
    const inbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } });
    const review = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
    if (!inbox || !review) throw new Error('Expected the persisted non-MR review and inbox');
    expect(inbox.payload.postMode).toBe('disabled');
    const manualTasks = await app.db
      .getRepository('workflowManualTasks')
      .find({ filter: { executionId: request.executionId } });
    expect(manualTasks).toHaveLength(0);
    expect(review.reviewMarkdown).toContain('## Coverage');
    await waitForValue(
      () => app.db.getRepository('gitReviewProjects').findOne({ filter: { projectKey: inbox.projectKey } }),
      (project) => project?.activeInboxId == null,
      'non-MR project reservation release',
    );
    const settledReview = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
    expect(settledReview?.status).toBe('completed');
    expect(settledReview?.postStatus).toBe('skipped');
    expect(provider.postedBodies).toHaveLength(0);
  }, 120_000);

  it('quarantines immediate rejection and late results, and never starts a provider after ownership is lost', async () => {
    const manager = app.pm.get('git-manager') as PluginGitManagerServer;
    const { postedBodies: outboundBodies } = stubGitLab();
    postedBodies = outboundBodies;
    nextProviderOutcome = 'reject';
    const rejectedReviewId = await manager.reviewService.enqueue({
      flowId: quick.flowId,
      repositoryId: quick.repositoryId,
      targetType: 'mr',
      mrIid: 9,
      triggeredBy: 'manual',
      userId: actorId,
      actorRoles,
    });
    const requests = app.db.getRepository('gitReviewRequests');
    const rejectedRequest = await waitForValue(
      () => requests.findOne({ filter: { reviewId: rejectedReviewId } }),
      (request) => Boolean(request?.executionId != null),
      'immediately rejected provider execution',
    );
    const rejectedInbox = await app.db
      .getRepository('gitReviewInbox')
      .findOne({ filter: { reviewId: rejectedReviewId } });
    if (!rejectedInbox) throw new Error('Expected an inbox for the rejected review');
    const rejectedProject = await app.db.getRepository('gitReviewProjects').findOne({
      filter: { projectKey: rejectedInbox.projectKey },
    });
    await waitForValue(
      () => app.db.getRepository('gitReviewInbox').findOne({ filterByTk: rejectedInbox.id }),
      (inbox) => inbox?.state === 'quarantined',
      'immediate rejection quarantine',
    );
    const rejectedExecution = await app.db
      .getRepository('executions')
      .findOne({ filterByTk: rejectedRequest.executionId });
    expect(rejectedExecution?.status).not.toBe(EXECUTION_STATUS.STARTED);
    expect(rejectedRequest.aiSettled).toBe(false);
    expect(rejectedProject?.activeInboxId).toBe(rejectedInbox.id);
    const rejectedJob = pendingJobSnapshots.at(-1);
    expect(rejectedJob?.status).toBe(JOB_STATUS.PENDING);
    const rejectedJobAfter = rejectedJob?.jobId
      ? await app.db.getRepository('jobs').findOne({ filterByTk: rejectedJob.jobId })
      : null;
    expect(rejectedJobAfter?.get('status')).toBe(JOB_STATUS.ERROR);

    await manager.reviewService.recover(Number(rejectedRequest.id), Number(rejectedRequest.executionId), actorId);
    const fencedRequest = await requests.findOne({ filterByTk: rejectedRequest.id });
    const recoveredProject = await app.db.getRepository('gitReviewProjects').findOne({
      filter: { projectKey: rejectedInbox.projectKey },
    });
    expect(fencedRequest?.fenced).toBe(true);
    expect(recoveredProject?.activeInboxId).toBeNull();

    nextProviderOutcome = 'deferred';
    const lateReviewId = await manager.reviewService.enqueue({
      flowId: quick.flowId,
      repositoryId: quick.repositoryId,
      targetType: 'mr',
      mrIid: 10,
      triggeredBy: 'manual',
      userId: actorId,
      actorRoles,
    });
    const lateRequest = await waitForValue(
      () => requests.findOne({ filter: { reviewId: lateReviewId } }),
      (request) => Boolean(request?.executionId != null),
      'deferred provider execution',
    );
    const lateProviderCall = await waitForValue(
      async () => resolveDeferredProvider,
      (resolver) => typeof resolver === 'function',
      'deferred provider invocation after pending job persistence',
    );
    const lateSnapshot = pendingJobSnapshots.at(-1);
    expect(lateSnapshot?.status).toBe(JOB_STATUS.PENDING);
    const lateInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: lateReviewId } });
    if (!lateInbox || !lateSnapshot?.jobId) throw new Error('Expected a persisted pending LLM job and inbox');

    await app.db
      .getCollection('executions')
      .model.update(
        { status: -1, endedAt: new Date(), expiresAt: new Date(Date.now() - 1000) },
        { where: { id: lateRequest.executionId } },
      );
    await manager.reviewService.onExecutionStatus(Number(lateRequest.executionId), -1);
    const timedOutInbox = await app.db.getRepository('gitReviewInbox').findOne({ filterByTk: lateInbox.id });
    expect(timedOutInbox?.state).toBe('quarantined');
    const timedOutProject = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: lateInbox.projectKey } });
    expect(timedOutProject?.activeInboxId).toBe(lateInbox.id);

    await manager.reviewService.recover(Number(lateRequest.id), Number(lateRequest.executionId), actorId);
    lateProviderCall();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lateJobAfterFence = await app.db.getRepository('jobs').findOne({ filterByTk: lateSnapshot.jobId });
    const lateRequestAfterFence = await requests.findOne({ filterByTk: lateRequest.id });
    const lateReviewAfterFence = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: lateReviewId });
    const releasedProject = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: lateInbox.projectKey } });
    expect(lateRequestAfterFence?.fenced).toBe(true);
    expect(lateJobAfterFence?.status).toBe(JOB_STATUS.PENDING);
    expect(lateReviewAfterFence?.reviewMarkdown).toBeNull();
    expect(releasedProject?.activeInboxId).toBeNull();
    expect(postedBodies).toHaveLength(0);
    resolveDeferredProvider = null;

    let signalLockWait: (() => void) | null = null;
    let releaseLockWait: (() => void) | null = null;
    const lockWaitStarted = new Promise<void>((resolve) => {
      signalLockWait = resolve;
    });
    const lockWaitGate = new Promise<void>((resolve) => {
      releaseLockWait = resolve;
    });
    let lockWaitObserved = false;
    const originalTryAcquire = app.lockManager.tryAcquire.bind(app.lockManager);
    const tryAcquireSpy = vi.spyOn(app.lockManager, 'tryAcquire').mockImplementation(async (key, timeout) => {
      const match = String(key).match(/^workflow:execution:(\d+)$/);
      if (match && !lockWaitObserved) {
        const pendingRequest = await requests.findOne({ filter: { executionId: Number(match[1]) } });
        if (pendingRequest) {
          lockWaitObserved = true;
          signalLockWait?.();
          await lockWaitGate;
        }
      }
      return originalTryAcquire(key, timeout);
    });
    const invocationCountBeforeLockWait = llmInvocations.length;
    const pendingSnapshotCountBeforeLockWait = pendingJobSnapshots.length;
    try {
      const fencedBeforeInvokeId = await manager.reviewService.enqueue({
        flowId: quick.flowId,
        repositoryId: quick.repositoryId,
        targetType: 'mr',
        mrIid: 11,
        triggeredBy: 'manual',
        userId: actorId,
        actorRoles,
      });
      const fencedBeforeInvokeRequest = await waitForValue(
        () => requests.findOne({ filter: { reviewId: fencedBeforeInvokeId } }),
        (request) => Boolean(request?.executionId != null),
        'review ownership before native provider start',
      );
      await lockWaitStarted;
      const executionId = Number(fencedBeforeInvokeRequest.executionId);
      const pendingJob = await app.db.getRepository('jobs').findOne({
        filter: { executionId, status: JOB_STATUS.PENDING },
      });
      expect(pendingJob).toBeTruthy();

      await app.db
        .getCollection('executions')
        .model.update(
          { status: -1, endedAt: new Date(), expiresAt: new Date(Date.now() - 1000) },
          { where: { id: executionId } },
        );
      await manager.reviewService.onExecutionStatus(executionId, -1);
      const fencedBeforeInvokeInbox = await app.db
        .getRepository('gitReviewInbox')
        .findOne({ filter: { reviewId: fencedBeforeInvokeId } });
      if (!fencedBeforeInvokeInbox) throw new Error('Expected the pre-invocation review inbox');
      await manager.reviewService.recover(Number(fencedBeforeInvokeRequest.id), executionId, actorId);

      releaseLockWait?.();
      const fencedJobId = Number(pendingJob?.get('id'));
      await waitForValue(
        () => app.db.getRepository('gitReviewRequests').findOne({ filterByTk: fencedBeforeInvokeRequest.id }),
        (request) => request?.fenced === true,
        'fencing of the pre-invocation review',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const providerCallsAfterFence = llmInvocations.filter(
        (invocation) => invocation.sessionId?.startsWith(`workflow-${executionId}-`),
      );
      const jobAfterFence = await app.db.getRepository('jobs').findOne({ filterByTk: fencedJobId });
      const inboxAfterFence = await app.db
        .getRepository('gitReviewInbox')
        .findOne({ filterByTk: fencedBeforeInvokeInbox.id });
      expect(providerCallsAfterFence).toHaveLength(0);
      expect(llmInvocations.length).toBe(invocationCountBeforeLockWait);
      expect(pendingJobSnapshots).toHaveLength(pendingSnapshotCountBeforeLockWait);
      expect(jobAfterFence?.get('status')).toBe(JOB_STATUS.PENDING);
      expect(inboxAfterFence?.get('state')).toBe('recovered');
    } finally {
      releaseLockWait?.();
      tryAcquireSpy.mockRestore();
    }
  }, 120_000);
});
