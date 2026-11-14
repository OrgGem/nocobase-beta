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
import { resolveBackgroundReviewRoles } from '../actions/review';
import { hasRepositoryAccess } from '../repository-access';
import {
  assertCurrentMrHead,
  findLegacyPublishedReview,
  PinnedReviewSource,
  publishPinnedReview,
  resolveReviewProjectKey,
  resolveReviewSource,
} from './review-source';

type Id = number | string;
type Getter = { get(name: string): unknown };
type LegacyStatus = 'posted' | 'unknown' | 'observed';

export interface LegacyPostResult {
  status: LegacyStatus;
  attemptId: string | null;
  canRetry: boolean;
  baseUnverified: true;
  baseAcknowledged: boolean;
  holdActive: boolean;
  postedNoteId?: string;
}

function value<T>(record: Getter, name: string): T {
  return record.get(name) as T;
}

function conflict(message: string): never {
  const error = new Error(message) as Error & { status: number };
  error.status = 409;
  throw error;
}

function hash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function sourceOf(record: Getter): PinnedReviewSource | null {
  const source = value<unknown>(record, 'legacyPostSource');
  if (source == null) return null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) conflict('Legacy review source is invalid');
  const candidate = source as Partial<PinnedReviewSource>;
  if (
    candidate.targetType !== 'mr' ||
    typeof candidate.projectKey !== 'string' ||
    !candidate.projectKey ||
    !candidate.mrIid ||
    typeof candidate.headSha !== 'string' ||
    typeof candidate.baseSha !== 'string' ||
    String(candidate.repositoryId) !== String(value<Id>(record, 'repositoryId')) ||
    String(candidate.mrIid) !== String(value<Id>(record, 'mrIid')) ||
    candidate.headSha !== value<string>(record, 'headSha')
  )
    conflict('Legacy review source is invalid');
  const projectKey = value<string | null>(record, 'legacyPostProjectKey');
  if (projectKey && projectKey !== candidate.projectKey) conflict('Legacy review source is invalid');
  return candidate as PinnedReviewSource;
}

function baseAcknowledged(record: Getter): boolean {
  return (
    value<string | null>(record, 'legacyBaseProvenance') === 'unverified_legacy' &&
    !!value<string | null>(record, 'legacyBaseAcknowledgedBy') &&
    !!value<Date | null>(record, 'legacyBaseAcknowledgedAt')
  );
}

/** Handles old review records without restarting their AI or treating an uncertain remote POST as a failure. */
export class LegacyPostService {
  constructor(private readonly app: Application) {}

