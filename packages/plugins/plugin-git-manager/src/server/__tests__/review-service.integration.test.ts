/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Plugin } from '@nocobase/server';
import { getApp } from '@nocobase/plugin-workflow-test';
import type { MockServer } from '@nocobase/test';
import { vi } from 'vitest';

import { resolveBackgroundReviewRoles } from '../actions/review';
import PluginGitManagerServer from '../plugin';
import { resolveReviewProjectKey } from '../services/review-source';
import { GitReviewService } from '../services/review-service';

type RecordGetter = { get(name: string): unknown };

type ReviewFixture = {
  repositoryId: number;
  flowId: number;
  workflowId: number;
  headSha: string;
  remoteUrl: string;
};

class SafeWorkflowTestPlugin extends Plugin {
  enabled = true;

  async assertSafeWorkflow(_workflowId: number | string, _postMode: string): Promise<void> {}
}

function numericId(record: RecordGetter): number {
  const id = Number(record.get('id'));
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Expected a positive database ID');
  return id;
}

function runGit(repositoryPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim();
}

function createLocalRepository(root: string, name: string, remoteUrl: string): ReviewFixture['headSha'] {
  const repositoryPath = join(root, name);
  mkdirSync(repositoryPath);
  execFileSync('git', ['init', '--initial-branch=main', repositoryPath], { stdio: 'ignore' });
  writeFileSync(join(repositoryPath, 'review-fixture.txt'), `${name}\n`);
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

type ReviewNote = { id: number; body: string; author: { id: number } };

function stubProviderFetch() {
  const notes: ReviewNote[] = [];
  const postedBodies: string[] = [];
  const requestPaths: string[] = [];
  let currentMrHead = 'b'.repeat(40);
  let currentMrBase = 'a'.repeat(40);
  let nextNoteListGate: { entered: () => void; wait: Promise<void> } | null = null;
  let nextMergeRequestGate: {
    entered: () => void;
    wait: Promise<void>;
    shouldHold?: () => Promise<boolean>;
  } | null = null;
  let noteListFailureAfter: { remaining: number; error: Error } | null = null;
  let nextNotePostFailure: number | null = null;
  const holdNextNoteList = () => {
    let markEntered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    nextNoteListGate = { entered: () => markEntered?.(), wait };
    return { entered, release: () => release?.() };
  };
  const holdNextMergeRequest = (shouldHold?: () => Promise<boolean>) => {
    let markEntered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    nextMergeRequestGate = { entered: () => markEntered?.(), wait, shouldHold };
    return { entered, release: () => release?.() };
  };
  const failNoteListAfter = (successfulReads: number, error = new Error('Injected note lookup failure')) => {
    noteListFailureAfter = { remaining: successfulReads, error };
  };
  const failNextNotePost = (status = 503) => {
    nextNotePostFailure = status;
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requestPaths.push(url.pathname);
    const method = String(init?.method || 'GET').toUpperCase();
    if (url.pathname.endsWith('/user')) {
      return new Response(JSON.stringify({ id: 501 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.includes('/merge_requests/') && url.pathname.endsWith('/notes')) {
      if (method === 'POST') {
        const body = typeof init?.body === 'string' ? init.body : undefined;
        const parsed = typeof body === 'string' ? (JSON.parse(body) as { body?: unknown }) : {};
        if (typeof parsed.body !== 'string') throw new Error('Expected a review note body');
        if (nextNotePostFailure != null) {
          const status = nextNotePostFailure;
          nextNotePostFailure = null;
          return new Response('Injected note post failure', { status });
        }
        postedBodies.push(parsed.body);
        const note = { id: 900 + postedBodies.length, body: parsed.body, author: { id: 501 } };
        notes.push(note);
        return new Response(JSON.stringify({ id: note.id }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (noteListFailureAfter) {
        if (noteListFailureAfter.remaining === 0) {
          const { error } = noteListFailureAfter;
          noteListFailureAfter = null;
          throw error;
        }
        noteListFailureAfter.remaining -= 1;
      }
      if (nextNoteListGate) {
        const gate = nextNoteListGate;
        nextNoteListGate = null;
        gate.entered();
        await gate.wait;
      }
      return new Response(JSON.stringify(notes), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const projectSegment = url.pathname.match(/\/projects\/([^/]+)/)?.[1];
    if (!projectSegment) throw new Error(`Unexpected provider request: ${url.pathname}`);
    const projectPath = decodeURIComponent(projectSegment).replace(/\.git$/, '');
    const knownProjects = new Map([
      ['group/project', { id: 101, canonical: 'group/project' }],
      ['group/project-alias', { id: 101, canonical: 'group/project' }],
      ['group/other', { id: 202, canonical: 'group/other' }],
      ['group/legacy', { id: 303, canonical: 'group/legacy' }],
      ['group/legacy-alias', { id: 303, canonical: 'group/legacy' }],
    ]);
    const knownProject = knownProjects.get(projectPath);
    const projectId =
      knownProject?.id ??
      [...projectPath].reduce((id, character) => (id * 31 + character.charCodeAt(0)) % 2_000_000_000, 1_000);
    const canonical = `https://gitlab.test/${knownProject?.canonical || projectPath}`;
    if (url.pathname.includes('/merge_requests/')) {
      if (nextMergeRequestGate && (!nextMergeRequestGate.shouldHold || (await nextMergeRequestGate.shouldHold()))) {
        const gate = nextMergeRequestGate;
        nextMergeRequestGate = null;
        gate.entered();
        await gate.wait;
      }
      return new Response(
        JSON.stringify({
          iid: 7,
          sha: currentMrHead,
          diff_refs: { head_sha: currentMrHead, base_sha: currentMrBase },
          source_branch: 'main',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ id: projectId, web_url: canonical }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock as typeof fetch);
  return {
    fetchMock,
    notes,
    postedBodies,
    requestPaths,
    holdNextNoteList,
    holdNextMergeRequest,
    failNoteListAfter,
    failNextNotePost,
    setMrHead: (head: string) => {
      currentMrHead = head;
    },
    setMrBase: (base: string) => {
      currentMrBase = base;
    },
  };
}

describe('Git review service database integration', () => {
  let app: MockServer;
  let service: GitReviewService;
  let fixtureRoot: string;
  let actorId: number;
  let actorRoles: string[];
  let accountId: number;
  let legacyPostService: PluginGitManagerServer['legacyPostService'];
  let projectA: ReviewFixture;
  let aliasA: ReviewFixture;
  let projectB: ReviewFixture;
  let legacyProject: ReviewFixture;
  let legacyAlias: ReviewFixture;
  const originalRepoRoot = process.env.GIT_REPOS_BASE_PATH;

  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'git-review-service-'));
    process.env.GIT_REPOS_BASE_PATH = fixtureRoot;
    const remoteA = 'https://gitlab.test/group/project.git';
    const remoteAlias = 'https://gitlab.test/group/project-alias.git';
    const remoteB = 'https://gitlab.test/group/other.git';
    const remoteLegacy = 'https://gitlab.test/group/legacy.git';
    const remoteLegacyAlias = 'https://gitlab.test/group/legacy-alias.git';
    const headA = createLocalRepository(fixtureRoot, 'repo-a', remoteA);
    const headAlias = createLocalRepository(fixtureRoot, 'repo-alias', remoteAlias);
    const headB = createLocalRepository(fixtureRoot, 'repo-b', remoteB);
    const headLegacy = createLocalRepository(fixtureRoot, 'repo-legacy', remoteLegacy);
    const headLegacyAlias = createLocalRepository(fixtureRoot, 'repo-legacy-alias', remoteLegacyAlias);

    app = await getApp({
      plugins: [
        'error-handler',
        'data-source-main',
        [PluginGitManagerServer, { name: 'plugin-git-manager' }],
        [SafeWorkflowTestPlugin, { name: 'workflow-git-review' }],
      ],
      skipSupervisor: true,
    });
    const manager = app.pm.get('plugin-git-manager') as PluginGitManagerServer;
    manager.reviewService.stop();
    service = manager.reviewService;
    legacyPostService = manager.legacyPostService;

    const actor = await app.db.getRepository('users').findOne();
    if (!actor) throw new Error('The disposable test database has no root actor');
    actorId = numericId(actor);
    actorRoles = await resolveBackgroundReviewRoles(app.db, actorId);

    const account = await app.db.getRepository('gitAccounts').create({
      values: {
        name: 'Review test account',
        provider: 'gitlab',
        baseUrl: 'https://gitlab.test',
        username: 'review-test',
        pat: 'test-only-token',
      },
    });
    accountId = numericId(account);

    const createProject = async (
      name: string,
      localPath: string,
      remoteUrl: string,
      headSha: string,
      workflowKey: string,
      postMode: 'disabled' | 'auto' = 'disabled',
    ): Promise<ReviewFixture> => {
      const repository = await app.db.getRepository('gitRepositories').create({
        values: { name, repoUrl: remoteUrl, localPath, defaultBranch: 'main', gitAccountId: accountId },
      });
      const repositoryId = numericId(repository);
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          key: workflowKey,
          title: `Review fixture ${name}`,
          type: 'collection',
          config: { collection: 'gitReviewFlows', mode: 1, condition: { id: { $eq: -1 } } },
          enabled: true,
          current: true,
          sync: false,
          options: { gitReview: { draft: false, workflowKey } },
        },
      });
      const workflowId = numericId(workflow);
      const flow = await app.db.getRepository('gitReviewFlows').create({
        values: {
          name: `Flow ${name}`,
          repositoryId,
          enabled: true,
          triggerMode: 'both',
          reviewOnNewCommits: false,
          postMode,
          workflowId,
          workflowKey,
          createdById: actorId,
        },
      });
      const flowId = numericId(flow);
      await app.db.getCollection('gitReviewFlows').model.update({ createdById: actorId }, { where: { id: flowId } });
      return { repositoryId, flowId, workflowId, headSha, remoteUrl };
    };

    projectA = await createProject('Project A', 'repo-a', remoteA, headA, 'review-flow-a');
    aliasA = await createProject('Project A alias', 'repo-alias', remoteAlias, headAlias, 'review-flow-alias');
    projectB = await createProject('Project B', 'repo-b', remoteB, headB, 'review-flow-b');
    legacyProject = await createProject(
      'Legacy Project',
      'repo-legacy',
      remoteLegacy,
      headLegacy,
      'review-flow-legacy',
    );
    legacyAlias = await createProject(
      'Legacy Project alias',
      'repo-legacy-alias',
      remoteLegacyAlias,
      headLegacyAlias,
      'review-flow-legacy-alias',
    );
    let cutover = await app.db.getRepository('gitReviewCutover').findOne({ filter: { key: 'global' } });
    for (let attempt = 0; !cutover && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      cutover = await app.db.getRepository('gitReviewCutover').findOne({ filter: { key: 'global' } });
    }
    if (cutover) {
      await app.db.getRepository('gitReviewCutover').update({
        filterByTk: cutover.get('id'),
        values: { state: 'awaiting_confirmation', confirmedBy: null, confirmedAt: null },
      });
    } else {
      await app.db
        .getRepository('gitReviewCutover')
        .create({ values: { key: 'global', state: 'awaiting_confirmation' } });
    }
  }, 120_000);

  async function createRetryScenarioProject(name: string): Promise<ReviewFixture> {
    await app.db
      .getCollection('gitReviewCutover')
      .model.update({ state: 'ready', confirmedBy: actorId, confirmedAt: new Date() }, { where: { key: 'global' } });
    const remoteUrl = `https://gitlab.test/group/${name}.git`;
    const localPath = `repo-${name}`;
    const headSha = createLocalRepository(fixtureRoot, localPath, remoteUrl);
    const repository = await app.db.getRepository('gitRepositories').create({
      values: {
        name: `Retry scenario ${name}`,
        repoUrl: remoteUrl,
        localPath,
        defaultBranch: 'main',
        gitAccountId: accountId,
      },
    });
    const repositoryId = numericId(repository);
    const workflowKey = `review-flow-${name}`;
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        key: workflowKey,
        title: `Review fixture ${name}`,
        type: 'collection',
        config: { collection: 'gitReviewFlows', mode: 1, condition: { id: { $eq: -1 } } },
        enabled: true,
        current: true,
        sync: false,
        options: { gitReview: { draft: false, workflowKey } },
      },
    });
    const workflowId = numericId(workflow);
    const flow = await app.db.getRepository('gitReviewFlows').create({
      values: {
        name: `Flow ${name}`,
        repositoryId,
        enabled: true,
        triggerMode: 'both',
        reviewOnNewCommits: false,
        postMode: 'auto',
        workflowId,
        workflowKey,
        createdById: actorId,
      },
    });
    const flowId = numericId(flow);
    await app.db.getCollection('gitReviewFlows').model.update({ createdById: actorId }, { where: { id: flowId } });
    return { repositoryId, flowId, workflowId, headSha, remoteUrl };
  }

  async function createCompletedManagedReview(name: string, mrIid: number, markdown: string) {
    const fixture = await createRetryScenarioProject(name);
    const reviewId = await service.enqueue({
      flowId: fixture.flowId,
      repositoryId: fixture.repositoryId,
      targetType: 'mr',
      mrIid,
      triggeredBy: 'manual',
      userId: actorId,
      actorRoles,
    });
    const inbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } });
    const request =
      inbox && (await app.db.getRepository('gitReviewRequests').findOne({ filter: { inboxId: inbox.get('id') } }));
    if (!inbox || !request) throw new Error('Expected an admitted managed review');
    const markdownHash = createHash('sha256').update(markdown).digest('hex');
    const execution = await app.db.getRepository('executions').create({
      values: {
        workflowId: request.get('workflowId'),
        context: { data: { id: request.get('id'), workflowId: request.get('workflowId') } },
        status: 1,
        startedAt: new Date(),
        endedAt: new Date(),
      },
    });
    const executionId = numericId(execution);
    const workflowPlugin = app.pm.get('workflow') as unknown as { snowflake: { getUniqueID(): bigint } };
    for (const [key, title] of [
      ['gr_correctness', 'Correctness review'],
      ['gr_synthesis', 'Synthesize review'],
    ]) {
      const node = await app.db.getRepository('flow_nodes').create({
        values: {
          workflowId: request.get('workflowId'),
          key,
          title,
          type: 'git-review-llm',
          config: { llmService: 'fixture-service', model: 'fixture-model' },
        },
      });
      await app.db.getRepository('jobs').create({
        values: {
          id: workflowPlugin.snowflake.getUniqueID().toString(),
          executionId,
          nodeId: node.get('id'),
          nodeKey: key,
          status: 1,
          result: { content: markdown },
          startedAt: new Date(),
        },
      });
    }
    await app.db.getRepository('gitReviewRequests').update({
      filterByTk: request.get('id'),
      values: { executionId, aiSettled: true, resultFingerprint: markdownHash },
    });
    await app.db.getRepository('gitReviewInbox').update({
      filterByTk: inbox.get('id'),
      values: { state: 'completed' },
    });
    await app.db.getRepository('gitCodeReviews').update({
      filterByTk: reviewId,
      values: { status: 'completed', postStatus: 'post_unknown', reviewMarkdown: markdown },
    });
    await app.db
      .getCollection('gitReviewProjects')
      .model.update(
        { activeInboxId: null },
        { where: { projectKey: inbox.get('projectKey'), activeInboxId: inbox.get('id') } },
      );
    return {
      fixture,
      reviewId,
      inbox,
      request,
      executionId,
      markdownHash,
      projectKey: String(inbox.get('projectKey')),
    };
  }

  async function createRunningManagedReview(name: string, mrIid: number) {
    const fixture = await createRetryScenarioProject(name);
    const reviewId = await service.enqueue({
      flowId: fixture.flowId,
      repositoryId: fixture.repositoryId,
      targetType: 'mr',
      mrIid,
      triggeredBy: 'manual',
      userId: actorId,
      actorRoles,
    });
    const inbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } });
    const request =
      inbox && (await app.db.getRepository('gitReviewRequests').findOne({ filter: { inboxId: inbox.get('id') } }));
    if (!inbox || !request) throw new Error('Expected an admitted managed review');
    const execution = await app.db.getRepository('executions').create({
      values: {
        workflowId: request.get('workflowId'),
        context: { data: { id: request.get('id'), workflowId: request.get('workflowId') } },
        status: 0,
        startedAt: new Date(),
      },
    });
    const executionId = numericId(execution);
    await expect(service.claim(numericId(request), executionId)).resolves.toBe(true);
    return { fixture, reviewId, inboxId: numericId(inbox), requestId: numericId(request), executionId };
  }

  async function createLegacyPostScenario(
    name: string,
    mrIid: number,
    markdown: string,
    postStatus: 'posting' | 'post_unknown' | 'post_failed',
    withPinnedSource = false,
  ) {
    const fixture = await createRetryScenarioProject(name);
    const repository = await app.db.getRepository('gitRepositories').findOne({ filterByTk: fixture.repositoryId });
    if (!repository) throw new Error('Expected the historical review repository');
    const projectKey = await resolveReviewProjectKey(app.db, repository);
    await service.ensureReviewProject(projectKey);
    const markdownHash = createHash('sha256').update(markdown).digest('hex');
    const attemptId = `historical-${name}`;
    const pinnedSource = {
      projectKey,
      repositoryId: fixture.repositoryId,
      targetType: 'mr',
      mrIid,
      branch: null,
      folderPath: null,
      headSha: 'b'.repeat(40),
      baseSha: 'a'.repeat(40),
    };
    const review = await app.db.getRepository('gitCodeReviews').create({
      values: {
        repositoryId: fixture.repositoryId,
        flowId: fixture.flowId,
        targetType: 'mr',
        mrIid,
        headSha: pinnedSource.headSha,
        status: 'completed',
        postStatus,
        reviewMarkdown: markdown,
        legacyPostFingerprint: markdownHash,
        legacyPostClaim: attemptId,
        legacyPostProjectKey: projectKey,
        ...(withPinnedSource
          ? {
              legacyPostSource: pinnedSource,
              legacyBaseProvenance: 'unverified_legacy',
              legacyBaseAcknowledgedBy: String(actorId),
              legacyBaseAcknowledgedAt: new Date(),
            }
          : {}),
        createdById: actorId,
      },
    });
    const reviewId = numericId(review);
    const [reserved] = await app.db
      .getCollection('gitReviewProjects')
      .model.update(
        { legacyPostReviewId: reviewId },
        { where: { projectKey, activeInboxId: null, legacyPostReviewId: null } },
      );
    if (reserved !== 1) throw new Error('Expected to reserve the historical review project');
    return { fixture, reviewId, projectKey, attemptId, markdownHash, pinnedSource };
  }

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.destroy();
    if (originalRepoRoot === undefined) delete process.env.GIT_REPOS_BASE_PATH;
    else process.env.GIT_REPOS_BASE_PATH = originalRepoRoot;
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('dedupes poll events, serializes explicit reruns by canonical project, and admits separate projects concurrently', async () => {
    const { fetchMock } = stubProviderFetch();
    const enqueueManual = (fixture: ReviewFixture, targetType: 'commit' | 'mr', mrIid?: number) =>
      service.enqueue({
        flowId: fixture.flowId,
        repositoryId: fixture.repositoryId,
        targetType,
        commitSha: targetType === 'commit' ? fixture.headSha : null,
        mrIid: targetType === 'mr' ? mrIid : null,
        triggeredBy: 'manual',
        userId: actorId,
        actorRoles,
      });

    const firstRun = await enqueueManual(projectA, 'commit');
    const explicitRerun = await enqueueManual(projectA, 'commit');
    const aliasRerun = await enqueueManual(aliasA, 'commit');
    const pollFirst = await service.enqueue({
      flowId: projectA.flowId,
      repositoryId: projectA.repositoryId,
      targetType: 'mr',
      mrIid: 7,
      triggeredBy: 'poll',
      eventType: 'change_opened',
    });
    const pollDuplicate = await service.enqueue({
      flowId: aliasA.flowId,
      repositoryId: aliasA.repositoryId,
      targetType: 'mr',
      mrIid: 7,
      triggeredBy: 'poll',
      eventType: 'change_opened',
    });
    const differentProjectRun = await enqueueManual(projectB, 'commit');

    expect(new Set([firstRun, explicitRerun, aliasRerun]).size).toBe(3);
    expect(pollDuplicate).toBe(pollFirst);
    expect(fetchMock).toHaveBeenCalled();
    expect(await app.db.getRepository('gitReviewRequests').count()).toBe(0);

    const queueDates = [
      [firstRun, new Date('2020-01-01T00:00:00.000Z')],
      [explicitRerun, new Date('2020-01-02T00:00:00.000Z')],
      [aliasRerun, new Date('2020-01-03T00:00:00.000Z')],
      [pollFirst, new Date('2020-01-04T00:00:00.000Z')],
      [differentProjectRun, new Date('2020-01-01T00:00:00.000Z')],
    ] as const;
    for (const [reviewId, queuedAt] of queueDates) {
      const inbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } });
      if (!inbox) throw new Error(`Missing inbox for review ${reviewId}`);
      await app.db.getRepository('gitReviewInbox').update({
        filterByTk: inbox.get('id'),
        values: { queuedAt },
      });
    }

    await service.confirmCutover(actorId);
    await Promise.all([service.reconcile(), new GitReviewService(app).reconcile()]);

    const reviews = await app.db.getRepository('gitCodeReviews').find({ sort: ['id'] });
    expect(reviews).toHaveLength(5);
    const firstInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: firstRun } });
    const secondInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: explicitRerun } });
    const aliasInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: aliasRerun } });
    const pollInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: pollFirst } });
    const otherInbox = await app.db
      .getRepository('gitReviewInbox')
      .findOne({ filter: { reviewId: differentProjectRun } });
    expect(firstInbox?.get('state')).toBe('dispatched');
    expect(secondInbox?.get('state')).toBe('queued');
    expect(aliasInbox?.get('state')).toBe('queued');
    expect(pollInbox?.get('state')).toBe('queued');
    expect(otherInbox?.get('state')).toBe('dispatched');

    const projectRows = await app.db.getRepository('gitReviewProjects').find({ sort: ['projectKey'] });
    expect(projectRows).toHaveLength(2);
    expect(projectRows.every((project) => project.get('activeInboxId') != null)).toBe(true);

    await expect(app.eventQueue.publish('plugin-git-manager.review', { reviewId: firstRun })).rejects.toThrow(
      'not subscribed',
    );
  });

  it('keeps a failed or timed out execution quarantined until fenced administrative recovery', async () => {
    const inbox = await app.db.getRepository('gitReviewInbox').findOne({
      filter: { reviewId: (await app.db.getRepository('gitCodeReviews').findOne({ sort: ['id'] }))?.get('id') },
      sort: ['id'],
    });
    if (!inbox) throw new Error('Expected the first project admission to retain its reservation');
    const projectKey = String(inbox.get('projectKey'));
    const active = await app.db.getRepository('gitReviewProjects').findOne({ filter: { projectKey } });
    expect(active?.get('activeInboxId')).toBe(inbox.get('id'));

    const request = await app.db.getRepository('gitReviewRequests').findOne({ filter: { inboxId: inbox.get('id') } });
    if (!request) throw new Error('Expected the dispatched review request');
    const execution = await app.db.getRepository('executions').create({
      values: {
        workflowId: request.get('workflowId'),
        context: { data: { id: request.get('id') } },
        status: -1,
        reason: 'timeout',
        startedAt: new Date(),
        endedAt: new Date(),
      },
    });
    const executionId = numericId(execution);
    await app.db.getRepository('gitReviewRequests').update({
      filterByTk: request.get('id'),
      values: { executionId },
    });
    await app.db.getRepository('gitReviewInbox').update({
      filterByTk: inbox.get('id'),
      values: { state: 'running' },
    });

    await service.onExecutionStatus(executionId, -1);
    await service.reconcile();

    const quarantined = await app.db.getRepository('gitReviewInbox').findOne({ filterByTk: inbox.get('id') });
    const lockedProject = await app.db.getRepository('gitReviewProjects').findOne({ filter: { projectKey } });
    expect(quarantined?.get('state')).toBe('quarantined');
    expect(lockedProject?.get('activeInboxId')).toBe(inbox.get('id'));

    await service.recover(numericId(request), executionId, actorId);

    const recoveredRequest = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: request.get('id') });
    const recoveredInbox = await app.db.getRepository('gitReviewInbox').findOne({ filterByTk: inbox.get('id') });
    expect(recoveredRequest?.get('fenced')).toBe(true);
    expect(recoveredInbox?.get('state')).toBe('recovered');
    await expect(service.claim(numericId(request), executionId)).resolves.toBe(false);

    const nextInbox = await app.db.getRepository('gitReviewInbox').findOne({
      filter: { projectKey, state: 'dispatched' },
    });
    expect(nextInbox).toBeTruthy();
    expect(nextInbox?.get('reviewId')).not.toBe(inbox.get('reviewId'));
  });

  it('drains legacy pending reviews while same-project legacy running rows block dispatch until stopped', async () => {
    const reviews = app.db.getRepository('gitCodeReviews');
    const pendingLegacy = await reviews.create({
      values: {
        repositoryId: legacyProject.repositoryId,
        flowId: legacyProject.flowId,
        targetType: 'commit',
        commitSha: legacyProject.headSha,
        headSha: legacyProject.headSha,
        triggeredBy: 'poll',
        status: 'pending',
        postStatus: 'skipped',
        createdById: actorId,
      },
    });
    const runningLegacy = await reviews.create({
      values: {
        repositoryId: legacyAlias.repositoryId,
        flowId: legacyAlias.flowId,
        targetType: 'commit',
        commitSha: legacyAlias.headSha,
        headSha: legacyAlias.headSha,
        triggeredBy: 'poll',
        status: 'running',
        postStatus: 'skipped',
        startedAt: new Date(),
        createdById: actorId,
      },
    });
    const pendingId = numericId(pendingLegacy);
    const runningId = numericId(runningLegacy);
    const cutover = await app.db.getRepository('gitReviewCutover').findOne({ filter: { key: 'global' } });
    if (!cutover) throw new Error('Expected the review cutover record');
    await app.db.getRepository('gitReviewCutover').update({
      filterByTk: cutover.get('id'),
      values: { state: 'awaiting_confirmation', confirmedBy: null, confirmedAt: null },
    });

    const beforeConfirmation = await service.cutoverStatus();
    expect(beforeConfirmation.state).toBe('awaiting_confirmation');
    expect(
      beforeConfirmation.legacyPendingReviews.some((item) => String(item.legacyReviewId) === String(pendingId)),
    ).toBe(true);
    expect(
      beforeConfirmation.legacyRunningReviews.some((item) => String(item.legacyReviewId) === String(runningId)),
    ).toBe(true);

    await service.confirmCutover(actorId);
    const migratedInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: pendingId } });
    const pendingProjectRow =
      migratedInbox &&
      (await app.db.getRepository('gitReviewProjects').findOne({
        filter: { projectKey: migratedInbox.get('projectKey') },
      }));
    expect(migratedInbox?.get('legacyReviewId')).toBe(pendingId);
    expect(migratedInbox?.get('state')).toBe('queued');
    expect(pendingProjectRow?.get('activeInboxId')).toBeNull();
    expect(
      await app.db.getRepository('gitReviewRequests').findOne({ filter: { inboxId: migratedInbox?.get('id') } }),
    ).toBeNull();
    await expect(app.eventQueue.publish('plugin-git-manager.review', { reviewId: pendingId })).rejects.toThrow(
      'not subscribed',
    );

    await service.recoverLegacy(runningId, actorId);
    const recoveredLegacy = await reviews.findOne({ filterByTk: runningId });
    const dispatchedInbox = await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: pendingId } });
    const dispatchedRequest =
      dispatchedInbox &&
      (await app.db.getRepository('gitReviewRequests').findOne({
        filter: { inboxId: dispatchedInbox.get('id') },
      }));
    const canonicalKeys = await app.db.getRepository('gitReviewProjects').find({
      filter: { projectKey: migratedInbox?.get('projectKey') },
    });
    expect(recoveredLegacy?.get('status')).toBe('failed');
    expect(dispatchedInbox?.get('state')).toBe('dispatched');
    expect(dispatchedRequest).toBeTruthy();
    expect(canonicalKeys).toHaveLength(1);
    expect(canonicalKeys[0].get('activeInboxId')).toBe(dispatchedInbox?.get('id'));
  });

  it('does not enqueue a legacy row canceled before migration reaches enqueue', async () => {
    stubProviderFetch();
    await app.db.getCollection('gitReviewCutover').model.update({ state: 'ready' }, { where: { key: 'global' } });
    const legacy = await app.db.getRepository('gitCodeReviews').create({
      values: {
        repositoryId: legacyProject.repositoryId,
        flowId: legacyProject.flowId,
        targetType: 'commit',
        commitSha: legacyProject.headSha,
        headSha: legacyProject.headSha,
        triggeredBy: 'poll',
        status: 'pending',
        postStatus: 'skipped',
        createdById: actorId,
      },
    });
    const legacyReviewId = numericId(legacy);
    let enteredMigration: (() => void) | undefined;
    let releaseMigration: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredMigration = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const originalEnqueue = service.enqueue.bind(service);
    let interceptedEnqueueCalls = 0;
    const enqueueSpy = vi.spyOn(service, 'enqueue').mockImplementation(async (input) => {
      if (String(input.legacyReviewId) === String(legacyReviewId)) {
        interceptedEnqueueCalls += 1;
        enteredMigration?.();
        await gate;
      }
      return originalEnqueue(input);
    });
    const migration = service.reconcile();
    try {
      await entered;
      await service.cancelLegacy(legacyReviewId, actorId);
    } finally {
      releaseMigration?.();
      enqueueSpy.mockRestore();
    }
    await migration;

    const canceled = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: legacyReviewId });
    expect(canceled?.get('status')).toBe('failed');
    expect(canceled?.get('metadata')).toMatchObject({ migrationCanceledBy: String(actorId) });
    expect(await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: legacyReviewId } })).toBeNull();
    expect(
      await app.db.getRepository('gitReviewRequests').findOne({ filter: { reviewId: legacyReviewId } }),
    ).toBeNull();
    expect(interceptedEnqueueCalls).toBe(1);
  });

  it.skipIf(process.env['DB_DIALECT'] === 'sqlite')(
    'does not overwrite a legacy cancellation after migration reads the pending snapshot',
    async () => {
      expect(app.db.sequelize.getDialect()).toBe('postgres');
      stubProviderFetch();
      await app.db.getCollection('gitReviewCutover').model.update({ state: 'ready' }, { where: { key: 'global' } });
      const legacy = await app.db.getRepository('gitCodeReviews').create({
        values: {
          repositoryId: legacyProject.repositoryId,
          flowId: legacyProject.flowId,
          targetType: 'commit',
          commitSha: legacyProject.headSha,
          headSha: legacyProject.headSha,
          triggeredBy: 'poll',
          status: 'pending',
          postStatus: 'skipped',
          createdById: actorId,
        },
      });
      const legacyReviewId = numericId(legacy);
      let cancelUpdateCompleted: (() => void) | undefined;
      let releaseCancel: (() => void) | undefined;
      const updateCompleted = new Promise<void>((resolve) => {
        cancelUpdateCompleted = resolve;
      });
      const cancelGate = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      const reviewModel = app.db.getCollection('gitCodeReviews').model;
      const originalUpdate = reviewModel.update.bind(reviewModel);
      const updateSpy = vi.spyOn(reviewModel, 'update').mockImplementation(async (values, options) => {
        const changed = await originalUpdate(values, options);
        const update = values as Record<string, unknown>;
        const where = (options as { where?: Record<string, unknown> } | undefined)?.where;
        if (
          update.status === 'failed' &&
          update.error === 'Legacy review canceled during workflow migration' &&
          String(where?.id) === String(legacyReviewId)
        ) {
          cancelUpdateCompleted?.();
          await cancelGate;
        }
        return changed;
      });
      const cancel = service.cancelLegacy(legacyReviewId, actorId);
      let migration: Promise<void> | undefined;
      let cancelHeldRow = false;
      try {
        await updateCompleted;
        migration = service.reconcile();
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const [rows] = await app.db.sequelize.query(
            `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%gitCodeReviews%'`,
          );
          if (Array.isArray(rows) && rows.length > 0) {
            cancelHeldRow = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        releaseCancel?.();
        updateSpy.mockRestore();
        await Promise.allSettled([cancel, migration || Promise.resolve()]);
      }
      expect(cancelHeldRow).toBe(true);
      const canceled = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: legacyReviewId });
      expect(canceled?.get('status')).toBe('failed');
      expect(canceled?.get('metadata')).toMatchObject({ migrationCanceledBy: String(actorId) });
      expect(await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: legacyReviewId } })).toBeNull();
      expect(
        await app.db.getRepository('gitReviewRequests').findOne({ filter: { reviewId: legacyReviewId } }),
      ).toBeNull();
    },
  );

  it('serializes post retries and only records a verified outbound note', async () => {
    const provider = stubProviderFetch();
    const markdown = '## Review\n\nNo findings in the pinned diff.';
    const { reviewId, inbox, request } = await createCompletedManagedReview('retry-serialized', 31, markdown);
    const markdownHash = createHash('sha256').update(markdown).digest('hex');

    const getOnly = await service.retryPost(reviewId, actorId, actorRoles, false);
    expect(getOnly).toMatchObject({ status: 'unknown', canResend: true });
    expect(provider.postedBodies).toHaveLength(0);
    const released = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: inbox.get('projectKey') } });
    expect(released?.get('activeInboxId')).toBeNull();

    const gate = provider.holdNextNoteList();
    const firstRetry = service.retryPost(reviewId, actorId, actorRoles, true);
    await gate.entered;
    const claimedRequest = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: request.get('id') });
    const claimedProject = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: inbox.get('projectKey') } });
    expect(typeof claimedRequest?.get('postClaim')).toBe('string');
    expect(claimedProject?.get('activeInboxId')).toBe(inbox.get('id'));
    await expect(service.retryPost(reviewId, actorId, actorRoles, true)).rejects.toMatchObject({ status: 409 });
    gate.release();

    await expect(firstRetry).resolves.toMatchObject({ status: 'posted', canResend: false });
    const postedReview = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
    const postedRequest = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: request.get('id') });
    const finalProject = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: inbox.get('projectKey') } });
    expect(postedReview?.get('postStatus')).toBe('posted');
    expect(postedRequest?.get('postClaim')).toBeNull();
    expect(finalProject?.get('activeInboxId')).toBeNull();
    expect(provider.postedBodies).toEqual([`${markdown}\n\n<!-- git-review:${request.get('id')}:${markdownHash} -->`]);
  });

  it('keeps marker-only peer observations read-only and fences stale post reset tokens', async () => {
    const provider = stubProviderFetch();
    const markdown = '## Retry marker\n\nA complete immutable result.';
    const { reviewId, inbox, request, markdownHash } = await createCompletedManagedReview('retry-marker', 32, markdown);
    const projectKey = String(inbox.get('projectKey'));
    await app.db
      .getCollection('gitReviewProjects')
      .model.update({ activeInboxId: inbox.get('id') }, { where: { projectKey, activeInboxId: null } });
    const originalAttempt = 'previous-post-attempt';
    await app.db.getRepository('gitReviewRequests').update({
      filterByTk: request.get('id'),
      values: { postClaim: originalAttempt, postClaimedAt: new Date() },
    });
    const marker = `<!-- git-review:${request.get('id')}:${markdownHash} -->`;
    provider.notes.push({ id: 990, body: `${markdown}\n\n${marker}`, author: { id: 501 } });

    const observed = await service.retryPost(reviewId, actorId, actorRoles, false);
    expect(observed).toMatchObject({ status: 'observed', postedNoteId: '990', canResend: false });
    const unchangedRequest = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: request.get('id') });
    const heldProject = await app.db.getRepository('gitReviewProjects').findOne({ filter: { projectKey } });
    expect(unchangedRequest?.get('postClaim')).toBe(originalAttempt);
    expect(heldProject?.get('activeInboxId')).toBe(inbox.get('id'));
    await expect(service.resetPostClaim(reviewId, actorId, 'wrong-attempt')).rejects.toMatchObject({ status: 409 });
    await service.resetPostClaim(reviewId, actorId, originalAttempt);
    const resetRequest = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: request.get('id') });
    expect(resetRequest?.get('postClaim')).toBeNull();
    const resetProject = await app.db.getRepository('gitReviewProjects').findOne({ filter: { projectKey } });
    expect(resetProject?.get('activeInboxId')).toBeNull();

    provider.setMrHead('c'.repeat(40));
    const gate = provider.holdNextNoteList();
    const ownerRetry = service.retryPost(reviewId, actorId, actorRoles, false);
    await gate.entered;
    const newClaim = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: request.get('id') });
    const newAttempt = String(newClaim?.get('postClaim'));
    expect(newAttempt).not.toBe(originalAttempt);
    await expect(service.resetPostClaim(reviewId, actorId, originalAttempt)).rejects.toMatchObject({ status: 409 });
    const claimAfterStaleReset = await app.db
      .getRepository('gitReviewRequests')
      .findOne({ filterByTk: request.get('id') });
    expect(claimAfterStaleReset?.get('postClaim')).toBe(newAttempt);
    gate.release();

    const pathsBeforeMarkerLookup = provider.requestPaths.length;
    await expect(ownerRetry).resolves.toMatchObject({ status: 'posted', postedNoteId: '990' });
    const retryPaths = provider.requestPaths.slice(pathsBeforeMarkerLookup);
    expect(retryPaths.some((path) => path.includes('/merge_requests/32') && !path.endsWith('/notes'))).toBe(false);
    expect(provider.postedBodies).toHaveLength(0);
    const postedReview = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
    expect(postedReview?.get('postStatus')).toBe('posted');
  });

  it('blocks a new MR post after the base changes but still reconciles its exact existing marker', async () => {
    const provider = stubProviderFetch();
    const markdown = '## Base change check\n\nDo not publish against a changed base.';
    const { reviewId, inbox, request, markdownHash } = await createCompletedManagedReview(
      'retry-base-change',
      33,
      markdown,
    );

    provider.setMrBase('c'.repeat(40));
    await expect(service.retryPost(reviewId, actorId, actorRoles, true)).rejects.toThrow();
    expect(provider.postedBodies).toHaveLength(0);
    expect(
      provider.fetchMock.mock.calls.some(([, init]) => String(init?.method || 'GET').toUpperCase() === 'POST'),
    ).toBe(false);

    const requestId = numericId(request);
    const marker = `<!-- git-review:${requestId}:${markdownHash} -->`;
    provider.notes.push({ id: 993, body: `${markdown}\n\n${marker}`, author: { id: 501 } });
    const beforeLookup = provider.requestPaths.length;
    const reconciled = await service.retryPost(reviewId, actorId, actorRoles, false);
    expect(['observed', 'posted']).toContain(reconciled.status);
    expect(reconciled).toMatchObject({ postedNoteId: '993', canResend: false });
    expect(
      provider.requestPaths
        .slice(beforeLookup)
        .some((path) => path.includes('/merge_requests/33') && !path.endsWith('/notes')),
    ).toBe(false);
    expect(provider.postedBodies).toHaveLength(0);
  });

  it.each(['posting', 'posted'] as const)(
    'does not rewind a %s publication when the same review result is saved again',
    async (postStatus) => {
      stubProviderFetch();
      const seeded = await createRunningManagedReview(`save-result-${postStatus}`, 34);
      const markdown = '## Immutable result\n\nThe workflow returned this exact review.';
      const hash = await service.saveResult(seeded.requestId, seeded.executionId, markdown);
      const claim = `active-${postStatus}-claim`;
      const noteId = postStatus === 'posted' ? 'existing-note-994' : null;
      await app.db.getRepository('gitReviewRequests').update({
        filterByTk: seeded.requestId,
        values: { postClaim: claim, postClaimedAt: new Date() },
      });
      await app.db.getRepository('gitCodeReviews').update({
        filterByTk: seeded.reviewId,
        values: { postStatus, postedNoteId: noteId },
      });

      await expect(service.saveResult(seeded.requestId, seeded.executionId, markdown)).resolves.toBe(hash);

      const review = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: seeded.reviewId });
      const request = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: seeded.requestId });
      expect(review?.get('postStatus')).toBe(postStatus);
      expect(review?.get('postedNoteId')).toBe(noteId);
      expect(request?.get('postClaim')).toBe(claim);
    },
  );

  it.each(['post_failed', 'posting'] as const)(
    'recovers historical %s reviews by posting only the exact saved review after base acknowledgement',
    async (postStatus) => {
      const provider = stubProviderFetch();
      await app.db.getCollection('gitReviewCutover').model.update({ state: 'ready' }, { where: { key: 'global' } });
      const markdown = `## Historical ${postStatus}\n\nKeep the reviewed content byte-for-byte.`;
      const scenario = await createLegacyPostScenario(`historical-${postStatus}`, 41, markdown, postStatus);

      const result = await legacyPostService.retry(
        scenario.reviewId,
        actorId,
        actorRoles,
        scenario.attemptId,
        'LEGACY_BASE_UNVERIFIED',
      );

      const review = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: scenario.reviewId });
      const marker = `<!-- git-review:legacy:${scenario.reviewId}:${scenario.markdownHash} -->`;
      expect(result).toMatchObject({ status: 'posted', canRetry: false, baseAcknowledged: true });
      expect(provider.postedBodies).toEqual([`${markdown}\n\n${marker}`]);
      expect(provider.notes).toContainEqual({ id: 901, body: `${markdown}\n\n${marker}`, author: { id: 501 } });
      expect(review?.get('reviewMarkdown')).toBe(markdown);
      expect(review?.get('postStatus')).toBe('posted');
      expect(review?.get('legacyPostSource')).toMatchObject({
        projectKey: scenario.projectKey,
        repositoryId: scenario.fixture.repositoryId,
        mrIid: 41,
        headSha: 'b'.repeat(40),
        baseSha: 'a'.repeat(40),
      });
      expect(review?.get('legacyBaseProvenance')).toBe('unverified_legacy');
      expect(review?.get('legacyBaseAcknowledgedBy')).toBe(String(actorId));
      expect(
        await app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: scenario.reviewId } }),
      ).toBeNull();
    },
  );

  it('lets root release the canonical project hold after a marked legacy receipt and a failed second lookup', async () => {
    const provider = stubProviderFetch();
    await app.db.getCollection('gitReviewCutover').model.update({ state: 'ready' }, { where: { key: 'global' } });
    const markdown = '## Historical receipt\n\nThe marker proves the exact prior note.';
    const scenario = await createLegacyPostScenario('historical-marked-receipt', 42, markdown, 'post_unknown');
    const marker = `<!-- git-review:legacy:${scenario.reviewId}:${scenario.markdownHash} -->`;
    provider.notes.push({ id: 995, body: `${markdown}\n\n${marker}`, author: { id: 501 } });
    provider.failNoteListAfter(1);

    await expect(
      legacyPostService.retry(scenario.reviewId, actorId, actorRoles, scenario.attemptId, undefined),
    ).rejects.toThrow('Injected note lookup failure');

    const held = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: scenario.reviewId });
    const heldProject = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: scenario.projectKey } });
    expect(held?.get('postStatus')).toBe('post_unknown');
    const currentAttempt = String(held?.get('legacyPostClaim'));
    expect(currentAttempt).not.toBe(scenario.attemptId);
    expect(heldProject?.get('legacyPostReviewId')).toBe(scenario.reviewId);
    expect(provider.postedBodies).toHaveLength(0);

    await legacyPostService.releaseHold(scenario.reviewId, actorId, actorRoles, currentAttempt);

    const released = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: scenario.projectKey } });
    const releasedReview = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: scenario.reviewId });
    expect(released?.get('legacyPostReviewId')).toBeNull();
    expect(releasedReview?.get('legacyHoldReleasedBy')).toBe(String(actorId));
    expect(releasedReview?.get('legacyPostClaim')).not.toBe(currentAttempt);
  });

  it('does not post managed review content after root resets its claim during the awaited head check', async () => {
    const provider = stubProviderFetch();
    const markdown = '## Stale managed claim\n\nNo post may start after reset.';
    const seeded = await createCompletedManagedReview('retry-reset-during-head', 43, markdown);
    const gate = provider.holdNextMergeRequest();
    const retry = service.retryPost(seeded.reviewId, actorId, actorRoles, true);
    try {
      await gate.entered;
      const claimed = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: seeded.request.get('id') });
      const attemptId = String(claimed?.get('postClaim'));
      expect(attemptId).not.toBe('null');
      await service.resetPostClaim(seeded.reviewId, actorId, attemptId);
    } finally {
      gate.release();
    }

    await expect(retry).rejects.toThrow();
    expect(
      provider.fetchMock.mock.calls.some(([, init]) => String(init?.method || 'GET').toUpperCase() === 'POST'),
    ).toBe(false);
    const request = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: seeded.request.get('id') });
    const project = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: seeded.projectKey } });
    expect(request?.get('postClaim')).toBeNull();
    expect(project?.get('activeInboxId')).toBeNull();
  });

  it('does not post a legacy review after root releases its hold during the awaited head check', async () => {
    const provider = stubProviderFetch();
    const scenario = await createLegacyPostScenario(
      'legacy-reset-during-head',
      44,
      '## Stale legacy claim\n\nNo post may start after release.',
      'post_failed',
      true,
    );
    const gate = provider.holdNextMergeRequest(async () => {
      const current = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: scenario.reviewId });
      return current?.get('postStatus') === 'posting' && String(current?.get('legacyPostClaim')) !== scenario.attemptId;
    });
    const manager = app.pm.get('plugin-git-manager') as PluginGitManagerServer;
    expect(manager.reviewService === service).toBe(true);
    expect((await service.cutoverStatus()).state).toBe('ready');
    const retry = legacyPostService.retry(scenario.reviewId, actorId, actorRoles, scenario.attemptId, undefined);
    let attemptId = scenario.attemptId;
    try {
      const reachedClaimedHeadCheck = await Promise.race([
        gate.entered.then(() => true),
        retry.then(
          () => false,
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Legacy retry failed before the gated head check: ${message}`);
          },
        ),
      ]);
      expect(reachedClaimedHeadCheck).toBe(true);
      const claimed = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: scenario.reviewId });
      attemptId = String(claimed?.get('legacyPostClaim'));
      expect(attemptId).not.toBe(scenario.attemptId);
      await legacyPostService.releaseHold(scenario.reviewId, actorId, actorRoles, attemptId);
    } finally {
      gate.release();
    }

    await expect(retry).rejects.toThrow();
    expect(
      provider.fetchMock.mock.calls.some(([, init]) => String(init?.method || 'GET').toUpperCase() === 'POST'),
    ).toBe(false);
    const review = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: scenario.reviewId });
    const project = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: scenario.projectKey } });
    expect(review?.get('legacyPostClaim')).not.toBe(attemptId);
    expect(project?.get('legacyPostReviewId')).toBeNull();
  });

  it('retains a managed publication claim when recording post_unknown fails after POST starts', async () => {
    const provider = stubProviderFetch();
    provider.failNextNotePost();
    const seeded = await createCompletedManagedReview(
      'retry-retain-claim-after-status-write-failure',
      45,
      '## Unknown outcome\n\nRetain the reservation when status persistence fails.',
    );
    const reviewModel = app.db.getCollection('gitCodeReviews').model;
    const originalUpdate = reviewModel.update.bind(reviewModel);
    const updateSpy = vi.spyOn(reviewModel, 'update').mockImplementation(async (values, options) => {
      const changedValues = values as unknown as Record<string, unknown>;
      if (changedValues.postStatus === 'post_unknown') throw new Error('Injected post_unknown write failure');
      return originalUpdate(values, options);
    });
    try {
      await expect(service.retryPost(seeded.reviewId, actorId, actorRoles, true)).rejects.toThrow(
        'Injected post_unknown write failure',
      );
    } finally {
      updateSpy.mockRestore();
    }

    expect(
      provider.fetchMock.mock.calls.some(([, init]) => String(init?.method || 'GET').toUpperCase() === 'POST'),
    ).toBe(true);
    const review = await app.db.getRepository('gitCodeReviews').findOne({ filterByTk: seeded.reviewId });
    const request = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: seeded.request.get('id') });
    const project = await app.db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: seeded.projectKey } });
    expect(review?.get('postStatus')).toBe('retrying');
    expect(typeof request?.get('postClaim')).toBe('string');
    expect(project?.get('activeInboxId')).toBe(seeded.inbox.get('id'));
  });
});
