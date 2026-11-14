/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import type { GitReviewService } from '../services/review-service';
import { getEffectiveActionParams, hasRepositoryAccess, hasUnrestrictedRepositoryAccess } from '../repository-access';

type ID = string | number;
type ReviewCollection = 'gitCodeReviews' | 'gitReviewInbox' | 'gitReviewRequests';

function service(ctx: Context): GitReviewService {
  if (!ctx.state?.currentUser?.id) ctx.throw(403, ctx.t('Permission denied', { ns: 'plugin-git-manager' }));
  const plugin = (ctx.app.pm.get('plugin-git-manager') || ctx.app.pm.get('git-manager')) as unknown as {
    reviewService?: GitReviewService;
  };
  if (!plugin?.reviewService) ctx.throw(503, 'Git review workflow service is unavailable');
  return plugin.reviewService;
}

function roles(ctx: Context): string[] {
  const current = ctx.state?.currentRoles;
  return Array.isArray(current) && current.every((role) => typeof role === 'string') ? current : [];
}

async function allowed(ctx: Context, repositoryId: unknown, action: string) {
  if (typeof repositoryId !== 'string' && typeof repositoryId !== 'number') {
    return hasUnrestrictedRepositoryAccess({ acl: ctx.app.acl, roles: roles(ctx), action });
  }
  return hasRepositoryAccess({ acl: ctx.app.acl, roles: roles(ctx), repositoryId, action });
}

