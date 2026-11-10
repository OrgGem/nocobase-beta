/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'crypto';
import type { Context } from '@nocobase/actions';
import type { Transaction } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { hasRepositoryAccess } from 'plugin-git-manager/server';
import { assertSafeWorkflow } from './safe-graph';
import type { ID } from './contracts';

export async function assertEligibleApprover(
  app: Application,
  approverIds: ID[],
  repositoryId: ID,
  transaction?: Transaction,
): Promise<void> {
  for (const id of approverIds) {
    const user = await app.db.getRepository('users').findOne({ filterByTk: id, fields: ['id'], transaction });
    if (!user) continue;
    const roles = await app.db.getRepository('rolesUsers').find({
      filter: { userId: user.id },
      fields: ['roleName'],
      transaction,
    });
    for (const role of roles) {
      if (typeof role.roleName !== 'string' || !role.roleName) continue;
      if (
        await hasRepositoryAccess({
          acl: app.acl,
          roles: [role.roleName],
          repositoryId,
          action: 'mergeRequestDetail',
        })
      )
        return;
    }
  }
  throw new Error('No configured approver can access this repository');
}

function userRoles(ctx: Context): string[] {
  const roles: unknown = ctx.state?.currentRoles;
  return Array.isArray(roles) && roles.every((role) => typeof role === 'string') ? roles : [];
}

export async function assignedReview(ctx: Context, taskId: ID) {
  const userId: ID | undefined = ctx.state?.currentUser?.id;
  if (userId == null) return null;
  const task = await ctx.db.getRepository('workflowManualTasks').findOne({ filterByTk: taskId });
  if (!task || String(task.userId) !== String(userId) || task.status !== 0) return null;
  const request = await ctx.db
    .getRepository('gitReviewRequests')
    .findOne({ filter: { executionId: task.executionId } });
  if (
    !request ||
    !request.aiSettled ||
    !request.resultFingerprint ||
    String(request.workflowId) !== String(task.workflowId)
  )
    return null;
  const review = await ctx.db.getRepository('gitCodeReviews').findOne({ filterByTk: request.reviewId });
  const execution = await ctx.db.getRepository('executions').findOne({ filterByTk: task.executionId });
  if (!review || execution?.status !== 0 || typeof review.reviewMarkdown !== 'string') return null;
  const hash = createHash('sha256').update(review.reviewMarkdown, 'utf8').digest('hex');
  if (hash !== request.resultFingerprint) return null;
  const roles = userRoles(ctx);
  const action = review.targetType === 'mr' ? 'mergeRequestDetail' : 'fileContent';
  if (!(await hasRepositoryAccess({ acl: ctx.app.acl, roles, repositoryId: request.repositoryId, action })))
    return null;
  try {
    const nodes = await assertSafeWorkflow(ctx.app, task.workflowId, 'manual');
    const manual = nodes.find((node) => node.type === 'manual');
    const workflow = await ctx.db.getRepository('workflows').findOne({ filterByTk: task.workflowId });
    const assignees: unknown = workflow?.options?.gitReview?.approverIds;
    if (
      !manual ||
      String(manual.id) !== String(task.nodeId) ||
      !Array.isArray(assignees) ||
      !assignees.some((id) => String(id) === String(userId))
    )
      return null;
    const job = await ctx.db.getRepository('jobs').findOne({ filterByTk: task.jobId });
    if (!job || job.status !== 0 || String(job.executionId) !== String(task.executionId)) return null;
  } catch (_error) {
    return null;
  }
  return {
    id: task.id,
    title: task.title,
    executionId: task.executionId,
    reviewId: request.reviewId,
    markdown: review.reviewMarkdown,
    fingerprint: hash,
  };
}

export async function listApprovals(ctx: Context) {
  const userId: ID | undefined = ctx.state?.currentUser?.id;
  if (userId == null) return [];
  const tasks = await ctx.db.getRepository('workflowManualTasks').find({
    filter: { userId, status: 0 },
    sort: ['-id'],
    limit: 200,
  });
  const rows = [];
  for (const task of tasks) {
    const review = await assignedReview(ctx, task.id);
    if (review) {
      const { markdown: _markdown, fingerprint: _fingerprint, ...item } = review;
      rows.push(item);
    }
  }
  return rows;
}
