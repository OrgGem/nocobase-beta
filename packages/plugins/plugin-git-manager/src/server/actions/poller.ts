/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { pollAllRepos, pollOneRepo, getPollerStatus } from '../poller';
import { getEffectiveActionParams } from '../repository-access';

/**
 * Manually trigger a poll cycle. If repositoryId is provided, only that repo
 * is polled (regardless of its autoReview flag). Otherwise polls all repos
 * with autoReview=true.
 */
export async function pollNow(ctx: Context, next: () => Promise<void>) {
  const { repositoryId } = getEffectiveActionParams(ctx);
  if (repositoryId != null && typeof repositoryId !== 'string' && typeof repositoryId !== 'number') {
    ctx.throw(400, 'repositoryId is required');
  }
  if (typeof repositoryId === 'string' || typeof repositoryId === 'number') {
    const repo = await ctx.db.getRepository('gitRepositories').findOne({ filterByTk: repositoryId });
    if (!repo) ctx.throw(404, 'Repository not found');
    const result = await pollOneRepo(ctx.app, repo);
    ctx.body = { success: true, data: result };
  } else {
    const result = await pollAllRepos(ctx.app);
    ctx.body = { success: true, data: result };
  }
  await next();
}

export async function pollerStatus(ctx: Context, next: () => Promise<void>) {
  ctx.body = { success: true, data: getPollerStatus(ctx.app) };
  await next();
}