async function repositoryId(ctx: Context, collection: ReviewCollection, id: ID): Promise<ID | null> {
  const row = await ctx.db.getRepository(collection).findOne({ filterByTk: id });
  const value: unknown = row?.repositoryId;
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

async function requireRecordAccess(ctx: Context, collection: ReviewCollection, id: unknown, action: string) {
  if (typeof id !== 'string' && typeof id !== 'number') return;
  const repoId = await repositoryId(ctx, collection, id);
  if (repoId == null || !(await allowed(ctx, repoId, action))) {
    ctx.throw(403, ctx.t('Permission denied', { ns: 'plugin-git-manager' }));
  }
}

export async function reviewCutoverStatus(ctx: Context, next: () => Promise<void>) {
  const unrestricted = await hasUnrestrictedRepositoryAccess({
    acl: ctx.app.acl,
    roles: roles(ctx),
    action: 'reviewCutoverStatus',
  });
  const status = await service(ctx).cutoverStatus(
    unrestricted ? undefined : (repositoryId) => allowed(ctx, repositoryId, 'reviewCutoverStatus'),
  );
  const repositoryCache = new Map<string, ID | null>();
  const findRepository = async (collection: ReviewCollection, id: ID) => {
    const key = `${collection}:${id}`;
    if (!repositoryCache.has(key)) repositoryCache.set(key, await repositoryId(ctx, collection, id));
    return repositoryCache.get(key) ?? null;
  };
  const visible = async <T>(
    items: T[],
    getRepositoryId: (item: T) => Promise<ID | null>,
    action: string,
  ): Promise<Array<T & { canWrite: boolean }>> => {
    const result: Array<T & { canWrite: boolean }> = [];
    for (const item of items) {
      const repoId = await getRepositoryId(item);
      if (!(await allowed(ctx, repoId, 'reviewCutoverStatus'))) continue;
      result.push({ ...item, canWrite: await allowed(ctx, repoId, action) });
    }
    return result;
  };

  const legacyPendingReviews = await visible(
    status.legacyPendingReviews,
    async (item) => item.repositoryId,
    'reviewCancelLegacy',
  );
  const legacyRunningReviews = await visible(
    status.legacyRunningReviews,
    (item) => findRepository('gitCodeReviews', item.legacyReviewId),
    'reviewRecover',
  );
  const legacyUncertainReviews = await visible(
    status.legacyUncertainReviews,
    async (item) => item.repositoryId,
    'reviewRecover',
  );
  const quarantined = await visible(
    status.quarantined,
    (item) => findRepository('gitReviewRequests', item.requestId),
    'reviewRecover',
  );
  const orphaned = await visible(
    status.orphaned,
    (item) => findRepository('gitReviewInbox', item.inboxId),
    'reviewRecover',
  );
  const postUnknownReviews = await visible(
    status.postUnknownReviews,
    (item) => findRepository('gitCodeReviews', item.reviewId),
    'reviewResetPostClaim',
  );
  const legacyPublicationHolds = await visible(
    status.legacyPublicationHolds,
    async (item) => item.repositoryId,
    'reviewLegacyReleaseHold',
  );
  const queuedBlockedReviews = await visible(
    status.queuedBlockedReviews,
    async (item) => item.repositoryId,
    'reviewCancelQueued',
  );
  ctx.body = {
    success: true,
    data: {
      ...status,
      legacyPendingReviews,
      legacyRunningReviews,
      legacyUncertainReviews,
      quarantined,
      orphaned,
      postUnknownReviews,
      legacyPublicationHolds,
      queuedBlockedReviews,
      canConfirmCutover: await hasUnrestrictedRepositoryAccess({
        acl: ctx.app.acl,
        roles: roles(ctx),
        action: 'reviewConfirmCutover',
      }),
    },
  };
  await next();
}

export async function reviewConfirmCutover(ctx: Context, next: () => Promise<void>) {
  const reviewService = service(ctx);
  if (
    !(await hasUnrestrictedRepositoryAccess({ acl: ctx.app.acl, roles: roles(ctx), action: 'reviewConfirmCutover' }))
  ) {
    ctx.throw(403, ctx.t('Permission denied', { ns: 'plugin-git-manager' }));
  }
  if (getEffectiveActionParams(ctx).confirmation !== 'OLD_WORKERS_AND_AI_STOPPED')
    ctx.throw(400, ctx.t('Worker and AI stop confirmation is required', { ns: 'plugin-git-manager' }));
  await reviewService.confirmCutover(ctx.state.currentUser.id);
  await reviewCutoverStatus(ctx, next);
}

export async function reviewCancelLegacy(ctx: Context, next: () => Promise<void>) {
  const reviewService = service(ctx);
  const { confirmation, legacyReviewId } = getEffectiveActionParams(ctx);
  if (confirmation !== 'CANCEL_LEGACY_REVIEW')
    ctx.throw(400, ctx.t('Legacy review cancellation confirmation is required', { ns: 'plugin-git-manager' }));
  if (typeof legacyReviewId !== 'string' && typeof legacyReviewId !== 'number')
    ctx.throw(400, ctx.t('Legacy review identifier is required', { ns: 'plugin-git-manager' }));
  await requireRecordAccess(ctx, 'gitCodeReviews', legacyReviewId, 'reviewCancelLegacy');
  await reviewService.cancelLegacy(legacyReviewId, ctx.state.currentUser.id);
  ctx.body = { success: true };
  await next();
}

export async function reviewRecover(ctx: Context, next: () => Promise<void>) {
  const reviewService = service(ctx);
  const { confirmation, requestId, executionId, legacyReviewId, inboxId } = getEffectiveActionParams(ctx);
  if (confirmation !== 'AI_STOPPED')
    ctx.throw(400, ctx.t('AI stop confirmation is required', { ns: 'plugin-git-manager' }));
  if (typeof legacyReviewId === 'string' || typeof legacyReviewId === 'number') {
    await requireRecordAccess(ctx, 'gitCodeReviews', legacyReviewId, 'reviewRecover');
  } else if (typeof inboxId === 'string' || typeof inboxId === 'number') {
    await requireRecordAccess(ctx, 'gitReviewInbox', inboxId, 'reviewRecover');
  } else {
    await requireRecordAccess(ctx, 'gitReviewRequests', requestId, 'reviewRecover');
  }
  try {
    if (typeof legacyReviewId === 'string' || typeof legacyReviewId === 'number') {
      await reviewService.recoverLegacy(legacyReviewId, ctx.state.currentUser.id);
    } else if (typeof inboxId === 'string' || typeof inboxId === 'number') {
      await reviewService.recoverOrphaned(inboxId, ctx.state.currentUser.id);
    } else if (
      (typeof requestId === 'string' || typeof requestId === 'number') &&
      (executionId == null || typeof executionId === 'string' || typeof executionId === 'number')
    ) {
      await reviewService.recover(requestId, executionId ?? null, ctx.state.currentUser.id);
    } else {
      ctx.throw(400, 'Review and execution identifiers are required');
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Resolve publication or reset the stopped post attempt before recovery'
    ) {
      ctx.throw(
        409,
        ctx.t('Resolve publication or reset the stopped post attempt before recovery', { ns: 'plugin-git-manager' }),
      );
    }
    throw error;
  }
  ctx.body = { success: true };
  await next();
}

export async function reviewResetPostClaim(ctx: Context, next: () => Promise<void>) {
  const reviewService = service(ctx);
  const params = getEffectiveActionParams(ctx);
  const { confirmation, reviewId, expectedAttempt } = params;
  if (confirmation !== 'OUTBOUND_POST_STOPPED')
    ctx.throw(400, ctx.t('Outbound post stop confirmation is required', { ns: 'plugin-git-manager' }));
  if (typeof reviewId !== 'string' && typeof reviewId !== 'number') ctx.throw(400, 'reviewId is required');
  await requireRecordAccess(ctx, 'gitCodeReviews', reviewId, 'reviewResetPostClaim');
  if (
    !Object.prototype.hasOwnProperty.call(params, 'expectedAttempt') ||
    (expectedAttempt !== null && typeof expectedAttempt !== 'string')
  ) {
    ctx.throw(400, ctx.t('Refresh publication status before recovery', { ns: 'plugin-git-manager' }));
  }
  try {
    await reviewService.resetPostClaim(reviewId, ctx.state.currentUser.id, expectedAttempt);
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 400;
    ctx.throw(
      status,
      ctx.t(error instanceof Error ? error.message : 'Could not reset publication claim', { ns: 'plugin-git-manager' }),
    );
  }
  ctx.body = { success: true };
  await next();
}

export async function reviewCancelQueued(ctx: Context, next: () => Promise<void>) {
  const reviewService = service(ctx);
  const { confirmation, inboxId } = getEffectiveActionParams(ctx);
  if (confirmation !== 'CANCEL_QUEUED_REVIEW')
    ctx.throw(400, ctx.t('Queued review cancellation confirmation is required', { ns: 'plugin-git-manager' }));
  if (typeof inboxId !== 'string' && typeof inboxId !== 'number') ctx.throw(400, 'inboxId is required');
  await requireRecordAccess(ctx, 'gitReviewInbox', inboxId, 'reviewCancelQueued');
  await reviewService.cancelQueued(inboxId, ctx.state.currentUser.id);
  ctx.body = { success: true };
  await next();
}
