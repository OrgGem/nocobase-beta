/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import { isRecord, type ID, type PostMode } from './contracts';
import { assignedReview } from './approvals';
import { assertSafeWorkflow } from './safe-graph';
import { findReviewFlowBinding, findReviewRequest, targetsReviewCollection } from './review-schema';

const NAMESPACE = 'plugin-workflow-git-review';
const NODE_MUTATIONS = new Set(['update', 'destroy', 'destroyBranch', 'duplicate', 'move']);

async function managedWorkflow(ctx: Context, id: unknown) {
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const workflow = await ctx.db.getRepository('workflows').findOne({ filterByTk: id });
  if (!workflow) return null;
  if (isRecord(workflow.options?.gitReview) || targetsReviewCollection(workflow.config)) return workflow;
  const binding = await findReviewFlowBinding(ctx.db, workflow.key);
  if (binding === 'found') return workflow;
  if (await findReviewRequest(ctx.db, { workflowId: workflow.id })) return workflow;
  return null;
}

async function matching(ctx: Context, collection: string) {
  const filterByTk = ctx.action.params.filterByTk;
  return ctx.db
    .getRepository(collection)
    .find(filterByTk != null ? { filterByTk } : { filter: ctx.action.params.filter });
}

function reject(ctx: Context): never {
  return ctx.throw(403, ctx.t('Use Git Manager to run and manage reviews', { ns: NAMESPACE }));
}

async function withGraphLock<T>(ctx: Context, workflowId: ID, action: () => Promise<T>) {
  const lock = await ctx.app.lockManager.tryAcquire(`git-review-graph:${workflowId}`, 60_000);
  return lock.runExclusive(action, 120_000);
}

