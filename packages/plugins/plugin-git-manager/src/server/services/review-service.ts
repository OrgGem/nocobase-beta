/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'crypto';
import type { Application } from '@nocobase/server';
import { Transaction } from 'sequelize';
import { branchMatches, pickFlowMatchingBranch, resolveBackgroundReviewRoles } from '../actions/review';
import { hasRepositoryAccess } from '../repository-access';
import {
  assertCurrentMrHead,
  findPublishedReview,
  PinnedReviewSource,
  publishPinnedReview,
  readPinnedReviewSource,
  resolveReviewProjectKey,
  resolveReviewSource,
  ReviewTarget,
} from './review-source';

type Id = number | string;
type Getter = { get(name: string): unknown };

export interface ReviewAdmission {
  flowId?: number | null;
  repositoryId: number;
  targetType: ReviewTarget;
  mrIid?: number | null;
  commitSha?: string | null;
  branch?: string | null;
  folderPath?: string | null;
  headSha?: string | null;
  extraInstructions?: string;
  triggeredBy?: 'manual' | 'poll';
  eventType?: 'change_opened' | 'head_changed';
  userId?: Id | null;
  actorRoles?: string[];
  legacyReviewId?: number;
}

interface ReviewPayload {
  source: PinnedReviewSource;
  flowId: number;
  workflowId: Id;
  workflowKey: string;
  eventType: 'manual' | 'change_opened' | 'head_changed';
  userId: Id | null;
  actorRoles: string[];
  instructions: string;
  postMode: 'manual' | 'auto' | 'disabled';
}

function value<T>(record: Getter, key: string): T {
  return record.get(key) as T;
}

function fingerprint(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function reviewConflict(message: string): never {
  const error = new Error(message) as Error & { status: number };
  error.status = 409;
  throw error;
}

function legacyBlockReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/Legacy review has no pinned source commit/.test(message)) return 'missing_pinned_head';
  if (/Legacy branch review has no pinned base/.test(message)) return 'missing_pinned_base';
  if (/head changed before review admission/.test(message)) return 'head_changed';
  if (/actor has no unambiguous role|actor roles/.test(message)) return 'actor_role_ambiguous';
  if (/authenticated actor|actor does not have repository access|unable to resolve roles/i.test(message))
    return 'actor_unavailable';
  if (/flow|workflow/i.test(message)) return 'flow_or_workflow_unavailable';
  if (/Repository not found|project|origin/i.test(message)) return 'repository_unavailable';
  return 'migration_failed';
}

/** The reservation is deliberately not a lease: no clock expiry can prove an AI call stopped. */
export class GitReviewService {
  readonly version = 1;
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(private readonly app: Application) {}

