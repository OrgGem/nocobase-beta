/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  getExecutionLockKey,
  JOB_STATUS,
  type default as WorkflowPlugin,
  type Processor,
} from '@nocobase/plugin-workflow';
import { isRecord, type ID, type ReviewContext } from './contracts';
import { createHash } from 'crypto';
import { withOwnedRequest } from './ownership';
import type { SafeNode } from './safe-graph';

function validId(value: unknown): value is ID {
  return typeof value === 'string' || typeof value === 'number';
}

/** Persist the result job and native manual job/tasks together, before exposing a pending task. */
export async function persistReviewCheckpoint(
  workflow: WorkflowPlugin,
  processor: Processor,
  nodes: SafeNode[],
  context: ReviewContext,
  markdown: string,
  fingerprint: string,
  upstreamId: ID | null,
): Promise<{ created: boolean; resumeJobId?: ID }> {
  const executionId = processor.execution.id;
  const resultNode = nodes.find((node) => node.type === 'git-review-result');
  const manual = nodes.find((node) => node.type === 'manual');
  if (!resultNode) throw new Error('Review result node is missing');
  const result = await withOwnedRequest(workflow, context.requestId, executionId, async (request, transaction) => {
    if (!request.get('aiSettled') || request.get('resultFingerprint') !== fingerprint)
      throw new Error('Review result is not settled');
    const Job = workflow.db.getCollection('jobs').model;
    const resultJobs = await Job.findAll({
      where: { executionId, nodeId: resultNode.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (resultJobs.length > 1) throw new Error('Review result checkpoint is duplicated');
    const manualJobs = manual
      ? await Job.findAll({ where: { executionId, nodeId: manual.id }, transaction, lock: transaction.LOCK.UPDATE })
      : [];
    if (manualJobs.length > 1) throw new Error('Review approval checkpoint is duplicated');
    let resultJob = resultJobs[0];
    let created = false;
    if (resultJob) {
      const stored: unknown = resultJob.get('result');
      if (
        resultJob.get('status') !== JOB_STATUS.RESOLVED ||
        !isRecord(stored) ||
        stored.fingerprint !== fingerprint ||
        stored.markdown !== markdown
      )
        throw new Error('Review result checkpoint changed');
    } else {
      const previousId = manualJobs[0]?.get('upstreamId');
      const resultId = validId(previousId) ? previousId : workflow.snowflake.getUniqueID().toString();
      resultJob = await Job.create(
        {
          id: resultId,
          executionId,
          nodeId: resultNode.id,
          nodeKey: resultNode.key,
          upstreamId,
          status: JOB_STATUS.RESOLVED,
          result: { markdown, fingerprint },
          startedAt: new Date(),
        },
        { transaction },
      );
      created = true;
    }
    if (!manual) return { created, resumeJobId: resultJob.get('id') as ID };

    const contextJob = await Job.findOne({
      where: { executionId, nodeId: nodes[0].id, status: JOB_STATUS.RESOLVED },
      transaction,
    });
    const contextResult: unknown = contextJob?.get('result');
    const assignees: unknown = isRecord(contextResult) ? contextResult.approverIds : null;
    if (!Array.isArray(assignees) || !assignees.every(validId)) throw new Error('Review approvers are invalid');
    const unique = Array.from(new Map(assignees.map((item) => [String(item), item])).values());
    if (context.targetType === 'mr' && context.postMode === 'manual' && !unique.length)
      throw new Error('Review approvers are missing');
    const Task = workflow.db.getCollection('workflowManualTasks').model;
    const tasks = await Task.findAll({
      where: { executionId, nodeId: manual.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const taskJobIds = new Set(tasks.map((task) => String(task.get('jobId'))));
    if (
      taskJobIds.size > 1 ||
      tasks.some((task) => !unique.some((userId) => String(userId) === String(task.get('userId'))))
    )
      throw new Error('Review approval tasks are inconsistent');
    const taskUsers = new Set(tasks.map((task) => String(task.get('userId'))));
    if (taskUsers.size !== tasks.length) throw new Error('Review approval tasks are duplicated');
    let manualJob = manualJobs[0];
    if (!manualJob) {
      if (tasks.some((task) => task.get('status') !== JOB_STATUS.PENDING))
        throw new Error('Orphaned review approval is not pending');
      const existingId = tasks[0]?.get('jobId');
      const manualId = validId(existingId) ? existingId : workflow.snowflake.getUniqueID().toString();
      manualJob = await Job.create(
        {
          id: manualId,
          executionId,
          nodeId: manual.id,
          nodeKey: manual.key,
          upstreamId: resultJob.get('id'),
          status: unique.length ? JOB_STATUS.PENDING : JOB_STATUS.RESOLVED,
          result: null,
          startedAt: new Date(),
        },
        { transaction },
      );
      created = true;
    } else if (
      String(manualJob.get('upstreamId')) !== String(resultJob.get('id')) ||
      (taskJobIds.size && !taskJobIds.has(String(manualJob.get('id'))))
    ) {
      throw new Error('Review approval checkpoint changed');
    }
    if (manualJob.get('status') === JOB_STATUS.PENDING) {
      const missing = unique.filter((userId) => !taskUsers.has(String(userId)));
      if (missing.length) {
        const node = processor.nodes.find((item) => String(item.id) === String(manual.id));
        if (!node) throw new Error('Review approval node is missing');
        const title = node.config?.title ? processor.getParsedValue(node.config.title, node.id) : node.title;
        await workflow.db.getRepository('workflowManualTasks').createMany({
          records: missing.map((userId) => ({
            userId,
            jobId: manualJob.get('id'),
            nodeId: manual.id,
            executionId,
            workflowId: processor.execution.workflowId,
            status: JOB_STATUS.PENDING,
            title,
          })),
          transaction,
        });
        created = true;
      }
    }
    return {
      created,
      ...(manualJob.get('status') === JOB_STATUS.RESOLVED && !unique.length
        ? { resumeJobId: manualJob.get('id') as ID }
        : {}),
    };
  });
  if (!result) throw new Error('Review execution lost ownership');
  return result;
}

/** A confirmed post/skip gets one durable final job, even under concurrent resumes. */
export async function persistPublishCheckpoint(
  workflow: WorkflowPlugin,
  requestId: ID,
  executionId: ID,
  node: { id: ID; key: string },
  fingerprint: string,
  postMode: string,
  status: 'posted' | 'skipped',
  upstreamId: ID | null,
): Promise<{ created: boolean; jobId: ID }> {
  const result = await withOwnedRequest(workflow, requestId, executionId, async (request, transaction) => {
    if (!request.get('aiSettled') || request.get('resultFingerprint') !== fingerprint || request.get('postClaim'))
      throw new Error('Review publication is not settled');
    const review = await workflow.db.getCollection('gitCodeReviews').model.findOne({
      where: { id: request.get('reviewId') },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const markdown = review?.get('reviewMarkdown');
    if (
      !review ||
      typeof markdown !== 'string' ||
      createHash('sha256').update(markdown, 'utf8').digest('hex') !== fingerprint ||
      review.get('postStatus') !== status ||
      (status === 'posted' && review.get('postedNoteId') == null)
    )
      throw new Error('Review publication receipt is unavailable');
    const Job = workflow.db.getCollection('jobs').model;
    const existing = await Job.findAll({
      where: { executionId, nodeId: node.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing.length > 1) throw new Error('Review publication checkpoint is duplicated');
    if (existing.length) {
      const saved = existing[0].get('result');
      if (
        existing[0].get('status') !== JOB_STATUS.RESOLVED ||
        !isRecord(saved) ||
        saved.fingerprint !== fingerprint ||
        saved.postMode !== postMode
      )
        throw new Error('Review publication checkpoint changed');
      return { created: false, jobId: existing[0].get('id') as ID };
    }
    const jobId = workflow.snowflake.getUniqueID().toString();
    await Job.create(
      {
        id: jobId,
        executionId,
        nodeId: node.id,
        nodeKey: node.key,
        upstreamId,
        status: JOB_STATUS.RESOLVED,
        result: { fingerprint, postMode },
        startedAt: new Date(),
      },
      { transaction },
    );
    return { created: true, jobId };
  });
  if (!result) throw new Error('Review execution lost ownership');
  return result;
}

/** Resume saved result/manual jobs if the native queue publication was lost. */
export async function reconcileReviewCheckpoints(
  workflow: WorkflowPlugin,
  requestId: ID,
  executionId: ID,
): Promise<void> {
  const jobs = await workflow.db.getRepository('jobs').find({
    filter: { executionId, status: [JOB_STATUS.RESOLVED, JOB_STATUS.REJECTED] },
    fields: ['id', 'nodeId', 'executionId', 'status'],
  });
  for (const job of jobs) {
    const lock = await workflow.app.lockManager.tryAcquire(getExecutionLockKey(executionId), 60_000);
    await lock.runExclusive(async () => {
      const ready = await withOwnedRequest(workflow, requestId, executionId, async (request, transaction) => {
        const node = await workflow.db.getCollection('flow_nodes').model.findOne({
          where: { id: job.nodeId, workflowId: request.get('workflowId') },
          transaction,
        });
        if (!node || !['git-review-result', 'manual', 'git-review-publish'].includes(String(node.get('type'))))
          return false;
        const saved = await workflow.db.getCollection('jobs').model.findOne({
          where: { id: job.id, executionId, nodeId: job.nodeId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!saved || ![JOB_STATUS.RESOLVED, JOB_STATUS.REJECTED].some((status) => status === saved.get('status')))
          return false;
        const review = await workflow.db.getCollection('gitCodeReviews').model.findOne({
          where: { id: request.get('reviewId') },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          !review ||
          request.get('postClaim') ||
          ['posting', 'post_unknown', 'post_failed', 'retrying'].includes(String(review.get('postStatus')))
        )
          return false;
        if (node.get('type') === 'git-review-publish') {
          const savedResult: unknown = saved.get('result');
          const status = review.get('postStatus');
          return (
            saved.get('status') === JOB_STATUS.RESOLVED &&
            isRecord(savedResult) &&
            savedResult.fingerprint === request.get('resultFingerprint') &&
            (status === 'skipped' || (status === 'posted' && review.get('postedNoteId') != null))
          );
        }
        const downstreamId = node.get('downstreamId');
        if (downstreamId == null) return false;
        const publish = await workflow.db.getCollection('flow_nodes').model.findOne({
          where: { id: downstreamId, workflowId: request.get('workflowId'), type: 'git-review-publish' },
          transaction,
        });
        if (!publish) return false;
        const nextJob = await workflow.db.getCollection('jobs').model.findOne({
          where: { executionId, nodeId: downstreamId },
          transaction,
        });
        return !nextJob;
      });
      if (!ready) return;
      const saved = await workflow.db.getRepository('jobs').findOne({ filterByTk: job.id });
      if (saved) await workflow.resume(saved);
    }, 60_000);
  }
}