export async function guardReviewWorkflows(ctx: Context, next: Next) {
  const resource = ctx.action?.resourceName;
  const action = ctx.action?.actionName;
  const values = ctx.action?.params?.values;
  if (
    resource === 'workflows' &&
    action === 'create' &&
    isRecord(values) &&
    (targetsReviewCollection(values.config) || (isRecord(values.options) && isRecord(values.options.gitReview)))
  )
    reject(ctx);

  if (resource === 'workflows' && ['update', 'destroy', 'execute', 'revision'].includes(action)) {
    const workflows = await matching(ctx, 'workflows');
    const managed = [];
    for (const item of workflows) if (await managedWorkflow(ctx, item.id)) managed.push(item);
    if (!managed.length) {
      if (action === 'update' && isRecord(values) && targetsReviewCollection(values.config)) reject(ctx);
      return next();
    }
    if (managed.length !== 1 || workflows.length !== 1 || action === 'destroy' || action === 'execute') reject(ctx);
    const workflow = managed[0];
    if (action === 'revision') {
      if (isRecord(values) && values.enabled) reject(ctx);
      return withGraphLock(ctx, workflow.id, async () => {
        await next();
        const created = ctx.body as { id?: ID; options?: unknown; enabled?: boolean } | undefined;
        if (!created?.id || created.enabled) return;
        const options = isRecord(created.options) ? created.options : {};
        const marker = isRecord(options.gitReview) ? options.gitReview : {};
        await ctx.db.getRepository('workflows').update({
          filterByTk: created.id,
          values: { options: { ...options, gitReview: { ...marker, frozen: false, draft: false } } },
        });
      });
    }
    return withGraphLock(ctx, workflow.id, async () => {
      await workflow.reload();
      if (!isRecord(values)) return next();
      const originalOptions: unknown = workflow.options;
      const oldOptions = isRecord(originalOptions) ? originalOptions : {};
      const marker = isRecord(oldOptions.gitReview) ? oldOptions.gitReview : {};
      if (
        isRecord(values.options) &&
        'gitReview' in values.options &&
        JSON.stringify(values.options.gitReview) !== JSON.stringify(marker)
      )
        reject(ctx);
      if ((workflow.enabled || marker.frozen === true) && values.config != null) reject(ctx);
      if (values.enabled === true) {
        const flow = await ctx.db.getRepository('gitReviewFlows').findOne({ filter: { workflowKey: workflow.key } });
        const mode: PostMode = flow?.postMode === 'auto' || flow?.postMode === 'disabled' ? flow.postMode : 'manual';
        await assertSafeWorkflow(ctx.app, workflow.id, mode, false);
        values.options = {
          ...oldOptions,
          ...(isRecord(values.options) ? values.options : {}),
          gitReview: { ...marker, frozen: true, draft: false },
        };
      } else if (isRecord(values.options)) {
        values.options = { ...values.options, gitReview: marker };
      }
      await next();
    });
  }

  if (
    (resource === 'flow_nodes' && NODE_MUTATIONS.has(action)) ||
    (resource === 'workflows.nodes' && action === 'create')
  ) {
    const nodes = resource === 'flow_nodes' ? await matching(ctx, 'flow_nodes') : [];
    const managed = [];
    if (resource === 'flow_nodes') {
      for (const node of nodes) {
        const found = await managedWorkflow(ctx, node.workflowId);
        if (found) managed.push(found);
      }
    } else {
      const found = await managedWorkflow(ctx, ctx.action.sourceId);
      if (found) managed.push(found);
    }
    if (managed.length && resource === 'flow_nodes' && (nodes.length !== 1 || managed.length !== 1)) reject(ctx);
    const workflow = managed[0];
    if (isRecord(values)) {
      const sourceId = workflow?.id ?? nodes[0]?.workflowId ?? ctx.action.sourceId;
      if (
        values.workflowId != null &&
        (await managedWorkflow(ctx, values.workflowId)) &&
        String(values.workflowId) !== String(sourceId)
      )
        reject(ctx);
      for (const key of ['upstreamId', 'downstreamId']) {
        const targetId = values[key];
        if (targetId == null) continue;
        if (typeof targetId !== 'string' && typeof targetId !== 'number') reject(ctx);
        const target = await ctx.db.getRepository('flow_nodes').findOne({ filterByTk: targetId });
        const targetWorkflow = target ? await managedWorkflow(ctx, target.workflowId) : null;
        if (targetWorkflow && String(targetWorkflow.id) !== String(sourceId)) reject(ctx);
        if (workflow && target && String(target.workflowId) !== String(workflow.id)) reject(ctx);
      }
    }
    if (workflow) {
      return withGraphLock(ctx, workflow.id, async () => {
        await workflow.reload();
        if (workflow.enabled || workflow.options?.gitReview?.frozen !== false) reject(ctx);
        await next();
      });
    }
  }

  if (resource === 'flow_nodes' && action === 'test' && isRecord(values)) {
    const workflow = await managedWorkflow(ctx, values.workflowId);
    if (workflow) reject(ctx);
  }

  if (
    (resource === 'jobs' || resource === 'executions' || resource === 'workflowManualTasks') &&
    !['list', 'listMine', 'get', 'submit', 'cancel'].includes(action)
  ) {
    const records = await matching(ctx, resource);
    for (const record of records) {
      let workflowId = record.workflowId;
      if (!workflowId && record.executionId) {
        const execution = await ctx.db.getRepository('executions').findOne({ filterByTk: record.executionId });
        workflowId = execution?.workflowId;
      }
      if (await managedWorkflow(ctx, workflowId)) reject(ctx);
    }
    if (action === 'create' && isRecord(values)) {
      const executionId = values.executionId;
      if (executionId != null && typeof executionId !== 'string' && typeof executionId !== 'number') reject(ctx);
      const execution =
        executionId != null ? await ctx.db.getRepository('executions').findOne({ filterByTk: executionId }) : null;
      if (await managedWorkflow(ctx, values.workflowId ?? execution?.workflowId)) reject(ctx);
    }
  }

  if (resource === 'workflowManualTasks' && ['submit', 'get', 'listMine'].includes(action)) {
    if (action !== 'listMine' && ctx.action.params.filterByTk != null) {
      const task = await ctx.db
        .getRepository('workflowManualTasks')
        .findOne({ filterByTk: ctx.action.params.filterByTk });
      if (task && (await managedWorkflow(ctx, task.workflowId))) {
        const review = await assignedReview(ctx, task.id);
        if (!review) reject(ctx);
        if (action === 'submit') {
          const result = isRecord(values) && isRecord(values.result) ? values.result : {};
          const decision = result._;
          if (
            !isRecord(result.review) ||
            result.review.fingerprint !== review.fingerprint ||
            !['approve', 'reject'].includes(String(decision))
          )
            reject(ctx);
        }
      }
    }
    // Native task reads permit all execution jobs; a mixed task list must not expose review diffs after access changes.
    for (const field of ['appends', 'fields']) {
      const paths = ctx.action.params[field];
      if (Array.isArray(paths))
        ctx.action.params[field] = paths.filter(
          (path) => typeof path !== 'string' || !/^(execution\.jobs|workflow\.nodes)(\.|$)/.test(path),
        );
    }
  }
  await next();
}
