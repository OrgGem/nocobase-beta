// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import type { WorkflowModel } from '@nocobase/plugin-workflow';
import type { Repository } from '@nocobase/database';
import { isRecord, type ID } from './contracts';
import { assertSafeWorkflow } from './safe-graph';
import { targetsReviewCollection } from './review-schema';

export function reviewTestContext(execution: { manually?: boolean | null; context?: unknown }) {
  const context = execution.context;
  if (!execution.manually || !isRecord(context) || !isRecord(context.gitReviewTest)) return null;
  const { diff, userId } = context.gitReviewTest;
  if (typeof diff !== 'string' || (typeof userId !== 'number' && typeof userId !== 'string')) return null;
  return {
    diff,
    userId,
    headSha: 'manual-test',
    postMode: 'disabled' as const,
    coverage: { complete: true, limitations: [] },
    instructions: '',
    approverIds: [],
  };
}

type RevisionRepository = Repository & {
  revision(options: {
    filterByTk: ID;
    filter: { key: string };
    values: { enabled: false; current: null };
    context: Context;
  }): Promise<WorkflowModel>;
};

// Registered as a pre-action so native workflow execute ACLs and record filters have already been applied.
export async function executeReviewTest(ctx: Context, next: Next, canTest: (repoId: unknown) => boolean) {
  const { filterByTk, filter, values, autoRevision } = ctx.action.params;
  if (!isRecord(values) || !('reviewTestDiff' in values)) return next();
  const ns = 'plugin-workflow-git-review';
  const repository = ctx.db.getRepository('workflows') as RevisionRepository;
  const workflow = (await repository.findOne({
    filterByTk,
    filter,
    context: ctx,
    appends: ['versionStats'],
  })) as WorkflowModel;
  if (!workflow || String(workflow.id) !== String(filterByTk)) ctx.throw(400, ctx.t('Invalid review test', { ns }));
  if (!targetsReviewCollection(workflow.config)) return next();
  if (ctx.method !== 'POST') ctx.throw(405, ctx.t('Method not allowed', { ns }));
  const marker = workflow.options?.gitReview;
  const flow = await ctx.db.getRepository('gitReviewFlows').findOne({ filter: { workflowKey: workflow.key } });
  const userId = ctx.state.currentUser?.id;
  if (!flow || !userId || String(flow.id) !== String(marker?.flowId) || !canTest(flow.repositoryId))
    ctx.throw(403, ctx.t('Permission denied', { ns }));
  const diff = values.reviewTestDiff;
  if (typeof diff !== 'string' || !diff.trim() || diff.length > 100000)
    ctx.throw(400, ctx.t('Invalid review test diff', { ns }));
  await assertSafeWorkflow(ctx.app, workflow.id, marker.postMode, false);
  const stats: unknown = workflow.get('versionStats');
  const firstRun = isRecord(stats) && Number(stats.executed) === 0;
  const runtime = ctx.app.pm.get('workflow') as WorkflowPlugin;
  // Clone before dispatch so a background review job cannot compete with the graph copy for SQLite's write lock.
  const revision =
    firstRun && Number(autoRevision) === 1
      ? await repository.revision({
          filterByTk: workflow.id,
          filter: { key: workflow.key },
          values: { enabled: false, current: null },
          context: ctx,
        })
      : null;
  try {
    const processor = await runtime.trigger(workflow, { gitReviewTest: { userId, diff } }, { manually: true });
    if (!processor) ctx.throw(400, ctx.t('Invalid review test', { ns }));
    ctx.body = {
      execution: { id: processor.execution.id, status: processor.execution.status },
      newVersionId: revision?.id,
    };
  } catch (error) {
    if (revision) await repository.destroy({ filter: { id: revision.id, enabled: false, current: null } });
    throw error;
  }
}