  private async load(reviewId: Id, actor: Id, roles: string[]) {
    const db = this.app.db;
    const review = await db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
    if (!review) conflict('Review not found');
    if (
      value<{ workflowManaged?: boolean } | null>(review, 'metadata')?.workflowManaged ||
      (await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } }))
    ) {
      conflict('Use the workflow approval task for this review');
    }
    if (value<string>(review, 'status') !== 'completed' || value<string>(review, 'targetType') !== 'mr') {
      conflict('Only completed legacy merge request reviews can be published');
    }
    const repositoryId = value<Id>(review, 'repositoryId');
    const currentRoles = await resolveBackgroundReviewRoles(db, actor);
    if (
      !roles.length ||
      roles.some((role) => !currentRoles.includes(role)) ||
      !(await hasRepositoryAccess({ acl: this.app.acl, roles, repositoryId, action: 'reviewApprovePost' }))
    ) {
      const error = new Error('Permission denied') as Error & { status: number };
      error.status = 403;
      throw error;
    }
    const repo = await db.getRepository('gitRepositories').findOne({ filterByTk: repositoryId });
    if (!repo) conflict('Repository not found');
    return { review, repo, repositoryId };
  }

  private async lookupSource(review: Getter, repo: Getter): Promise<PinnedReviewSource> {
    const snapshot = sourceOf(review);
    if (snapshot) return snapshot;
    const mrIid = Number(value<Id>(review, 'mrIid'));
    if (!Number.isSafeInteger(mrIid) || mrIid < 1) conflict('Invalid merge request');
    return {
      projectKey:
        value<string | null>(review, 'legacyPostProjectKey') || (await resolveReviewProjectKey(this.app.db, repo)),
      repositoryId: Number(value<Id>(review, 'repositoryId')),
      targetType: 'mr',
      mrIid,
      branch: null,
      folderPath: null,
      headSha: value<string | null>(review, 'headSha') || '',
      baseSha: null,
    };
  }

  async status(reviewId: Id, actor: Id, roles: string[]): Promise<LegacyPostResult> {
    const db = this.app.db;
    const { review, repo } = await this.load(reviewId, actor, roles);
    const postStatus = value<string>(review, 'postStatus');
    if (!['posting', 'post_unknown', 'post_failed', 'posted'].includes(postStatus)) {
      conflict('Legacy review is not awaiting publication recovery');
    }
    const markdown = value<string>(review, 'reviewMarkdown');
    if (!markdown) conflict('No review content to post');
    const fingerprint = hash(markdown);
    const stored = value<string | null>(review, 'legacyPostFingerprint');
    if (stored && stored !== fingerprint) conflict('Approved review content changed');
    const source = await this.lookupSource(review, repo);
    const project = await db.getRepository('gitReviewProjects').findOne({ filter: { projectKey: source.projectKey } });
    const attemptId = value<string | null>(review, 'legacyPostClaim') ?? null;
    const result: LegacyPostResult = {
      status: postStatus === 'posted' ? 'posted' : 'unknown',
      attemptId,
      canRetry: postStatus !== 'posted',
      baseUnverified: true,
      baseAcknowledged: baseAcknowledged(review),
      holdActive: !!project && String(value<Id | null>(project, 'legacyPostReviewId')) === String(reviewId),
    };
    if (postStatus === 'posted') {
      const noteId = value<Id | null>(review, 'postedNoteId');
      if (noteId != null) result.postedNoteId = String(noteId);
      return result;
    }
    const marker = `<!-- git-review:legacy:${String(reviewId)}:${fingerprint} -->`;
    const found = await findLegacyPublishedReview(db, repo, source, markdown, marker);
    if (!found) return result;
    result.status = 'observed';
    result.canRetry = found.kind === 'marked' && attemptId != null;
    result.postedNoteId = found.noteId;
    if (found.kind !== 'marked' || attemptId) return result;
    await db.sequelize.transaction(async (transaction) => {
      const current = await db
        .getCollection('gitCodeReviews')
        .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !current ||
        value<string | null>(current, 'legacyPostClaim') ||
        value<string>(current, 'reviewMarkdown') !== markdown ||
        !['posting', 'post_unknown', 'post_failed'].includes(value<string>(current, 'postStatus'))
      )
        return;
      const oldFingerprint = value<string | null>(current, 'legacyPostFingerprint');
      if (oldFingerprint && oldFingerprint !== fingerprint) return;
      await current.update(
        { postStatus: 'posted', postedNoteId: found.noteId, legacyPostFingerprint: fingerprint, error: null },
        { transaction },
      );
      await db
        .getCollection('gitReviewProjects')
        .model.update(
          { legacyPostReviewId: null },
          { where: { projectKey: source.projectKey, legacyPostReviewId: reviewId }, transaction },
        );
      result.status = 'posted';
      result.holdActive = false;
    });
    return result;
  }

  async approve(
    reviewId: Id,
    actor: Id,
    roles: string[],
    editedMarkdown: unknown,
    baseConfirmation: unknown,
  ): Promise<LegacyPostResult> {
    return this.post(reviewId, actor, roles, { kind: 'approve', editedMarkdown, baseConfirmation });
  }

  async retry(
    reviewId: Id,
    actor: Id,
    roles: string[],
    expectedAttempt: string | null,
    baseConfirmation: unknown,
  ): Promise<LegacyPostResult> {
    return this.post(reviewId, actor, roles, { kind: 'retry', expectedAttempt, baseConfirmation });
  }

  private async post(
    reviewId: Id,
    actor: Id,
    roles: string[],
    input:
      | { kind: 'approve'; editedMarkdown: unknown; baseConfirmation: unknown }
      | { kind: 'retry'; expectedAttempt: string | null; baseConfirmation: unknown },
  ): Promise<LegacyPostResult> {
    const db = this.app.db;
    const owner = (this.app.pm.get('plugin-git-manager') || this.app.pm.get('git-manager')) as unknown as {
      reviewService?: {
        cutoverStatus(): Promise<{ state: string }>;
        ensureReviewProject(key: string): Promise<void>;
        reconcile(): Promise<void>;
      };
    };
    if (!owner?.reviewService || (await owner.reviewService.cutoverStatus()).state !== 'ready') {
      conflict('Review cutover has not been confirmed');
    }
    const { review, repo, repositoryId } = await this.load(reviewId, actor, roles);
    const previousStatus = value<string>(review, 'postStatus');
    if (input.kind === 'approve' && previousStatus !== 'pending_approval') conflict('Review is not awaiting approval');
    if (input.kind === 'retry' && !['posting', 'post_unknown', 'post_failed'].includes(previousStatus)) {
      conflict('Legacy review is not awaiting publication recovery');
    }
    const oldAttempt = value<string | null>(review, 'legacyPostClaim') ?? null;
    if (input.kind === 'retry' && oldAttempt !== input.expectedAttempt) conflict('Review publication claim changed');
    if (input.kind === 'approve' && oldAttempt) conflict('A publication attempt may still be running');
    const existingMarkdown = value<string>(review, 'reviewMarkdown');
    const markdown = input.kind === 'approve' && input.editedMarkdown != null ? input.editedMarkdown : existingMarkdown;
    if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > 200_000)
      conflict('No review content to post');
    const fingerprint = hash(markdown);
    const previousFingerprint = value<string | null>(review, 'legacyPostFingerprint');
    if (previousFingerprint && previousFingerprint !== fingerprint) conflict('Approved review content changed');
    const marker = `<!-- git-review:legacy:${String(reviewId)}:${fingerprint} -->`;
    let source = sourceOf(review);
    const lookup = source || (await this.lookupSource(review, repo));
    const priorMatch =
      input.kind === 'retry' ? await findLegacyPublishedReview(db, repo, lookup, markdown, marker) : null;
    if (priorMatch?.kind === 'unmarked') {
      const project = await db
        .getRepository('gitReviewProjects')
        .findOne({ filter: { projectKey: lookup.projectKey } });
      return {
        status: 'observed',
        attemptId: oldAttempt,
        canRetry: false,
        baseUnverified: true,
        baseAcknowledged: baseAcknowledged(review),
        holdActive: !!project && String(value<Id | null>(project, 'legacyPostReviewId')) === String(reviewId),
        postedNoteId: priorMatch.noteId,
      };
    }
    let acknowledgedNow = false;
    if (source && !baseAcknowledged(review) && !priorMatch) {
      if (input.baseConfirmation !== 'LEGACY_BASE_UNVERIFIED')
        conflict('Legacy review base requires explicit confirmation');
      acknowledgedNow = true;
    }
    if (!source && !priorMatch) {
      if (input.baseConfirmation !== 'LEGACY_BASE_UNVERIFIED')
        conflict('Legacy review base requires explicit confirmation');
      const headSha = value<string | null>(review, 'headSha');
      if (!headSha) conflict('Reviewed commit is unavailable');
      source = await resolveReviewSource(db, repo, {
        targetType: 'mr',
        mrIid: Number(value<Id>(review, 'mrIid')),
        headSha,
      });
      acknowledgedNow = true;
    }
    const selectedSource = source || lookup;
    await owner.reviewService.ensureReviewProject(selectedSource.projectKey);
    const token = randomUUID();
    await db.sequelize.transaction(async (transaction) => {
      const current = await db
        .getCollection('gitCodeReviews')
        .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !current ||
        value<string>(current, 'status') !== 'completed' ||
        value<string>(current, 'postStatus') !== previousStatus ||
        (value<string | null>(current, 'legacyPostClaim') ?? null) !== oldAttempt ||
        value<string>(current, 'reviewMarkdown') !== existingMarkdown ||
        (value<string | null>(current, 'legacyPostFingerprint') &&
          value<string>(current, 'legacyPostFingerprint') !== fingerprint) ||
        (value<string | null>(current, 'legacyPostProjectKey') &&
          value<string>(current, 'legacyPostProjectKey') !== selectedSource.projectKey)
      ) {
        conflict('Review publication claim changed');
      }
      if (await db.getRepository('gitReviewInbox').findOne({ filter: { reviewId }, transaction }))
        conflict('Use the workflow approval task for this review');
      const project = await db.getCollection('gitReviewProjects').model.findOne({
        where: { projectKey: selectedSource.projectKey },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!project || value<Id | null>(project, 'activeInboxId') != null)
        conflict('Another review is active for this project');
      const legacyOwner = value<Id | null>(project, 'legacyPostReviewId');
      if (legacyOwner != null && String(legacyOwner) !== String(reviewId))
        conflict('Another review is active for this project');
      if (legacyOwner == null) {
        const [reserved] = await db.getCollection('gitReviewProjects').model.update(
          { legacyPostReviewId: reviewId },
          {
            where: { projectKey: selectedSource.projectKey, activeInboxId: null, legacyPostReviewId: null },
            transaction,
          },
        );
        if (reserved !== 1) conflict('Another review is active for this project');
      }
      const values: Record<string, unknown> = {
        reviewMarkdown: markdown,
        legacyPostFingerprint: fingerprint,
        legacyPostClaim: token,
        legacyPostProjectKey: selectedSource.projectKey,
        postStatus: 'posting',
        ...(input.kind === 'approve' ? { approvedBy: String(actor), approvedAt: new Date() } : {}),
        ...(source ? { legacyPostSource: source } : {}),
        ...(acknowledgedNow
          ? {
              legacyBaseProvenance: 'unverified_legacy',
              legacyBaseAcknowledgedBy: String(actor),
              legacyBaseAcknowledgedAt: new Date(),
            }
          : {}),
      };
      const [claimed] = await db.getCollection('gitCodeReviews').model.update(values, {
        where: { id: reviewId, status: 'completed', postStatus: previousStatus, legacyPostClaim: oldAttempt },
        transaction,
      });
      if (claimed !== 1) conflict('Review publication claim changed');
    });
    try {
      const found = await findLegacyPublishedReview(db, repo, selectedSource, markdown, marker);
      if (found?.kind === 'unmarked') {
        const nextAttempt = await this.finish(reviewId, selectedSource.projectKey, token, fingerprint, null);
        return {
          status: 'observed',
          attemptId: nextAttempt,
          canRetry: false,
          baseUnverified: true,
          baseAcknowledged: acknowledgedNow || baseAcknowledged(review),
          holdActive: false,
          postedNoteId: found.noteId,
        };
      }
      const noteId =
        found?.noteId ||
        (await publishPinnedReview(db, repo, selectedSource, markdown, marker, async (start) => {
          const freshRepo = await db.getRepository('gitRepositories').findOne({ filterByTk: repositoryId });
          if (!freshRepo) conflict('Repository not found');
          const currentRoles = await resolveBackgroundReviewRoles(db, actor);
          if (
            roles.some((role) => !currentRoles.includes(role)) ||
            !(await hasRepositoryAccess({ acl: this.app.acl, roles, repositoryId, action: 'reviewApprovePost' }))
          )
            conflict('Permission denied');
          await assertCurrentMrHead(db, freshRepo, selectedSource);
          const options = db.sequelize.getDialect() === 'sqlite' ? { type: Transaction.TYPES.IMMEDIATE } : {};
          return db.sequelize.transaction(options, async (transaction) => {
            const current = await db
              .getCollection('gitCodeReviews')
              .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
            const project = await db.getCollection('gitReviewProjects').model.findOne({
              where: { projectKey: selectedSource.projectKey },
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            const currentSource = current && sourceOf(current);
            if (
              !current ||
              value<string>(current, 'status') !== 'completed' ||
              value<string>(current, 'postStatus') !== 'posting' ||
              value<string | null>(current, 'legacyPostClaim') !== token ||
              value<string>(current, 'legacyPostProjectKey') !== selectedSource.projectKey ||
              value<string>(current, 'legacyPostFingerprint') !== fingerprint ||
              hash(value<string>(current, 'reviewMarkdown') || '') !== fingerprint ||
              !currentSource ||
              String(currentSource.repositoryId) !== String(selectedSource.repositoryId) ||
              String(currentSource.mrIid) !== String(selectedSource.mrIid) ||
              currentSource.headSha !== selectedSource.headSha ||
              currentSource.baseSha !== selectedSource.baseSha ||
              !baseAcknowledged(current) ||
              !project ||
              String(value<Id | null>(project, 'legacyPostReviewId')) !== String(reviewId) ||
              value<Id | null>(project, 'activeInboxId') != null
            )
              conflict('Review publication claim changed');
            const response = start();
            response.catch(() => undefined);
            return { response };
          });
        }));
      await this.finish(reviewId, selectedSource.projectKey, token, fingerprint, noteId);
      await owner.reviewService
        .reconcile()
        .catch((error) => this.app.log?.error?.('Git review dispatch will be retried', error));
      return {
        status: 'posted',
        attemptId: null,
        canRetry: false,
        baseUnverified: true,
        baseAcknowledged: acknowledgedNow || baseAcknowledged(review),
        holdActive: false,
        postedNoteId: noteId,
      };
    } catch (error) {
      await db.getCollection('gitCodeReviews').model.update(
        {
          postStatus: 'post_unknown',
          error: error instanceof Error ? error.message : 'Publication outcome is unknown',
        },
        { where: { id: reviewId, legacyPostClaim: token, postStatus: 'posting' } },
      );
      throw error;
    }
  }

  private async finish(
    reviewId: Id,
    projectKey: string,
    token: string,
    fingerprint: string,
    noteId: string | null,
  ): Promise<string | null> {
    const db = this.app.db;
    const nextAttempt = noteId ? null : randomUUID();
    await db.sequelize.transaction(async (transaction) => {
      const review = await db
        .getCollection('gitCodeReviews')
        .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
      const project = await db
        .getCollection('gitReviewProjects')
        .model.findOne({ where: { projectKey }, transaction, lock: transaction.LOCK.UPDATE });
      if (
        !review ||
        value<string | null>(review, 'legacyPostClaim') !== token ||
        value<string>(review, 'legacyPostFingerprint') !== fingerprint ||
        hash(value<string>(review, 'reviewMarkdown') || '') !== fingerprint ||
        !project ||
        String(value<Id | null>(project, 'legacyPostReviewId')) !== String(reviewId) ||
        value<Id | null>(project, 'activeInboxId') != null
      )
        conflict('Review publication claim changed');
      const [changed] = await db.getCollection('gitCodeReviews').model.update(
        {
          postStatus: noteId ? 'posted' : 'post_unknown',
          postedNoteId: noteId,
          legacyPostClaim: nextAttempt,
          error: null,
        },
        { where: { id: reviewId, legacyPostClaim: token, legacyPostFingerprint: fingerprint }, transaction },
      );
      if (changed !== 1) conflict('Review publication claim changed');
      const [released] = await db
        .getCollection('gitReviewProjects')
        .model.update(
          { legacyPostReviewId: null },
          { where: { projectKey, legacyPostReviewId: reviewId, activeInboxId: null }, transaction },
        );
      if (released !== 1) conflict('Review project reservation changed');
    });
    return nextAttempt;
  }

  async releaseHold(reviewId: Id, actor: Id, roles: string[], expectedAttempt: string | null): Promise<void> {
    const currentRoles = await resolveBackgroundReviewRoles(this.app.db, actor);
    if (!roles.length || roles.some((role) => !currentRoles.includes(role))) {
      const error = new Error('Permission denied') as Error & { status: number };
      error.status = 403;
      throw error;
    }
    const review = await this.app.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
    if (
      !review ||
      value<string>(review, 'status') !== 'completed' ||
      value<string>(review, 'targetType') !== 'mr' ||
      value<{ workflowManaged?: boolean } | null>(review, 'metadata')?.workflowManaged ||
      (await this.app.db.getRepository('gitReviewInbox').findOne({ filter: { reviewId } }))
    )
      conflict('Legacy review is not available');
    const repositoryId = value<Id>(review, 'repositoryId');
    if (!(await hasRepositoryAccess({ acl: this.app.acl, roles, repositoryId, action: 'reviewLegacyReleaseHold' }))) {
      const error = new Error('Permission denied') as Error & { status: number };
      error.status = 403;
      throw error;
    }
    const projectKey = value<string | null>(review, 'legacyPostProjectKey') || sourceOf(review)?.projectKey;
    if (!projectKey) conflict('Legacy review has no publication hold');
    const db = this.app.db;
    await db.sequelize.transaction(async (transaction) => {
      const current = await db
        .getCollection('gitCodeReviews')
        .model.findOne({ where: { id: reviewId }, transaction, lock: transaction.LOCK.UPDATE });
      if (current && String(value<Id>(current, 'repositoryId')) !== String(repositoryId)) {
        conflict('Review repository changed');
      }
      if (
        !current ||
        (value<string | null>(current, 'legacyPostClaim') ?? null) !== expectedAttempt ||
        !['posting', 'post_unknown', 'post_failed'].includes(value<string>(current, 'postStatus')) ||
        (value<string | null>(current, 'legacyPostProjectKey') || sourceOf(current)?.projectKey) !== projectKey
      )
        conflict('Review publication claim changed');
      const project = await db
        .getCollection('gitReviewProjects')
        .model.findOne({ where: { projectKey }, transaction, lock: transaction.LOCK.UPDATE });
      const [changed] = await db.getCollection('gitCodeReviews').model.update(
        {
          postStatus: 'post_unknown',
          legacyPostClaim: randomUUID(),
          legacyHoldReleasedBy: String(actor),
          legacyHoldReleasedAt: new Date(),
        },
        { where: { id: reviewId, legacyPostClaim: expectedAttempt, status: 'completed' }, transaction },
      );
      if (changed !== 1) conflict('Review publication claim changed');
      if (project)
        await db.getCollection('gitReviewProjects').model.update(
          { legacyPostReviewId: null },
          {
            where: { projectKey, legacyPostReviewId: reviewId, activeInboxId: null },
            transaction,
          },
        );
    });
    const owner = (this.app.pm.get('plugin-git-manager') || this.app.pm.get('git-manager')) as unknown as {
      reviewService?: { reconcile(): Promise<void> };
    };
    await owner.reviewService
      ?.reconcile()
      .catch((error) => this.app.log?.error?.('Git review dispatch will be retried', error));
  }
}
