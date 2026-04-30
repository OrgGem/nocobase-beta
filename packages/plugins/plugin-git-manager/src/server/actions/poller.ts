import { Context } from '@nocobase/actions';
import { pollAllRepos, pollOneRepo, getPollerStatus } from '../poller';

/**
 * Manually trigger a poll cycle. If repositoryId is provided, only that repo
 * is polled (regardless of its autoReview flag). Otherwise polls all repos
 * with autoReview=true.
 */
export async function pollNow(ctx: Context, next: () => Promise<void>) {
  const { repositoryId } = ctx.action.params;
  if (repositoryId) {
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
  ctx.body = { success: true, data: getPollerStatus() };
  await next();
}
