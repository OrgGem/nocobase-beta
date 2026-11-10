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
import { getEffectiveActionParams } from '../repository-access';

function service(ctx: Context): GitReviewService {
  const roles = ctx.state?.currentRoles;
  if (!Array.isArray(roles) || !roles.includes('root') || !ctx.state?.currentUser?.id)
    ctx.throw(403, 'Permission denied');
  const plugin = (ctx.app.pm.get('plugin-git-manager') || ctx.app.pm.get('git-manager')) as unknown as {
    reviewService?: GitReviewService;
  };
  if (!plugin?.reviewService) ctx.throw(503, 'Git review workflow service is unavailable');
  return plugin.reviewService;
}

export async function reviewCutoverStatus(ctx: Context, next: () => Promise<void>) {
  ctx.body = { success: true, data: await service(ctx).cutoverStatus() };
  await next();
}

export async function reviewConfirmCutover(ctx: Context, next: () => Promise<void>) {
  const reviewService = service(ctx);
  if (getEffectiveActionParams(ctx).confirmation !== 'OLD_WORKERS_AND_AI_STOPPED')
    ctx.throw(400, ctx.t('Worker and AI stop confirmation is required', { ns: 'plugin-git-manager' }));
  await reviewService.confirmCutover(ctx.state.currentUser.id);
  ctx.body = { success: true, data: await reviewService.cutoverStatus() };
  await next();
}

export async function reviewCancelLegacy(ctx: Context, next: () => Promise<void>) {
  const reviewService = service(ctx);
  const { confirmation, legacyReviewId } = getEffectiveActionParams(ctx);
  if (confirmation !== 'CANCEL_LEGACY_REVIEW')
    ctx.throw(400, ctx.t('Legacy review cancellation confirmation is required', { ns: 'plugin-git-manager' }));
  if (typeof legacyReviewId !== 'string' && typeof legacyReviewId !== 'number')
    ctx.throw(400, ctx.t('Legacy review identifier is required', { ns: 'plugin-git-manager' }));
  await reviewService.cancelLegacy(legacyReviewId, ctx.state.currentUser.id);
  ctx.body = { success: true };
  await next();
}

export async function reviewRecover(ctx: Context, next: () => Promise<void>) {
  const reviewService = service(ctx);
  const { confirmation, requestId, executionId, legacyReviewId, inboxId } = getEffectiveActionParams(ctx);
  if (confirmation !== 'AI_STOPPED')
    ctx.throw(400, ctx.t('AI stop confirmation is required', { ns: 'plugin-git-manager' }));
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
  await reviewService.cancelQueued(inboxId, ctx.state.currentUser.id);
  ctx.body = { success: true };
  await next();
}
