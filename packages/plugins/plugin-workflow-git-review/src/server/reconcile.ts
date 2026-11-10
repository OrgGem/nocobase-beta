/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import type { WorkflowModel } from '@nocobase/plugin-workflow';
import { isRecord, reviewService } from './contracts';
import { GitReviewLLMInstruction } from './llm-instruction';
import { reconcileReviewCheckpoints } from './checkpoint';

const GRACE_MS = 60_000;

async function findExecution(app: Application, workflowId: string | number, requestId: string | number, since: Date) {
  const repository = app.db.getRepository('executions');
  let cursor: string | number | null = null;
  for (;;) {
    const executions = await repository.find({
      filter: {
        workflowId,
        createdAt: { $gte: since },
        ...(cursor == null ? {} : { id: { $gt: cursor } }),
      },
      sort: ['id'],
      limit: 200,
    });
    for (const execution of executions) {
      const context: unknown = execution.context;
      if (isRecord(context) && isRecord(context.data) && String(context.data.id) === String(requestId))
        return execution;
    }
    if (executions.length < 200) return null;
    cursor = executions[executions.length - 1].id;
  }
}

/** Recover dispatch gaps and report terminal states without ever expiring a project reservation. */
export async function reconcileRequests(app: Application, workflow: WorkflowPlugin): Promise<void> {
  const service = reviewService(app);
  await service.reconcile();
  const requests = await app.db.getRepository('gitReviewRequests').find({ sort: ['id'] });
  for (const request of requests) {
    if (request.executionId != null) {
      const execution = await app.db.getRepository('executions').findOne({ filterByTk: request.executionId });
      if (execution && typeof execution.status === 'number' && execution.status !== 0) {
        await service.onExecutionStatus(execution.id, execution.status);
      } else if (execution?.status === 0 && !request.fenced) {
        const instruction = workflow.instructions.get('git-review-llm');
        if (instruction instanceof GitReviewLLMInstruction) {
          await instruction.reconcileContinuations(request.id, execution.id);
        }
        await reconcileReviewCheckpoints(workflow, request.id, execution.id);
      }
      continue;
    }
    const createdAt = new Date(request.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || Date.now() - createdAt.getTime() < GRACE_MS) continue;
    const inbox = await app.db.getRepository('gitReviewInbox').findOne({ filterByTk: request.inboxId });
    if (!inbox || inbox.state !== 'dispatched') continue;
    const revision = (await app.db
      .getRepository('workflows')
      .findOne({ filterByTk: request.workflowId })) as WorkflowModel | null;
    if (!revision || revision.key !== request.workflowKey || revision.type !== 'collection') continue;
    const existing = await findExecution(app, revision.id, request.id, createdAt);
    if (existing) {
      if (existing.status == null && !existing.dispatched) await workflow.start(existing.id);
      continue;
    }
    await workflow.execute(
      revision,
      { data: request.id },
      { force: true, eventKey: `git-review-request:${request.id}` },
    );
  }
}