  async enqueue(input: ReviewAdmission): Promise<number> {
    const db = this.app.db;
    await this.cutoverStatus();
    const repo = await db.getRepository('gitRepositories').findOne({ filterByTk: input.repositoryId });
    if (!repo) throw new Error('Repository not found');
    const source = await resolveReviewSource(db, repo, input);
    const flows = db.getRepository('gitReviewFlows');
    const candidates = input.flowId
      ? [await flows.findOne({ filterByTk: input.flowId })].filter(Boolean)
      : await flows.find({
          filter: { enabled: true, $or: [{ repositoryId: input.repositoryId }, { repositoryId: null }] },
          sort: ['-repositoryId'],
        });
    const flow = input.flowId ? candidates[0] : pickFlowMatchingBranch(candidates, source.branch || undefined);
    if (!flow || !value<boolean>(flow, 'enabled')) throw new Error('No enabled review flow found');
    const flowRepoId = value<Id | null>(flow, 'repositoryId');
    if (flowRepoId != null && String(flowRepoId) !== String(input.repositoryId))
      throw new Error('Review flow does not belong to this repository');
    if (source.branch && !branchMatches(flow, source.branch))
      throw new Error('Source branch does not match review flow');
    const eventType = input.triggeredBy === 'poll' ? input.eventType || 'change_opened' : 'manual';
    const triggerMode = value<string>(flow, 'triggerMode');
    if (eventType !== 'manual' && !['onMergeRequestCreated', 'both'].includes(triggerMode))
      throw new Error('Flow does not permit automatic review');
    if (eventType === 'head_changed' && !value<boolean>(flow, 'reviewOnNewCommits'))
      throw new Error('Review of new commits is not enabled');
    if (eventType === 'manual' && !['manual', 'both'].includes(triggerMode))
      throw new Error('Flow does not permit manual review');
    const workflowKey = value<string>(flow, 'workflowKey');
    if (!workflowKey) throw new Error('Review flow has not been bound to a workflow');
    const boundWorkflowId = value<Id | null>(flow, 'workflowId');
    if (boundWorkflowId) {
      const bound = await db.getRepository('workflows').findOne({ filterByTk: boundWorkflowId });
      const options = bound ? value<{ gitReview?: { draft?: boolean } }>(bound, 'options') : null;
      if (options?.gitReview?.draft === true) throw new Error('Review workflow setup is incomplete');
    }
    const workflow = await db
      .getRepository('workflows')
      .findOne({ filter: { key: workflowKey, current: true, enabled: true } });
    if (!workflow) throw new Error('Review workflow is not enabled');
    const workflowId = value<Id>(workflow, 'id');
    const postMode = value<string>(flow, 'postMode');
    const actorId = eventType === 'manual' ? input.userId ?? null : value<Id | null>(flow, 'createdById');
    if (actorId == null) throw new Error('Review requires an authenticated actor');
    const currentRoles = await resolveBackgroundReviewRoles(db, actorId);
    const actorRoles = eventType === 'manual' ? input.actorRoles || [] : currentRoles;
    if (!actorRoles.length || actorRoles.some((role) => !currentRoles.includes(role)))
      throw new Error('Review actor roles are unavailable or changed');
    if (
      !(await hasRepositoryAccess({
        acl: this.app.acl,
        roles: actorRoles,
        repositoryId: input.repositoryId,
        action: 'triggerReview',
      }))
    )
      throw new Error('Review actor does not have repository access');
    const payload: ReviewPayload = {
      source,
      flowId: value<number>(flow, 'id'),
      workflowId,
      workflowKey,
      eventType,
      userId: actorId,
      actorRoles,
      instructions: [value<string | null>(flow, 'instructions'), input.extraInstructions].filter(Boolean).join('\n\n'),
      postMode:
        source.targetType !== 'mr' ? 'disabled' : postMode === 'auto' || postMode === 'disabled' ? postMode : 'manual',
    };
    await this.assertSafeWorkflow(workflowId, payload.postMode, undefined, input.repositoryId);
    const eventKey =
      eventType !== 'manual' && !input.legacyReviewId
        ? fingerprint(
            `${source.projectKey}:mr:${source.mrIid}${
              value<boolean>(flow, 'reviewOnNewCommits') ? `:${source.headSha}` : ''
            }`,
          )
        : null;
    const inboxRepo = db.getRepository('gitReviewInbox');
    if (eventKey) {
      const existing = await inboxRepo.findOne({ filter: { eventKey } });
      if (existing) return value<number>(existing, 'reviewId');
    }
    if (input.legacyReviewId) {
      const existing = await inboxRepo.findOne({ filter: { legacyReviewId: input.legacyReviewId } });
      if (existing) return value<number>(existing, 'reviewId');
    }
    await this.ensureReviewProject(source.projectKey);
    let reviewId: number;
    try {
      reviewId = await db.sequelize.transaction(async (transaction) => {
        const reviews = db.getRepository('gitCodeReviews');
        const values = {
          flowId: payload.flowId,
          repositoryId: input.repositoryId,
          targetType: source.targetType,
          mrIid: source.mrIid,
          commitSha: source.targetType === 'commit' ? source.headSha : null,
          branch: source.branch,
          folderPath: source.folderPath,
          headSha: source.headSha,
          latestSha: source.headSha,
          triggeredBy: eventType === 'manual' ? 'manual' : 'poll',
          status: 'queued',
          postStatus: source.targetType === 'mr' && payload.postMode !== 'disabled' ? 'pending_approval' : 'skipped',
          createdById: payload.userId,
          metadata: { workflowManaged: true },
          startedAt: null,
          finishedAt: null,
          error: null,
        };
        let review: Getter;
        if (input.legacyReviewId) {
          const legacyReview = await db.getCollection('gitCodeReviews').model.findOne({
            where: { id: input.legacyReviewId },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!legacyReview || value<string>(legacyReview, 'status') !== 'pending')
            throw new Error('Legacy review is no longer pending');
          review = legacyReview;
          const [changed] = await db.getCollection('gitCodeReviews').model.update(values, {
            where: { id: input.legacyReviewId, status: 'pending' },
            transaction,
          });
          if (changed !== 1) throw new Error('Legacy review is no longer pending');
        } else {
          review = await reviews.create({ values, transaction });
        }
        const id = value<number>(review, 'id');
        await inboxRepo.create({
          values: {
            projectKey: source.projectKey,
            repositoryId: input.repositoryId,
            reviewId: id,
            legacyReviewId: input.legacyReviewId || null,
            eventKey,
            queuedAt: input.legacyReviewId ? value<Date>(review, 'createdAt') || new Date() : new Date(),
            state: 'queued',
            payload,
          },
          transaction,
        });
        return id;
      });
    } catch (error) {
      if (eventKey) {
        const existing = await inboxRepo.findOne({ filter: { eventKey } });
        if (existing) return value<number>(existing, 'reviewId');
      }
      if (input.legacyReviewId) {
        const existing = await inboxRepo.findOne({ filter: { legacyReviewId: input.legacyReviewId } });
        if (existing) return value<number>(existing, 'reviewId');
      }
      throw error;
    }
    await this.reconcile().catch((error) => this.app.log?.error?.('Git review dispatch will be retried', error));
    return reviewId;
  }

  async ensureReviewProject(projectKey: string): Promise<void> {
    const db = this.app.db;
    const model = db.getCollection('gitReviewProjects').model;
    for (let attempt = 0; ; attempt++) {
      try {
        await model.findOrCreate({ where: { projectKey }, defaults: { projectKey } });
        return;
      } catch (error) {
        const sqliteError = error as { code?: string; original?: { code?: string }; parent?: { code?: string } };
        const busy = [sqliteError.code, sqliteError.original?.code, sqliteError.parent?.code].includes('SQLITE_BUSY');
        if (db.sequelize.getDialect() !== 'sqlite' || !busy || attempt >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 400)));
      }
    }
  }

  private async assertSafeWorkflow(
    workflowId: Id,
    postMode: ReviewPayload['postMode'],
    transaction?: Transaction,
    repositoryId?: Id,
  ): Promise<void> {
    const integration = (this.app.pm.get('plugin-workflow-git-review') ||
      this.app.pm.get('workflow-git-review')) as unknown as
      | {
          enabled?: boolean;
          assertSafeWorkflow?: (
            id: Id,
            mode: ReviewPayload['postMode'],
            transaction?: Transaction,
            repositoryId?: Id,
          ) => Promise<void>;
        }
      | undefined;
    if (integration?.enabled !== true || !integration.assertSafeWorkflow)
      throw new Error('Git review workflow integration is unavailable');
    await integration.assertSafeWorkflow(workflowId, postMode, transaction, repositoryId);
  }

  private async legacyRows(): Promise<Getter[]> {
    const db = this.app.db;
    const candidates = await db
      .getRepository('gitCodeReviews')
      .find({ filter: { status: { $in: ['pending', 'running'] } }, sort: ['id'] });
    const legacy: Getter[] = [];
    for (const review of candidates) {
      if (!(await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: value<Id>(review, 'id') } })))
        legacy.push(review);
    }
    return legacy;
  }

  async cutoverStatus(): Promise<{
    state: string;
    legacyPending: number;
    legacyRunning: number;
    legacyPendingReviews: Array<{ legacyReviewId: Id; repositoryId: Id; reason: string }>;
    legacyRunningReviews: Array<{ legacyReviewId: Id }>;
    legacyUncertain: number;
    legacyUncertainReviews: Array<{ legacyReviewId: Id; repositoryId: Id }>;
    quarantined: Array<{ requestId: Id; executionId: Id | null; reviewId: Id; reason: string }>;
    orphaned: Array<{ inboxId: Id; reviewId: Id }>;
    postUnknownReviews: Array<{ reviewId: Id; postStatus: string; hasClaim: boolean; attemptId: string | null }>;
    legacyPublicationHolds: Array<{ reviewId: Id; repositoryId: Id | null; attemptId: string | null }>;
    queuedBlockedReviews: Array<{ inboxId: Id; reviewId: Id; repositoryId: Id; reason: string }>;
  }> {
    const db = this.app.db;
    const model = db.getCollection('gitReviewCutover').model;
    const existingCount = await db.getRepository('gitCodeReviews').count();
    let record = await model.findOne({ where: { key: 'global' } });
    for (let attempt = 0; !record; attempt++) {
      try {
        [record] = await model.findOrCreate({
          where: { key: 'global' },
          defaults: { key: 'global', state: existingCount ? 'awaiting_confirmation' : 'ready' },
        });
      } catch (error) {
        const sqliteError = error as { original?: { code?: string }; parent?: { code?: string } };
        const busy = sqliteError.original?.code === 'SQLITE_BUSY' || sqliteError.parent?.code === 'SQLITE_BUSY';
        if (!busy || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        record = await model.findOne({ where: { key: 'global' } });
      }
    }
    const legacy = await this.legacyRows();
    const failed = await db.getRepository('gitCodeReviews').find({ filter: { status: 'failed' }, sort: ['id'] });
    const uncertain: Getter[] = [];
    for (const review of failed) {
      const metadata = value<Record<string, unknown> | null>(review, 'metadata');
      if (!value<Date | null>(review, 'startedAt') || metadata?.workflowManaged) continue;
      if (!(await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId: value<Id>(review, 'id') } })))
        uncertain.push(review);
    }
    const activeRows = await db
      .getRepository('gitReviewInbox')
      .find({ filter: { state: { $in: ['dispatched', 'running', 'quarantined'] } }, sort: ['id'] });
    const quarantined: Array<{ requestId: Id; executionId: Id | null; reviewId: Id; reason: string }> = [];
    const orphaned: Array<{ inboxId: Id; reviewId: Id }> = [];
    const postUnknownReviews: Array<{ reviewId: Id; postStatus: string; hasClaim: boolean; attemptId: string | null }> =
      [];
    const legacyPublicationHolds: Array<{ reviewId: Id; repositoryId: Id | null; attemptId: string | null }> = [];
    const legacyProjects = await db.getRepository('gitReviewProjects').find({
      filter: { legacyPostReviewId: { $ne: null } },
      sort: ['id'],
      limit: 100,
    });
    for (const project of legacyProjects) {
      const reviewId = value<Id>(project, 'legacyPostReviewId');
      const heldReview = await db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
      legacyPublicationHolds.push({
        reviewId,
        repositoryId: heldReview ? value<Id>(heldReview, 'repositoryId') : null,
        attemptId: heldReview ? value<string | null>(heldReview, 'legacyPostClaim') ?? null : null,
      });
    }
    const queuedBlocked = await db
      .getRepository('gitReviewInbox')
      .find({ filter: { state: 'queued', blockedReason: { $ne: null } }, sort: ['queuedAt', 'id'], limit: 100 });
    const unresolved = await db
      .getRepository('gitCodeReviews')
      .find({ filter: { postStatus: { $in: ['posting', 'post_unknown', 'post_failed', 'retrying'] } }, sort: ['id'] });
    for (const review of unresolved) {
      if (
        value<{ workflowManaged?: boolean } | null>(review, 'metadata')?.workflowManaged &&
        postUnknownReviews.length < 100
      ) {
        const inbox = await db
          .getRepository('gitReviewInbox')
          .findOne({ filter: { reviewId: value<Id>(review, 'id') } });
        const request =
          inbox &&
          (await db.getRepository('gitReviewRequests').findOne({ filter: { inboxId: value<Id>(inbox, 'id') } }));
        const attemptId = request ? value<string | null>(request, 'postClaim') ?? null : null;
        postUnknownReviews.push({
          reviewId: value<Id>(review, 'id'),
          postStatus: value<string>(review, 'postStatus'),
          hasClaim: attemptId != null,
          attemptId,
        });
      }
    }
    for (const inbox of activeRows) {
      const request = await db
        .getRepository('gitReviewRequests')
        .findOne({ filter: { inboxId: value<Id>(inbox, 'id') } });
      if (!request) {
        if (orphaned.length < 100)
          orphaned.push({ inboxId: value<Id>(inbox, 'id'), reviewId: value<Id>(inbox, 'reviewId') });
        continue;
      }
      const executionId = value<Id | null>(request, 'executionId');
      const execution =
        executionId == null || !db.getCollection('executions')
          ? null
          : await db.getRepository('executions').findOne({ filterByTk: executionId });
      const reason =
        value<string>(inbox, 'state') === 'quarantined'
          ? 'quarantined'
          : executionId == null
            ? 'unclaimed'
            : !execution
              ? 'execution_missing'
              : null;
      if (reason && quarantined.length < 100)
        quarantined.push({
          requestId: value<Id>(request, 'id'),
          executionId,
          reviewId: value<Id>(request, 'reviewId'),
          reason,
        });
    }
    return {
      state: value<string>(record, 'state'),
      legacyPending: legacy.filter((review) => value<string>(review, 'status') === 'pending').length,
      legacyRunning: legacy.filter((review) => value<string>(review, 'status') === 'running').length,
      legacyPendingReviews: legacy
        .filter((review) => value<string>(review, 'status') === 'pending')
        .slice(0, 100)
        .map((review) => ({
          legacyReviewId: value<Id>(review, 'id'),
          repositoryId: value<Id>(review, 'repositoryId'),
          reason:
            value<{ migrationBlockedReason?: string } | null>(review, 'metadata')?.migrationBlockedReason ||
            'not_migrated',
        })),
      legacyRunningReviews: legacy
        .filter((review) => value<string>(review, 'status') === 'running')
        .slice(0, 100)
        .map((review) => ({ legacyReviewId: value<Id>(review, 'id') })),
      legacyUncertain: uncertain.length,
      legacyUncertainReviews: uncertain.slice(0, 100).map((review) => ({
        legacyReviewId: value<Id>(review, 'id'),
        repositoryId: value<Id>(review, 'repositoryId'),
      })),
      quarantined,
      orphaned,
      postUnknownReviews,
      legacyPublicationHolds,
      queuedBlockedReviews: queuedBlocked.map((item: Getter) => ({
        inboxId: value<Id>(item, 'id'),
        reviewId: value<Id>(item, 'reviewId'),
        repositoryId: value<Id>(item, 'repositoryId'),
        reason: value<string>(item, 'blockedReason'),
      })),
    };
  }

  async confirmCutover(actor: Id): Promise<void> {
    await this.cutoverStatus();
    await this.app.db
      .getCollection('gitReviewCutover')
      .model.update(
        { state: 'ready', confirmedBy: String(actor), confirmedAt: new Date() },
        { where: { key: 'global', state: 'awaiting_confirmation' } },
      );
    await this.reconcile();
  }

  private async legacyBlockedProjects(): Promise<{ keys: Set<string>; unknown: boolean }> {
    const db = this.app.db;
    const keys = new Set<string>();
    for (const review of await this.legacyRows()) {
      try {
        const repo = await db
          .getRepository('gitRepositories')
          .findOne({ filterByTk: value<Id>(review, 'repositoryId') });
        if (!repo) return { keys, unknown: true };
        keys.add(await resolveReviewProjectKey(db, repo));
      } catch {
        return { keys, unknown: true };
      }
    }
    return { keys, unknown: false };
  }

  async recoverLegacy(reviewId: Id, actor: Id): Promise<void> {
    const db = this.app.db;
    if ((await this.cutoverStatus()).state !== 'ready') throw new Error('Review cutover has not been confirmed');
    if (await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } }))
      throw new Error('Review is managed by workflow');
    const [changed] = await db
      .getCollection('gitCodeReviews')
      .model.update(
        { status: 'failed', error: `Legacy worker stop confirmed by ${String(actor)}`, finishedAt: new Date() },
        { where: { id: reviewId, status: 'running' } },
      );
    if (changed !== 1) throw new Error('Legacy review is not running');
    await this.reconcile();
  }

  async cancelLegacy(reviewId: Id, actor: Id): Promise<void> {
    const db = this.app.db;
    if ((await this.cutoverStatus()).state !== 'ready') throw new Error('Review cutover has not been confirmed');
    await db.sequelize.transaction(async (transaction) => {
      const review = await db
        .getCollection('gitCodeReviews')
        .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!review || value<string>(review, 'status') !== 'pending') throw new Error('Legacy review is not pending');
      if (await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId }, transaction }))
        throw new Error('Review is managed by workflow');
      const metadata = value<Record<string, unknown> | null>(review, 'metadata') || {};
      const [changed] = await db.getCollection('gitCodeReviews').model.update(
        {
          status: 'failed',
          error: 'Legacy review canceled during workflow migration',
          finishedAt: new Date(),
          metadata: {
            ...metadata,
            migrationCanceledBy: String(actor),
            migrationCanceledAt: new Date().toISOString(),
          },
        },
        { where: { id: reviewId, status: 'pending' }, transaction },
      );
      if (changed !== 1) throw new Error('Legacy review is no longer pending');
    });
    await this.reconcile();
  }

  async cancelQueued(inboxId: Id, actor: Id): Promise<void> {
    const db = this.app.db;
    await db.sequelize.transaction(async (transaction) => {
      const inbox = await db
        .getCollection('gitReviewInbox')
        .model.findOne({ where: { id: inboxId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!inbox || value<string>(inbox, 'state') !== 'queued') reviewConflict('Review is no longer queued');
      if (await db.getRepository('gitReviewRequests').findOne({ filter: { inboxId }, transaction }))
        reviewConflict('Review has already been dispatched');
      const project = await db.getCollection('gitReviewProjects').model.findOne({
        where: { projectKey: value<string>(inbox, 'projectKey') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (project && String(value<Id | null>(project, 'activeInboxId')) === String(inboxId))
        reviewConflict('Review already owns a project reservation');
      await inbox.update(
        {
          state: 'canceled',
          blockedReason: 'canceled_by_operator',
          recoveredBy: String(actor),
          recoveredAt: new Date(),
        },
        { transaction },
      );
      await db.getRepository('gitCodeReviews').update({
        filterByTk: value<Id>(inbox, 'reviewId'),
        values: { status: 'failed', error: 'Queued review canceled by operator', finishedAt: new Date() },
        transaction,
      });
    });
    await this.reconcile();
  }

  async recover(requestId: Id, executionId: Id | null, actor: Id): Promise<void> {
    const db = this.app.db;
    await db.sequelize.transaction(async (transaction) => {
      const request = await db
        .getCollection('gitReviewRequests')
        .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!request || value<boolean>(request, 'fenced')) throw new Error('Review request is unavailable');
      const owner = value<Id | null>(request, 'executionId');
      if ((owner == null) !== (executionId == null) || (owner != null && String(owner) !== String(executionId)))
        throw new Error('Execution does not own request');
      const execution =
        owner == null || !db.getCollection('executions')
          ? null
          : await db
              .getCollection('executions')
              .model.findOne({ where: { id: owner }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        execution &&
        (typeof value<unknown>(execution, 'status') !== 'number' || value<number>(execution, 'status') === 0)
      )
        throw new Error('Execution is not terminal');
      const inbox = await db.getCollection('gitReviewInbox').model.findOne({
        where: { id: value<Id>(request, 'inboxId') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!inbox || !['dispatched', 'running', 'quarantined'].includes(value<string>(inbox, 'state')))
        throw new Error('Review is not recoverable');
      if (execution && value<string>(inbox, 'state') !== 'quarantined' && value<number>(execution, 'status') > 0)
        throw new Error('Completed review is not quarantined');
      await db.getCollection('gitReviewProjects').model.findOne({
        where: { projectKey: value<string>(inbox, 'projectKey') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const review = await db.getCollection('gitCodeReviews').model.findOne({
        where: { id: value<Id>(request, 'reviewId') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !review ||
        value<string | null>(request, 'postClaim') ||
        ['posting', 'post_unknown', 'post_failed', 'retrying'].includes(value<string>(review, 'postStatus'))
      ) {
        reviewConflict('Resolve publication or reset the stopped post attempt before recovery');
      }
      const [fenced] = await db
        .getCollection('gitReviewRequests')
        .model.update({ fenced: true }, { where: { id: requestId, fenced: false }, transaction });
      if (fenced !== 1) throw new Error('Review request could not be fenced');
      await db.getCollection('gitReviewProjects').model.update(
        { activeInboxId: null },
        {
          where: { projectKey: value<string>(inbox, 'projectKey'), activeInboxId: value<Id>(inbox, 'id') },
          transaction,
        },
      );
      await db.getRepository('gitReviewInbox').update({
        filterByTk: value<Id>(inbox, 'id'),
        values: { state: 'recovered', recoveredBy: String(actor), recoveredAt: new Date() },
        transaction,
      });
      await db.getRepository('gitCodeReviews').update({
        filterByTk: value<Id>(request, 'reviewId'),
        values: { status: 'failed', error: 'Review execution was stopped and recovered', finishedAt: new Date() },
        transaction,
      });
    });
    await this.reconcile();
  }

  async recoverOrphaned(inboxId: Id, actor: Id): Promise<void> {
    const db = this.app.db;
    await db.sequelize.transaction(async (transaction) => {
      const inbox = await db
        .getCollection('gitReviewInbox')
        .model.findOne({ where: { id: inboxId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!inbox || !['dispatched', 'running', 'quarantined'].includes(value<string>(inbox, 'state')))
        throw new Error('Review is not recoverable');
      if (await db.getRepository('gitReviewRequests').findOne({ filter: { inboxId }, transaction }))
        throw new Error('Review request exists');
      await db
        .getCollection('gitReviewProjects')
        .model.update(
          { activeInboxId: null },
          { where: { projectKey: value<string>(inbox, 'projectKey'), activeInboxId: inboxId }, transaction },
        );
      await db.getRepository('gitReviewInbox').update({
        filterByTk: inboxId,
        values: { state: 'recovered', recoveredBy: String(actor), recoveredAt: new Date() },
        transaction,
      });
      await db.getRepository('gitCodeReviews').update({
        filterByTk: value<Id>(inbox, 'reviewId'),
        values: { status: 'failed', error: 'Orphaned review was stopped and recovered', finishedAt: new Date() },
        transaction,
      });
    });
    await this.reconcile();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.reconcile().catch((error) => this.app.log?.error?.('Git review reconciliation failed', error)),
      5000,
    );
    this.reconcile().catch((error) => this.app.log?.error?.('Git review reconciliation failed', error));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const status = await this.cutoverStatus();
      if (status.state !== 'ready') return;
      await this.migrateLegacy();
      const db = this.app.db;
      const blocked = await this.legacyBlockedProjects();
      if (blocked.unknown) return;
      const pending = await db
        .getRepository('gitReviewInbox')
        .find({ filter: { state: 'queued' }, sort: ['queuedAt', 'id'] });
      const seen = new Set<string>();
      for (const inbox of pending) {
        const projectKey = value<string>(inbox, 'projectKey');
        if (blocked.keys.has(projectKey)) continue;
        if (seen.has(projectKey)) continue;
        seen.add(projectKey);
        const payload = value<ReviewPayload>(inbox, 'payload');
        try {
          const outcome = await db.sequelize.transaction(async (transaction) => {
            const inboxId = value<number>(inbox, 'id');
            const queued = await db
              .getCollection('gitReviewInbox')
              .model.findOne({ where: { id: inboxId }, transaction, lock: transaction.LOCK.UPDATE });
            if (!queued || value<string>(queued, 'state') !== 'queued') return 'stale';
            const flow = await db.getRepository('gitReviewFlows').findOne({ filterByTk: payload.flowId, transaction });
            if (!flow) {
              await queued.update({ state: 'canceled', blockedReason: 'flow_deleted' }, { transaction });
              await db.getRepository('gitCodeReviews').update({
                filterByTk: value<Id>(queued, 'reviewId'),
                values: {
                  status: 'failed',
                  error: 'Review flow was deleted before dispatch',
                  finishedAt: new Date(),
                },
                transaction,
              });
              return 'canceled';
            }
            if (!value<boolean>(flow, 'enabled')) {
              await queued.update({ blockedReason: 'flow_disabled' }, { transaction });
              return 'blocked';
            }
            if (value<string>(flow, 'workflowKey') !== payload.workflowKey) {
              await queued.update({ blockedReason: 'workflow_binding_changed' }, { transaction });
              return 'blocked';
            }
            const boundId = value<Id | null>(flow, 'workflowId');
            if (boundId) {
              const bound = await db.getRepository('workflows').findOne({ filterByTk: boundId, transaction });
              if (
                !bound ||
                value<{ gitReview?: { draft?: boolean } } | null>(bound, 'options')?.gitReview?.draft === true
              ) {
                await queued.update({ blockedReason: 'workflow_setup_incomplete' }, { transaction });
                return 'blocked';
              }
            }
            const workflow = await db.getRepository('workflows').findOne({
              filter: { key: payload.workflowKey, current: true, enabled: true },
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (!workflow) {
              await queued.update({ blockedReason: 'workflow_disabled' }, { transaction });
              return 'blocked';
            }
            const workflowId = value<Id>(workflow, 'id');
            await this.assertSafeWorkflow(workflowId, payload.postMode, transaction, payload.source.repositoryId);
            const [claimed] = await db
              .getCollection('gitReviewProjects')
              .model.update(
                { activeInboxId: inboxId },
                { where: { projectKey, activeInboxId: null, legacyPostReviewId: null }, transaction },
              );
            if (claimed !== 1) {
              if (value<string | null>(queued, 'blockedReason'))
                await queued.update({ blockedReason: null }, { transaction });
              return 'busy';
            }
            await queued.update(
              { state: 'dispatched', blockedReason: null, payload: { ...payload, workflowId } },
              { transaction },
            );
            await db.getRepository('gitReviewRequests').create({
              values: {
                inboxId,
                reviewId: value<number>(inbox, 'reviewId'),
                repositoryId: value<number>(inbox, 'repositoryId'),
                flowId: payload.flowId,
                workflowId,
                workflowKey: payload.workflowKey,
                eventType: payload.eventType,
              },
              transaction,
            });
            return 'dispatched';
          });
          if (outcome === 'canceled' || outcome === 'stale') seen.delete(projectKey);
        } catch (error) {
          const reason =
            error instanceof Error && error.message === 'No configured approver can access this repository'
              ? 'approver_unavailable'
              : 'workflow_unavailable';
          await db
            .getCollection('gitReviewInbox')
            .model.update({ blockedReason: reason }, { where: { id: value<Id>(inbox, 'id'), state: 'queued' } });
          this.app.log?.warn?.(
            `Git review ${String(value<Id>(inbox, 'reviewId'))} is waiting for a safe workflow revision`,
          );
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async migrateLegacy(): Promise<void> {
    const db = this.app.db;
    const reviews = db.getRepository('gitCodeReviews');
    const legacy = await reviews.find({ filter: { status: { $in: ['pending', 'running'] } }, sort: ['id'] });
    for (const review of legacy) {
      const reviewId = value<number>(review, 'id');
      if (await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } })) continue;
      if (value<string>(review, 'status') === 'running') continue;
      const metadata = value<Record<string, unknown>>(review, 'metadata') || {};
      try {
        const targetType = value<ReviewTarget>(review, 'targetType');
        const pinnedHead = value<string | null>(review, 'headSha');
        const commitSha = value<string | null>(review, 'commitSha');
        if (targetType === 'branch') throw new Error('Legacy branch review has no pinned base');
        const pinned = pinnedHead || (targetType === 'commit' ? commitSha : null);
        if (!pinned || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pinned))
          throw new Error('Legacy review has no pinned source commit');
        const legacyActor = value<Id | null>(review, 'createdById');
        const legacyRoles = legacyActor ? await resolveBackgroundReviewRoles(db, legacyActor) : [];
        if (value<string>(review, 'triggeredBy') !== 'poll' && legacyRoles.length !== 1) {
          throw new Error('Legacy review actor has no unambiguous role');
        }
        await this.enqueue({
          legacyReviewId: reviewId,
          repositoryId: value<number>(review, 'repositoryId'),
          flowId: value<number>(review, 'flowId'),
          targetType,
          mrIid: value<number | null>(review, 'mrIid'),
          commitSha,
          branch: value<string | null>(review, 'branch'),
          folderPath: value<string | null>(review, 'folderPath'),
          headSha: pinned,
          extraInstructions: typeof metadata.extraInstructions === 'string' ? metadata.extraInstructions : undefined,
          triggeredBy: value<string>(review, 'triggeredBy') === 'poll' ? 'poll' : 'manual',
          userId: legacyActor,
          actorRoles: legacyRoles,
        });
      } catch (error) {
        const reason = legacyBlockReason(error);
        await db
          .getCollection('gitCodeReviews')
          .model.update(
            { metadata: { ...metadata, migrationBlockedReason: reason } },
            { where: { id: reviewId, status: 'pending' } },
          );
        this.app.log?.warn?.(`Legacy review ${reviewId} is waiting for migration: ${reason}`);
      }
    }
  }

  private async owned(
    requestId: Id,
    executionId: Id,
  ): Promise<{ request: Getter; inbox: Getter; payload: ReviewPayload }> {
    const db = this.app.db;
    const request = await db.getRepository('gitReviewRequests').findOne({ filterByTk: requestId });
    if (
      !request ||
      value<boolean>(request, 'fenced') ||
      String(value<Id>(request, 'executionId')) !== String(executionId)
    )
      throw new Error('Review execution does not own this request');
    const execution = await db.getRepository('executions').findOne({ filterByTk: executionId });
    if (!execution || value<number | null>(execution, 'status') !== 0)
      throw new Error('Review execution is no longer running');
    const inbox = await db.getRepository('gitReviewInbox').findOne({ filterByTk: value<Id>(request, 'inboxId') });
    if (!inbox || !['running', 'dispatched'].includes(value<string>(inbox, 'state')))
      throw new Error('Review request is no longer active');
    const project = await db
      .getRepository('gitReviewProjects')
      .findOne({ filter: { projectKey: value<string>(inbox, 'projectKey') } });
    if (!project || String(value<Id>(project, 'activeInboxId')) !== String(value<Id>(inbox, 'id')))
      throw new Error('Review reservation no longer belongs to this request');
    return { request, inbox, payload: value<ReviewPayload>(inbox, 'payload') };
  }

  async claim(requestId: Id, executionId: Id): Promise<boolean> {
    const db = this.app.db;
    if ((await this.cutoverStatus()).state !== 'ready') return false;
    return db.sequelize.transaction(async (transaction) => {
      const request = await db
        .getCollection('gitReviewRequests')
        .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!request || value<boolean>(request, 'fenced')) return false;
      const previous = value<Id | null>(request, 'executionId');
      if (previous != null && String(previous) !== String(executionId)) return false;
      const execution = await db
        .getCollection('executions')
        .model.findOne({ where: { id: executionId }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !execution ||
        value<number | null>(execution, 'status') !== 0 ||
        String(value<Id>(execution, 'workflowId')) !== String(value<Id>(request, 'workflowId'))
      )
        return false;
      const context = value<{ data?: { id?: Id } }>(execution, 'context');
      if (String(context?.data?.id) !== String(requestId)) return false;
      const inbox = await db
        .getCollection('gitReviewInbox')
        .model.findOne({ where: { id: value<Id>(request, 'inboxId') }, transaction, lock: transaction.LOCK.UPDATE });
      if (!inbox || value<string>(inbox, 'state') !== (previous == null ? 'dispatched' : 'running')) return false;
      const project = await db.getCollection('gitReviewProjects').model.findOne({
        where: { projectKey: value<string>(inbox, 'projectKey') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!project || String(value<Id>(project, 'activeInboxId')) !== String(value<Id>(inbox, 'id'))) return false;
      if (previous != null) return true;
      const [count] = await db
        .getCollection('gitReviewRequests')
        .model.update({ executionId }, { where: { id: requestId, executionId: null, fenced: false }, transaction });
      if (count !== 1) return false;
      await db
        .getRepository('gitReviewInbox')
        .update({ filterByTk: value<Id>(inbox, 'id'), values: { state: 'running' }, transaction });
      await db.getRepository('gitCodeReviews').update({
        filterByTk: value<Id>(request, 'reviewId'),
        values: {
          status: 'running',
          startedAt: new Date(),
          metadata: { workflowManaged: true, workflowExecutionId: String(executionId) },
        },
        transaction,
      });
      return true;
    });
  }

  async prepareContext(requestId: Id, executionId: Id) {
    const { request, payload } = await this.owned(requestId, executionId);
    await this.assertActor(payload);
    const repo = await this.app.db
      .getRepository('gitRepositories')
      .findOne({ filterByTk: payload.source.repositoryId });
    if (!repo) throw new Error('Repository not found');
    const diff = await readPinnedReviewSource(this.app.db, repo, payload.source);
    const limitations: string[] = [];
    if (payload.source.targetType === 'mr')
      limitations.push('Provider comparison patches may omit binary content or truncate large files.');
    if (/Binary files .* differ|GIT binary patch/.test(diff))
      limitations.push('Binary file changes do not include readable source.');
    return {
      requestId,
      reviewId: value<Id>(request, 'reviewId'),
      ...payload.source,
      userId: payload.userId,
      diff,
      coverage: { complete: limitations.length === 0, limitations },
      instructions: payload.instructions,
      postMode: payload.postMode,
    };
  }

  private async assertActor(payload: ReviewPayload): Promise<void> {
    if (!payload.userId || !payload.actorRoles?.length) throw new Error('Review actor is missing');
    const current = await resolveBackgroundReviewRoles(this.app.db, payload.userId);
    if (payload.actorRoles.some((role) => !current.includes(role))) throw new Error('Review actor roles changed');
    const action = payload.source.targetType === 'mr' ? 'mergeRequestDetail' : 'fileContent';
    for (const required of ['triggerReview', action]) {
      if (
        !(await hasRepositoryAccess({
          acl: this.app.acl,
          roles: payload.actorRoles,
          repositoryId: payload.source.repositoryId,
          action: required,
        }))
      )
        throw new Error('Review actor no longer has repository access');
    }
  }

  async saveResult(requestId: Id, executionId: Id, markdown: string): Promise<string> {
    if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > 200_000)
      throw new Error('Invalid review result');
    const { request, payload } = await this.owned(requestId, executionId);
    const hash = fingerprint(markdown);
    const existing = value<string | null>(request, 'resultFingerprint');
    if (existing && existing !== hash) throw new Error('Review result is immutable');
    const persist = async (transaction: Transaction) => {
      const lockedRequest = await this.app.db
        .getCollection('gitReviewRequests')
        .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !lockedRequest ||
        value<boolean>(lockedRequest, 'fenced') ||
        String(value<Id>(lockedRequest, 'executionId')) !== String(executionId)
      )
        throw new Error('Review execution lost ownership');
      const lockedFingerprint = value<string | null>(lockedRequest, 'resultFingerprint');
      if (lockedFingerprint && lockedFingerprint !== hash) throw new Error('Review result is immutable');
      const execution = await this.app.db
        .getCollection('executions')
        .model.findOne({ where: { id: executionId }, transaction, lock: transaction.LOCK.UPDATE });
      const inbox = await this.app.db
        .getCollection('gitReviewInbox')
        .model.findOne({ where: { id: value<Id>(request, 'inboxId') }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !execution ||
        value<number | null>(execution, 'status') !== 0 ||
        !inbox ||
        value<string>(inbox, 'state') !== 'running'
      )
        throw new Error('Review execution is no longer active');
      if (lockedFingerprint === hash) return;
      const [updated] = await this.app.db
        .getCollection('gitReviewRequests')
        .model.update(
          { resultFingerprint: hash },
          { where: { id: requestId, executionId, fenced: false }, transaction },
        );
      if (updated !== 1) throw new Error('Review execution lost ownership');
      await this.app.db.getRepository('gitCodeReviews').update({
        filterByTk: value<Id>(request, 'reviewId'),
        values: {
          reviewMarkdown: markdown,
          status: 'completed',
          postStatus:
            payload.source.targetType === 'mr' && payload.postMode !== 'disabled' ? 'pending_approval' : 'skipped',
          finishedAt: new Date(),
        },
        transaction,
      });
    };
    const sequelize = this.app.db.sequelize;
    if (sequelize.getDialect() !== 'sqlite') {
      await sequelize.transaction(persist);
      return hash;
    }

    // SQLite must acquire its write reservation before the ownership reads, so a concurrent writer cannot
    // invalidate a deferred read snapshot when this transaction later writes. Retry only before a commit attempt.
    const isBusy = (error: unknown) => {
      const detail = error as { code?: string; original?: { code?: string }; parent?: { code?: string } } | null;
      return [detail?.code, detail?.original?.code, detail?.parent?.code].includes('SQLITE_BUSY');
    };
    for (let attempt = 0; ; attempt++) {
      let transaction: Transaction;
      try {
        transaction = await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
      } catch (error) {
        if (!isBusy(error) || attempt >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 400)));
        continue;
      }
      try {
        await persist(transaction);
      } catch (error) {
        await transaction.rollback();
        if (!isBusy(error) || attempt >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 400)));
        continue;
      }
      await transaction.commit();
      return hash;
    }
  }

  private async startPublication(
    requestId: Id,
    executionId: Id,
    inboxId: Id,
    reviewId: Id,
    payload: ReviewPayload,
    hash: string,
    token: string,
    mode: 'initial' | 'retry',
    start: () => ReturnType<typeof fetch>,
  ): Promise<{ response: ReturnType<typeof fetch> }> {
    const db = this.app.db;
    const options = db.sequelize.getDialect() === 'sqlite' ? { type: Transaction.TYPES.IMMEDIATE } : {};
    return db.sequelize.transaction(options, async (transaction) => {
      const request = await db.getCollection('gitReviewRequests').model.findOne({
        where: { id: requestId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const execution = await db.getCollection('executions').model.findOne({
        where: { id: executionId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const inbox = await db.getCollection('gitReviewInbox').model.findOne({
        where: { id: inboxId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const project = await db.getCollection('gitReviewProjects').model.findOne({
        where: { projectKey: payload.source.projectKey },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const review = await db.getCollection('gitCodeReviews').model.findOne({
        where: { id: reviewId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const currentPayload = inbox && value<ReviewPayload>(inbox, 'payload');
      const context = execution && value<{ data?: { id?: Id } }>(execution, 'context');
      if (
        !request ||
        value<boolean>(request, 'fenced') ||
        !value<boolean>(request, 'aiSettled') ||
        value<string | null>(request, 'postClaim') !== token ||
        String(value<Id>(request, 'executionId')) !== String(executionId) ||
        String(value<Id>(request, 'inboxId')) !== String(inboxId) ||
        String(value<Id>(request, 'reviewId')) !== String(reviewId) ||
        value<string>(request, 'resultFingerprint') !== hash ||
        !execution ||
        String(value<Id>(execution, 'workflowId')) !== String(value<Id>(request, 'workflowId')) ||
        String(context?.data?.id) !== String(requestId) ||
        (mode === 'initial'
          ? value<number | null>(execution, 'status') !== 0
          : typeof value<unknown>(execution, 'status') !== 'number' || value<number>(execution, 'status') === 0) ||
        !inbox ||
        (mode === 'initial' && value<string>(inbox, 'state') !== 'running') ||
        !currentPayload ||
        currentPayload.postMode !== payload.postMode ||
        JSON.stringify(currentPayload.source) !== JSON.stringify(payload.source) ||
        !project ||
        String(value<Id | null>(project, 'activeInboxId')) !== String(inboxId) ||
        value<Id | null>(project, 'legacyPostReviewId') != null ||
        !review ||
        value<string>(review, 'status') !== 'completed' ||
        value<string>(review, 'postStatus') !== (mode === 'initial' ? 'posting' : 'retrying') ||
        String(value<Id>(review, 'repositoryId')) !== String(payload.source.repositoryId) ||
        value<string>(review, 'targetType') !== 'mr' ||
        String(value<Id | null>(review, 'mrIid')) !== String(payload.source.mrIid) ||
        value<string>(review, 'headSha') !== payload.source.headSha ||
        fingerprint(value<string>(review, 'reviewMarkdown') || '') !== hash
      )
        reviewConflict('Review publication claim changed');

      // Lock the evidence as well as the execution, so the checked LLM and approval jobs cannot be changed before POST starts.
      const nodes = await db.getCollection('flow_nodes').model.findAll({
        where: { workflowId: value<Id>(request, 'workflowId') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const llms = nodes.filter((node: Getter) => value<string>(node, 'type') === 'git-review-llm');
      if (!llms.length) reviewConflict('Review publication claim changed');
      for (const node of llms) {
        const jobs = await db.getCollection('jobs').model.findAll({
          where: { executionId, nodeId: value<Id>(node, 'id') },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (jobs.length !== 1 || value<number>(jobs[0], 'status') !== 1)
          reviewConflict('Review publication claim changed');
      }
      if (payload.postMode === 'manual') {
        const manual = nodes.filter((node: Getter) => value<string>(node, 'type') === 'manual');
        if (manual.length !== 1) reviewConflict('Review publication claim changed');
        const jobs = await db.getCollection('jobs').model.findAll({
          where: { executionId, nodeId: value<Id>(manual[0], 'id') },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const result = jobs[0] && value<{ _?: string; review?: { fingerprint?: string } }>(jobs[0], 'result');
        if (
          jobs.length !== 1 ||
          value<number>(jobs[0], 'status') !== 1 ||
          result?._ !== 'approve' ||
          result.review?.fingerprint !== hash
        )
          reviewConflict('Review publication claim changed');
        const workflow = await db.getCollection('workflows').model.findOne({
          where: { id: value<Id>(request, 'workflowId') },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const options = workflow && value<{ gitReview?: { approverIds?: Id[] } }>(workflow, 'options');
        const assignees = options?.gitReview?.approverIds;
        const tasks = await db.getCollection('workflowManualTasks').model.findAll({
          where: {
            executionId,
            workflowId: value<Id>(request, 'workflowId'),
            nodeId: value<Id>(manual[0], 'id'),
            jobId: value<Id>(jobs[0], 'id'),
            status: 1,
          },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          !Array.isArray(assignees) ||
          !tasks.some((task: Getter) => {
            const decision = value<{ _?: string; review?: { fingerprint?: string } }>(task, 'result');
            return (
              decision?._ === 'approve' &&
              decision.review?.fingerprint === hash &&
              assignees.some((id) => String(id) === String(value<Id>(task, 'userId')))
            );
          })
        )
          reviewConflict('Review publication claim changed');
      }
      // Fetch starts before releasing the reservation locks; the response is deliberately awaited after commit.
      const response = start();
      response.catch(() => undefined);
      return { response };
    });
  }

  async publish(
    requestId: Id,
    executionId: Id,
    approvedFingerprint: string,
  ): Promise<{ status: 'posted' | 'skipped' | 'in_progress' }> {
    const { request, inbox, payload } = await this.owned(requestId, executionId);
    await this.assertActor(payload);
    const db = this.app.db;
    const review = await db.getRepository('gitCodeReviews').findOne({ filterByTk: value<Id>(request, 'reviewId') });
    if (!review) throw new Error('Review not found');
    const markdown = value<string>(review, 'reviewMarkdown');
    if (
      !markdown ||
      fingerprint(markdown) !== approvedFingerprint ||
      value<string>(request, 'resultFingerprint') !== approvedFingerprint
    )
      throw new Error('Approved review content changed');
    if (payload.source.targetType !== 'mr' || payload.postMode === 'disabled') return { status: 'skipped' };
    if (payload.postMode === 'manual') {
      const integration = (this.app.pm.get('plugin-workflow-git-review') ||
        this.app.pm.get('workflow-git-review')) as unknown as
        | {
            enabled?: boolean;
            assertManualApproval?: (workflowId: Id, executionId: Id, fingerprint: string) => Promise<void>;
          }
        | undefined;
      if (integration?.enabled !== true || !integration.assertManualApproval)
        reviewConflict('Review approval verifier is unavailable');
      await integration.assertManualApproval(value<Id>(request, 'workflowId'), executionId, approvedFingerprint);
    }
    const reviewId = value<Id>(request, 'reviewId');
    const inboxId = value<Id>(inbox, 'id');
    const token = randomUUID();
    const claim = async (transaction: Transaction): Promise<'posted' | 'in_progress' | 'claimed'> => {
      const lockedRequest = await db.getCollection('gitReviewRequests').model.findOne({
        where: { id: requestId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const lockedExecution = await db.getCollection('executions').model.findOne({
        where: { id: executionId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const lockedInbox = await db.getCollection('gitReviewInbox').model.findOne({
        where: { id: inboxId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const project = await db.getCollection('gitReviewProjects').model.findOne({
        where: { projectKey: payload.source.projectKey },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const lockedReview = await db.getCollection('gitCodeReviews').model.findOne({
        where: { id: reviewId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !lockedRequest ||
        value<boolean>(lockedRequest, 'fenced') ||
        !value<boolean>(lockedRequest, 'aiSettled') ||
        String(value<Id>(lockedRequest, 'executionId')) !== String(executionId) ||
        value<string>(lockedRequest, 'resultFingerprint') !== approvedFingerprint ||
        !lockedExecution ||
        value<number | null>(lockedExecution, 'status') !== 0 ||
        String(value<Id>(lockedExecution, 'workflowId')) !== String(value<Id>(lockedRequest, 'workflowId')) ||
        !lockedInbox ||
        value<string>(lockedInbox, 'state') !== 'running' ||
        !project ||
        String(value<Id | null>(project, 'activeInboxId')) !== String(inboxId) ||
        value<Id | null>(project, 'legacyPostReviewId') != null ||
        !lockedReview ||
        value<string>(lockedReview, 'status') !== 'completed' ||
        fingerprint(value<string>(lockedReview, 'reviewMarkdown') || '') !== approvedFingerprint
      )
        reviewConflict('Review publication is already in progress or unavailable');
      const postStatus = value<string>(lockedReview, 'postStatus');
      if (value<string | null>(lockedRequest, 'postClaim')) return 'in_progress' as const;
      if (postStatus === 'posted') {
        if (value<Id | null>(lockedReview, 'postedNoteId') == null)
          reviewConflict('Review publication receipt is unavailable');
        return 'posted' as const;
      }
      if (['posting', 'post_unknown', 'post_failed', 'retrying'].includes(postStatus)) return 'in_progress' as const;
      if (postStatus !== 'pending_approval') reviewConflict('Review publication is already in progress or unavailable');
      await lockedRequest.update({ postClaim: token, postClaimedAt: new Date() }, { transaction });
      await lockedReview.update({ postStatus: 'posting' }, { transaction });
      return 'claimed';
    };
    let admission: 'posted' | 'in_progress' | 'claimed';
    if (db.sequelize.getDialect() !== 'sqlite') {
      admission = await db.sequelize.transaction(claim);
    } else {
      const isBusy = (error: unknown) => {
        const detail = error as { code?: string; original?: { code?: string }; parent?: { code?: string } } | null;
        return [detail?.code, detail?.original?.code, detail?.parent?.code].includes('SQLITE_BUSY');
      };
      // Only the database claim is retryable. A commit failure is ambiguous and must not start or retry the POST.
      for (let attempt = 0; ; attempt++) {
        let transaction: Transaction;
        try {
          transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
        } catch (error) {
          if (!isBusy(error) || attempt >= 7) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 400)));
          continue;
        }
        try {
          admission = await claim(transaction);
        } catch (error) {
          await transaction.rollback();
          if (!isBusy(error) || attempt >= 7) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 400)));
          continue;
        }
        await transaction.commit();
        break;
      }
    }
    if (admission !== 'claimed') return { status: admission };
    try {
      const repo = await db.getRepository('gitRepositories').findOne({ filterByTk: payload.source.repositoryId });
      if (!repo) throw new Error('Repository not found');
      await assertCurrentMrHead(db, repo, payload.source);
      const marker = `<!-- git-review:${String(requestId)}:${approvedFingerprint} -->`;
      const noteId = await publishPinnedReview(db, repo, payload.source, markdown, marker, async (start) => {
        await this.assertActor(payload);
        return this.startPublication(
          requestId,
          executionId,
          inboxId,
          reviewId,
          payload,
          approvedFingerprint,
          token,
          'initial',
          start,
        );
      });
      await db.sequelize.transaction(async (transaction) => {
        const current = await db.getCollection('gitReviewRequests').model.findOne({
          where: { id: requestId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const currentReview = await db.getCollection('gitCodeReviews').model.findOne({
          where: { id: reviewId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          !current ||
          value<boolean>(current, 'fenced') ||
          value<string | null>(current, 'postClaim') !== token ||
          value<string>(current, 'resultFingerprint') !== approvedFingerprint ||
          !currentReview ||
          value<string>(currentReview, 'postStatus') !== 'posting' ||
          fingerprint(value<string>(currentReview, 'reviewMarkdown') || '') !== approvedFingerprint
        )
          reviewConflict('Review publication claim changed');
        await currentReview.update({ postStatus: 'posted', postedNoteId: noteId, error: null }, { transaction });
        await current.update({ postClaim: null, postClaimedAt: null }, { transaction });
      });
      return { status: 'posted' };
    } catch (error) {
      await db.sequelize.transaction(async (transaction) => {
        const current = await db.getCollection('gitReviewRequests').model.findOne({
          where: { id: requestId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!current || value<string | null>(current, 'postClaim') !== token) return;
        await db
          .getCollection('gitCodeReviews')
          .model.update(
            { postStatus: 'post_unknown', error: 'Review publication outcome is unknown' },
            { where: { id: reviewId, postStatus: 'posting' }, transaction },
          );
      });
      throw error;
    }
  }

  async retryPost(
    reviewId: Id,
    actor: Id,
    roles: string[],
    allowResend: boolean,
  ): Promise<{ status: 'posted' | 'observed' | 'unknown'; postedNoteId?: string; canResend: boolean }> {
    const db = this.app.db;
    const review = await db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
    if (!review) reviewConflict('Review not found');
    const repositoryId = value<Id>(review, 'repositoryId');
    const currentRoles = await resolveBackgroundReviewRoles(db, actor);
    if (
      !roles.length ||
      roles.some((role) => !currentRoles.includes(role)) ||
      !(await hasRepositoryAccess({ acl: this.app.acl, roles, repositoryId, action: 'reviewWorkflowRetryPost' }))
    ) {
      const error = new Error('Permission denied') as Error & { status: number };
      error.status = 403;
      throw error;
    }
    const inbox = await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } });
    const request =
      inbox && (await db.getRepository('gitReviewRequests').findOne({ filter: { inboxId: value<Id>(inbox, 'id') } }));
    if (!inbox || !request || value<boolean>(request, 'fenced') || !value<boolean>(request, 'aiSettled'))
      reviewConflict('Review is not settled or is no longer available');
    const executionId = value<Id | null>(request, 'executionId');
    if (executionId == null) reviewConflict('Review execution is unavailable');
    const execution = await db.getRepository('executions').findOne({ filterByTk: executionId });
    if (
      !execution ||
      typeof value<unknown>(execution, 'status') !== 'number' ||
      value<number>(execution, 'status') === 0
    )
      reviewConflict('Review execution is not terminal');
    const payload = value<ReviewPayload>(inbox, 'payload');
    if (!payload || payload.source.targetType !== 'mr' || payload.postMode === 'disabled')
      reviewConflict('Review cannot be published');
    const markdown = value<string>(review, 'reviewMarkdown');
    const hash = value<string | null>(request, 'resultFingerprint');
    if (!markdown || !hash || fingerprint(markdown) !== hash) reviewConflict('Approved review content changed');
    const integration = (this.app.pm.get('plugin-workflow-git-review') ||
      this.app.pm.get('workflow-git-review')) as unknown as
      | {
          enabled?: boolean;
          assertManualApproval?: (workflowId: Id, executionId: Id, fingerprint: string) => Promise<void>;
        }
      | undefined;
    if (integration?.enabled !== true) reviewConflict('Git review workflow integration is unavailable');
    await this.assertSafeWorkflow(value<Id>(request, 'workflowId'), payload.postMode, undefined, repositoryId);
    if (payload.postMode === 'manual') {
      if (!integration.assertManualApproval) reviewConflict('Review approval verifier is unavailable');
      await integration.assertManualApproval(value<Id>(request, 'workflowId'), executionId, hash);
    }
    if (value<string>(review, 'postStatus') === 'posted') {
      const noteId = value<Id | null>(review, 'postedNoteId');
      if (noteId == null) reviewConflict('Review publication receipt is unavailable');
      return { status: 'posted', postedNoteId: String(noteId), canResend: false };
    }
    const requestId = value<Id>(request, 'id');
    const inboxId = value<Id>(inbox, 'id');
    const token = randomUUID();
    let ownClaim = false;
    let acquiredProject = false;
    await db.sequelize.transaction(async (transaction) => {
      const lockedRequest = await db
        .getCollection('gitReviewRequests')
        .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
      const lockedExecution = await db
        .getCollection('executions')
        .model.findOne({ where: { id: executionId }, transaction, lock: transaction.LOCK.UPDATE });
      const lockedInbox = await db
        .getCollection('gitReviewInbox')
        .model.findOne({ where: { id: inboxId }, transaction, lock: transaction.LOCK.UPDATE });
      const lockedProject = await db.getCollection('gitReviewProjects').model.findOne({
        where: { projectKey: payload.source.projectKey },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const lockedReview = await db
        .getCollection('gitCodeReviews')
        .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !lockedRequest ||
        value<boolean>(lockedRequest, 'fenced') ||
        !value<boolean>(lockedRequest, 'aiSettled') ||
        String(value<Id>(lockedRequest, 'executionId')) !== String(executionId) ||
        value<string>(lockedRequest, 'resultFingerprint') !== hash
      )
        reviewConflict('Review is no longer available');
      if (
        !lockedExecution ||
        typeof value<unknown>(lockedExecution, 'status') !== 'number' ||
        value<number>(lockedExecution, 'status') === 0
      )
        reviewConflict('Review execution is not terminal');
      if (
        !lockedInbox ||
        !lockedProject ||
        !lockedReview ||
        fingerprint(value<string>(lockedReview, 'reviewMarkdown') || '') !== hash ||
        !['posting', 'post_unknown', 'post_failed', 'retrying'].includes(value<string>(lockedReview, 'postStatus'))
      )
        reviewConflict('Review publication cannot be retried');
      const active = value<Id | null>(lockedProject, 'activeInboxId');
      if (value<Id | null>(lockedProject, 'legacyPostReviewId') != null)
        reviewConflict('Another review is active for this project');
      if (active != null && String(active) !== String(inboxId))
        reviewConflict('Another review is active for this project');
      const existingClaim = value<string | null>(lockedRequest, 'postClaim');
      if (existingClaim) {
        if (allowResend) reviewConflict('A publication attempt may still be running');
        return;
      }
      if (active == null) {
        const [reserved] = await db.getCollection('gitReviewProjects').model.update(
          { activeInboxId: inboxId },
          {
            where: { projectKey: payload.source.projectKey, activeInboxId: null, legacyPostReviewId: null },
            transaction,
          },
        );
        if (reserved !== 1) reviewConflict('Another review is active for this project');
        acquiredProject = true;
      }
      await lockedRequest.update({ postClaim: token, postClaimedAt: new Date() }, { transaction });
      ownClaim = true;
    });
    let sent = false;
    try {
      const repo = await db.getRepository('gitRepositories').findOne({ filterByTk: repositoryId });
      if (!repo) reviewConflict('Repository not found');
      const marker = `<!-- git-review:${String(requestId)}:${hash} -->`;
      let noteId = await findPublishedReview(db, repo, payload.source, markdown, marker);
      if (!noteId && allowResend) {
        if (!ownClaim) reviewConflict('A publication attempt may still be running');
        await db.sequelize.transaction(async (transaction) => {
          const current = await db
            .getCollection('gitReviewRequests')
            .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
          const project = await db.getCollection('gitReviewProjects').model.findOne({
            where: { projectKey: payload.source.projectKey },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (
            !current ||
            value<boolean>(current, 'fenced') ||
            value<string | null>(current, 'postClaim') !== token ||
            !project ||
            String(value<Id | null>(project, 'activeInboxId')) !== String(inboxId)
          )
            reviewConflict('Review publication claim changed');
          const [changed] = await db
            .getCollection('gitCodeReviews')
            .model.update(
              { postStatus: 'retrying' },
              { where: { id: reviewId, postStatus: ['posting', 'post_unknown', 'post_failed'] }, transaction },
            );
          if (changed !== 1) reviewConflict('Review publication state changed');
        });
        sent = true;
        noteId = await publishPinnedReview(db, repo, payload.source, markdown, marker, async (start) => {
          const latestRoles = await resolveBackgroundReviewRoles(db, actor);
          if (
            roles.some((role) => !latestRoles.includes(role)) ||
            !(await hasRepositoryAccess({ acl: this.app.acl, roles, repositoryId, action: 'reviewWorkflowRetryPost' }))
          )
            reviewConflict('Permission denied');
          return this.startPublication(requestId, executionId, inboxId, reviewId, payload, hash, token, 'retry', start);
        });
      }
      if (!noteId) return { status: 'unknown', canResend: ownClaim };
      if (!ownClaim) return { status: 'observed', postedNoteId: noteId, canResend: false };
      await db.sequelize.transaction(async (transaction) => {
        const lockedRequest = await db
          .getCollection('gitReviewRequests')
          .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
        const lockedInbox = await db
          .getCollection('gitReviewInbox')
          .model.findOne({ where: { id: inboxId }, transaction, lock: transaction.LOCK.UPDATE });
        const lockedProject = await db.getCollection('gitReviewProjects').model.findOne({
          where: { projectKey: payload.source.projectKey },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const lockedReview = await db
          .getCollection('gitCodeReviews')
          .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
        if (
          !lockedRequest ||
          value<boolean>(lockedRequest, 'fenced') ||
          value<string | null>(lockedRequest, 'postClaim') !== token ||
          value<string>(lockedRequest, 'resultFingerprint') !== hash ||
          !lockedInbox ||
          !lockedProject ||
          String(value<Id | null>(lockedProject, 'activeInboxId')) !== String(inboxId) ||
          !lockedReview ||
          fingerprint(value<string>(lockedReview, 'reviewMarkdown') || '') !== hash
        )
          reviewConflict('Review publication claim changed');
        if (
          value<string>(lockedReview, 'postStatus') === 'posted' &&
          String(value<Id>(lockedReview, 'postedNoteId')) !== String(noteId)
        )
          reviewConflict('Review publication state changed');
        const [cleared] = await db
          .getCollection('gitReviewRequests')
          .model.update(
            { postClaim: null, postClaimedAt: null },
            { where: { id: requestId, postClaim: token, fenced: false }, transaction },
          );
        if (cleared !== 1) reviewConflict('Review publication claim changed');
        await db.getRepository('gitCodeReviews').update({
          filterByTk: reviewId,
          values: { postStatus: 'posted', postedNoteId: noteId, error: null, status: 'completed' },
          transaction,
        });
        await db
          .getRepository('gitReviewInbox')
          .update({ filterByTk: inboxId, values: { state: 'completed' }, transaction });
        const [released] = await db
          .getCollection('gitReviewProjects')
          .model.update(
            { activeInboxId: null },
            { where: { projectKey: payload.source.projectKey, activeInboxId: inboxId }, transaction },
          );
        if (released !== 1) reviewConflict('Review project reservation changed');
      });
      ownClaim = false;
      acquiredProject = false;
      await this.reconcile().catch((error) => this.app.log?.error?.('Git review dispatch will be retried', error));
      return { status: 'posted', postedNoteId: noteId, canResend: false };
    } catch (error) {
      if (sent) {
        await db.sequelize.transaction(async (transaction) => {
          const current = await db
            .getCollection('gitReviewRequests')
            .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
          if (!current || value<boolean>(current, 'fenced') || value<string | null>(current, 'postClaim') !== token)
            return;
          const [changed] = await db
            .getCollection('gitCodeReviews')
            .model.update(
              { postStatus: 'post_unknown', error: 'Review publication outcome is unknown' },
              { where: { id: reviewId, postStatus: 'retrying' }, transaction },
            );
          if (changed)
            await db
              .getRepository('gitReviewInbox')
              .update({ filterByTk: inboxId, values: { state: 'quarantined' }, transaction });
        });
        acquiredProject = false;
        ownClaim = false;
      }
      throw error;
    } finally {
      // A failed status write does not prove that a started outbound request stopped.
      if (!sent && (ownClaim || acquiredProject)) {
        await db.sequelize.transaction(async (transaction) => {
          const current = await db
            .getCollection('gitReviewRequests')
            .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
          if (!current || value<string | null>(current, 'postClaim') !== token) return;
          await current.update({ postClaim: null, postClaimedAt: null }, { transaction });
          if (acquiredProject)
            await db
              .getCollection('gitReviewProjects')
              .model.update(
                { activeInboxId: null },
                { where: { projectKey: payload.source.projectKey, activeInboxId: inboxId }, transaction },
              );
        });
      }
    }
  }

  async resetPostClaim(reviewId: Id, actor: Id, expectedAttempt: string | null): Promise<void> {
    const db = this.app.db;
    const inbox = await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } });
    const request =
      inbox && (await db.getRepository('gitReviewRequests').findOne({ filter: { inboxId: value<Id>(inbox, 'id') } }));
    if (!inbox || !request) reviewConflict('Review request not found');
    await db.sequelize.transaction(async (transaction) => {
      const requestId = value<Id>(request, 'id');
      const locked = await db
        .getCollection('gitReviewRequests')
        .model.findOne({ where: { id: requestId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!locked || value<boolean>(locked, 'fenced') || !value<boolean>(locked, 'aiSettled'))
        reviewConflict('No recoverable publication claim');
      const claim = value<string | null>(locked, 'postClaim') ?? null;
      if (claim !== expectedAttempt) reviewConflict('Review publication claim changed');
      const executionId = value<Id | null>(locked, 'executionId');
      const execution =
        executionId == null
          ? null
          : await db
              .getCollection('executions')
              .model.findOne({ where: { id: executionId }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !execution ||
        typeof value<unknown>(execution, 'status') !== 'number' ||
        value<number>(execution, 'status') === 0
      )
        reviewConflict('Review execution is not terminal');
      const lockedInbox = await db
        .getCollection('gitReviewInbox')
        .model.findOne({ where: { id: value<Id>(inbox, 'id') }, transaction, lock: transaction.LOCK.UPDATE });
      const project =
        lockedInbox &&
        (await db.getCollection('gitReviewProjects').model.findOne({
          where: { projectKey: value<string>(lockedInbox, 'projectKey') },
          transaction,
          lock: transaction.LOCK.UPDATE,
        }));
      const lockedReview = await db
        .getCollection('gitCodeReviews')
        .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !lockedInbox ||
        !lockedReview ||
        !['posting', 'post_unknown', 'post_failed', 'retrying'].includes(value<string>(lockedReview, 'postStatus'))
      )
        reviewConflict('Review publication cannot be recovered');
      const [reset] = await db
        .getCollection('gitReviewRequests')
        .model.update(
          { postClaim: null, postClaimedAt: null, postResetBy: String(actor), postResetAt: new Date() },
          { where: { id: requestId, postClaim: claim, fenced: false }, transaction },
        );
      if (reset !== 1) reviewConflict('Review publication claim changed');
      await lockedReview.update({ postStatus: 'post_unknown' }, { transaction });
      if (project)
        await db.getCollection('gitReviewProjects').model.update(
          { activeInboxId: null },
          {
            where: {
              projectKey: value<string>(lockedInbox, 'projectKey'),
              activeInboxId: value<Id>(lockedInbox, 'id'),
            },
            transaction,
          },
        );
      await lockedInbox.update({ state: 'completed' }, { transaction });
    });
    await this.reconcile().catch((error) => this.app.log?.error?.('Git review dispatch will be retried', error));
  }

  async markAISettled(requestId: Id, executionId: Id): Promise<void> {
    await this.owned(requestId, executionId);
    const integration = (this.app.pm.get('plugin-workflow-git-review') ||
      this.app.pm.get('workflow-git-review')) as unknown as
      | {
          assertAISettled?: (requestId: Id, executionId: Id) => Promise<void>;
        }
      | undefined;
    if (!integration?.assertAISettled) throw new Error('Review settlement verifier is unavailable');
    await integration.assertAISettled(requestId, executionId);
    const [updated] = await this.app.db
      .getCollection('gitReviewRequests')
      .model.update({ aiSettled: true }, { where: { id: requestId, executionId, aiSettled: false, fenced: false } });
    if (!updated) {
      const request = await this.app.db.getRepository('gitReviewRequests').findOne({ filterByTk: requestId });
      if (
        !request ||
        String(value<Id>(request, 'executionId')) !== String(executionId) ||
        value<boolean>(request, 'fenced') ||
        !value<boolean>(request, 'aiSettled')
      ) {
        throw new Error('Review settlement could not be recorded');
      }
    }
  }

  async onExecutionStatus(executionId: Id, status: number | string): Promise<void> {
    const db = this.app.db;
    const request = await db.getRepository('gitReviewRequests').findOne({ filter: { executionId } });
    if (!request || value<boolean>(request, 'fenced')) return;
    const execution = await db.getRepository('executions').findOne({ filterByTk: executionId });
    if (!execution || String(value<unknown>(execution, 'status')) !== String(status)) return;
    const inbox = await db.getRepository('gitReviewInbox').findOne({ filterByTk: value<Id>(request, 'inboxId') });
    if (!inbox || !['running', 'dispatched', 'quarantined'].includes(value<string>(inbox, 'state'))) return;
    if (value<string | null>(request, 'postClaim')) return;
    const review = await db.getRepository('gitCodeReviews').findOne({ filterByTk: value<Id>(request, 'reviewId') });
    let rejected = false;
    let settledFailure = false;
    const fingerprint = value<string | null>(request, 'resultFingerprint');
    if (Number(status) === -5 && value<boolean>(request, 'aiSettled') && fingerprint && review) {
      const integration = (this.app.pm.get('plugin-workflow-git-review') ||
        this.app.pm.get('workflow-git-review')) as unknown as
        | {
            assertManualRejection?: (workflowId: Id, executionId: Id, fingerprint: string) => Promise<void>;
          }
        | undefined;
      if (integration?.assertManualRejection) {
        try {
          await integration.assertManualRejection(value<Id>(request, 'workflowId'), executionId, fingerprint);
          rejected = true;
        } catch (_error) {
          rejected = false;
        }
      }
    }
    if ([-1, -2].includes(Number(status))) {
      const integration = (this.app.pm.get('plugin-workflow-git-review') ||
        this.app.pm.get('workflow-git-review')) as unknown as
        | {
            assertNoInFlightAI?: (requestId: Id, executionId: Id) => Promise<void>;
          }
        | undefined;
      if (integration?.assertNoInFlightAI) {
        try {
          await integration.assertNoInFlightAI(value<Id>(request, 'id'), executionId);
          settledFailure = true;
        } catch (_error) {
          settledFailure = false;
        }
      }
    }
    const completed =
      Number(status) === 1 && review && ['posted', 'skipped'].includes(value<string>(review, 'postStatus'));
    const postUnresolved =
      review && ['posting', 'post_unknown', 'post_failed', 'retrying'].includes(value<string>(review, 'postStatus'));
    if (
      postUnresolved ||
      (!completed && !rejected && !settledFailure) ||
      (!settledFailure && (!value<boolean>(request, 'aiSettled') || !fingerprint)) ||
      !review
    ) {
      if (Number(status) !== 0) {
        await db.sequelize.transaction(async (transaction) => {
          const current = await db
            .getCollection('gitReviewRequests')
            .model.findOne({ where: { id: value<Id>(request, 'id') }, transaction, lock: transaction.LOCK.UPDATE });
          if (!current || value<boolean>(current, 'fenced') || value<string | null>(current, 'postClaim')) return;
          const [changed] = await db
            .getCollection('gitReviewInbox')
            .model.update(
              { state: 'quarantined' },
              { where: { id: value<Id>(inbox, 'id'), state: ['dispatched', 'running'] }, transaction },
            );
          if (changed === 1)
            await db.getRepository('gitCodeReviews').update({
              filterByTk: value<Id>(request, 'reviewId'),
              values: {
                status: 'failed',
                error: 'Workflow ended without confirmed AI settlement; project remains reserved',
              },
              transaction,
            });
        });
      }
      return;
    }
    await db.sequelize.transaction(async (transaction) => {
      const lockedRequest = await db.getCollection('gitReviewRequests').model.findOne({
        where: { id: value<Id>(request, 'id') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !lockedRequest ||
        value<boolean>(lockedRequest, 'fenced') ||
        value<string | null>(lockedRequest, 'postClaim') ||
        (!settledFailure && !value<boolean>(lockedRequest, 'aiSettled'))
      )
        return;
      const lockedInbox = await db.getCollection('gitReviewInbox').model.findOne({
        where: { id: value<Id>(inbox, 'id') },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lockedInbox || !['running', 'dispatched', 'quarantined'].includes(value<string>(lockedInbox, 'state')))
        return;
      const lockedReview = await db
        .getCollection('gitCodeReviews')
        .model.findOne({ where: { id: value<Id>(request, 'reviewId') }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !lockedReview ||
        ['posting', 'post_unknown', 'post_failed', 'retrying'].includes(value<string>(lockedReview, 'postStatus'))
      )
        return;
      const [released] = await db.getCollection('gitReviewProjects').model.update(
        { activeInboxId: null },
        {
          where: { projectKey: value<string>(inbox, 'projectKey'), activeInboxId: value<Id>(inbox, 'id') },
          transaction,
        },
      );
      if (released !== 1) return;
      if (settledFailure) {
        await lockedRequest.update({ aiSettled: true }, { transaction });
        await db.getRepository('gitCodeReviews').update({
          filterByTk: value<Id>(request, 'reviewId'),
          values: { status: 'failed', error: 'Workflow failed after all started LLM calls settled' },
          transaction,
        });
      }
      if (rejected) {
        await db.getRepository('gitCodeReviews').update({
          filterByTk: value<Id>(request, 'reviewId'),
          values: { postStatus: 'rejected', status: 'completed' },
          transaction,
        });
      }
      await db
        .getRepository('gitReviewInbox')
        .update({ filterByTk: value<Id>(inbox, 'id'), values: { state: 'completed' }, transaction });
    });
    await this.reconcile();
  }
}
