/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import type { Transaction } from '@nocobase/database';
import { isRecord, type ID, type PostMode } from './contracts';
import { parseReview } from './review-result';

export type SafeNode = {
  id: ID;
  key: string;
  type: string;
  upstreamId?: ID | null;
  downstreamId?: ID | null;
  branchIndex?: number | null;
  config: Record<string, unknown>;
};
type EvidenceJob = { id: ID; status: number; result?: unknown };
type EvidenceTask = { userId: ID; result?: unknown };

function same(left: unknown, right: unknown) {
  return left != null && right != null && String(left) === String(right);
}

function textMessages(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((message: unknown) => {
      if (!isRecord(message)) return false;
      if (message.role === 'system' || message.role === 'assistant') return typeof message.message === 'string';
      return (
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.every(
          (part: unknown) =>
            isRecord(part) && part.type === 'text' && (part.content == null || typeof part.content === 'string'),
        )
      );
    })
  );
}

export function assertSafeNodes(nodes: SafeNode[], postMode: PostMode): SafeNode[] {
  if (!Array.isArray(nodes) || nodes.length < 4) throw new Error('Review graph is incomplete');
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  if (byId.size !== nodes.length || new Set(nodes.map((node) => node.key)).size !== nodes.length) {
    throw new Error('Review graph contains duplicate nodes');
  }
  const heads = nodes.filter((node) => node.upstreamId == null);
  if (heads.length !== 1) throw new Error('Review graph must have a single entry');
  const ordered: SafeNode[] = [];
  let current: SafeNode | undefined = heads[0];
  while (current) {
    if (ordered.includes(current) || current.branchIndex != null) throw new Error('Review graph must be linear');
    const previous = ordered[ordered.length - 1];
    if ((previous && !same(current.upstreamId, previous.id)) || (!previous && current.upstreamId != null)) {
      throw new Error('Review graph links are invalid');
    }
    ordered.push(current);
    if (current.downstreamId == null) break;
    current = byId.get(String(current.downstreamId));
    if (!current) throw new Error('Review graph has a missing downstream node');
  }
  if (ordered.length !== nodes.length) throw new Error('Review graph contains unreachable nodes');
  if (ordered[0].key !== 'gr_context' || ordered[0].type !== 'git-review-context') {
    throw new Error('The context node must start the review');
  }
  const resultIndex = ordered.findIndex((node) => node.type === 'git-review-result');
  if (resultIndex < 2 || ordered[resultIndex].key !== 'gr_result') throw new Error('Review result node is required');
  const llms = ordered.slice(1, resultIndex);
  if (
    !llms.every(
      (node) =>
        node.type === 'git-review-llm' &&
        (node.config?.ignoreFail == null || node.config.ignoreFail === false) &&
        isRecord(node.config?.structuredOutput) &&
        textMessages(node.config.messages),
    )
  ) {
    throw new Error('Only structured Git review LLM nodes with text messages may precede the review result');
  }
  const finalLLM = llms[llms.length - 1];
  if (ordered[resultIndex].config?.value !== `{{$jobsMapByNodeKey.${finalLLM.key}.structuredContent}}`) {
    throw new Error('Review result must use the final LLM structured output');
  }
  const suffix = ordered.slice(resultIndex + 1);
  if (postMode === 'manual' || suffix[0]?.type === 'manual') {
    if (suffix.length !== 2 || suffix[0].type !== 'manual' || suffix[0].key !== 'gr_approval') {
      throw new Error('Manual approval must follow the review result');
    }
    const config = suffix[0].config;
    const forms = config?.forms;
    const review = isRecord(forms) ? forms.review : null;
    const actions = isRecord(review) ? review.actions : null;
    if (
      config.mode !== 0 ||
      config.assignees !== '{{$jobsMapByNodeKey.gr_context.approverIds}}' ||
      !isRecord(forms) ||
      Object.keys(forms).length !== 1 ||
      !isRecord(review) ||
      review.type !== 'custom' ||
      !Array.isArray(actions) ||
      actions.length !== 2 ||
      !actions.some(
        (action) => isRecord(action) && action.key === 'approve' && action.status === 1 && action.values == null,
      ) ||
      !actions.some(
        (action) => isRecord(action) && action.key === 'reject' && action.status === -5 && action.values == null,
      )
    )
      throw new Error('Manual approval configuration is invalid');
  } else if (suffix.length !== 1) {
    throw new Error('Review graph has nodes after the result');
  }
  const publish = suffix[suffix.length - 1];
  if (
    publish?.type !== 'git-review-publish' ||
    publish.key !== 'gr_publish' ||
    publish.config?.result !== '{{$jobsMapByNodeKey.gr_result}}' ||
    (postMode === 'manual' && publish.config?.approvalNodeKey !== 'gr_approval')
  )
    throw new Error('Review graph must end with the publish node');
  return ordered;
}

export async function assertSafeWorkflow(
  app: Application,
  workflowId: ID,
  postMode: PostMode,
  requireFrozen = true,
  transaction?: Transaction,
) {
  const workflow = await app.db.getRepository('workflows').findOne({ filterByTk: workflowId, transaction });
  const marker = workflow?.options?.gitReview;
  const condition = workflow?.config?.condition;
  if (
    !workflow ||
    workflow.type !== 'collection' ||
    workflow.sync ||
    workflow.config?.collection !== 'gitReviewRequests' ||
    workflow.config?.mode !== 1 ||
    !isRecord(condition) ||
    Object.keys(condition).length !== 1 ||
    !isRecord(condition.workflowKey) ||
    Object.keys(condition.workflowKey).length !== 1 ||
    condition.workflowKey.$eq !== workflow.key ||
    !isRecord(marker) ||
    (requireFrozen && marker.frozen !== true) ||
    !Number.isFinite(Number(workflow.options?.timeout)) ||
    Number(workflow.options.timeout) <= 0
  )
    throw new Error('Review workflow trigger or revision is unsafe');
  const nodes = await app.db.getRepository('flow_nodes').find({ filter: { workflowId }, transaction });
  const ordered = assertSafeNodes(nodes as unknown as SafeNode[], postMode);
  if (
    postMode === 'manual' &&
    (!Array.isArray(marker.approverIds) ||
      !marker.approverIds.length ||
      !marker.approverIds.every((id) => typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))))
  ) {
    throw new Error('Manual approvers are missing');
  }
  return ordered;
}

export async function assertLLMJobsSettled(app: Application, requestId: ID, executionId: ID) {
  const request = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: requestId });
  const execution = await app.db.getRepository('executions').findOne({ filterByTk: executionId });
  const inbox = request ? await app.db.getRepository('gitReviewInbox').findOne({ filterByTk: request.inboxId }) : null;
  const payload: unknown = inbox?.payload;
  if (
    !request ||
    !execution ||
    !same(request.executionId, executionId) ||
    !same(request.workflowId, execution.workflowId) ||
    execution.status !== 0 ||
    !request.resultFingerprint ||
    !isRecord(payload) ||
    !['auto', 'manual', 'disabled'].includes(String(payload.postMode))
  )
    throw new Error('Review execution cannot attest LLM settlement');
  const nodes = await assertSafeWorkflow(app, request.workflowId, payload.postMode as PostMode);
  const jobs: EvidenceJob[] = [];
  for (const node of nodes.filter((item) => item.type === 'git-review-llm')) {
    const matching = (await app.db
      .getRepository('jobs')
      .find({ filter: { executionId, nodeId: node.id } })) as EvidenceJob[];
    const result = matching[0]?.result;
    if (matching.length !== 1 || matching[0].status !== 1 || !isRecord(result) || !isRecord(result.structuredContent)) {
      throw new Error('Every review LLM call must have settled successfully');
    }
    parseReview(result.structuredContent);
    jobs.push(matching[0]);
  }
  return { request, execution, inbox, nodes, jobs };
}

export async function assertNoInFlightAI(app: Application, requestId: ID, executionId: ID) {
  const request = await app.db.getRepository('gitReviewRequests').findOne({ filterByTk: requestId });
  const execution = await app.db.getRepository('executions').findOne({ filterByTk: executionId });
  const inbox = request ? await app.db.getRepository('gitReviewInbox').findOne({ filterByTk: request.inboxId }) : null;
  const payload: unknown = inbox?.payload;
  if (
    !request ||
    !execution ||
    !same(request.executionId, executionId) ||
    !same(request.workflowId, execution.workflowId) ||
    ![-1, -2].includes(execution.status) ||
    !isRecord(payload) ||
    !['auto', 'manual', 'disabled'].includes(String(payload.postMode))
  )
    throw new Error('Review execution cannot prove settlement');
  const nodes = await assertSafeWorkflow(app, request.workflowId, payload.postMode as PostMode);
  let failed = false;
  for (const node of nodes) {
    const jobs = (await app.db
      .getRepository('jobs')
      .find({ filter: { executionId, nodeId: node.id } })) as EvidenceJob[];
    if (jobs.length > 1 || jobs.some((job) => ![1, -1, -2].includes(job.status))) {
      throw new Error('Review LLM settlement is unknown');
    }
    if (node.type === 'git-review-llm' && jobs.some((job) => job.status !== 1)) {
      throw new Error('Review LLM failure does not prove settlement');
    }
    if (node.type === 'git-review-llm' && jobs.length) {
      const result: unknown = jobs[0].result;
      if (!isRecord(result) || !['content', 'structuredContent', 'responseMetadata'].some((field) => field in result)) {
        throw new Error('Review LLM result does not prove provider completion');
      }
    }
    if (jobs.some((job) => job.status < 0)) failed = true;
  }
  if (!failed) throw new Error('Review failure has no settled terminal job');
}

export async function verifyManualDecision(
  app: Application,
  workflowId: ID,
  executionId: ID,
  fingerprint: string,
  decision: 'approve' | 'reject',
) {
  const nodes = await assertSafeWorkflow(app, workflowId, 'manual');
  const node = nodes.find((item) => item.type === 'manual');
  if (!node) throw new Error('Manual review node is missing');
  const status = decision === 'approve' ? 1 : -5;
  const jobs = (await app.db.getRepository('jobs').find({ filter: { executionId, nodeId: node.id } })) as EvidenceJob[];
  if (jobs.length !== 1 || jobs[0].status !== status) throw new Error('Manual decision job is not resolved');
  const job = jobs[0];
  const tasks = (await app.db.getRepository('workflowManualTasks').find({
    filter: { executionId, workflowId, nodeId: node.id, jobId: job.id, status },
  })) as EvidenceTask[];
  const workflow = await app.db.getRepository('workflows').findOne({ filterByTk: workflowId });
  const assignees: unknown = workflow?.options?.gitReview?.approverIds;
  const matches = (result: unknown) =>
    isRecord(result) && result._ === decision && isRecord(result.review) && result.review.fingerprint === fingerprint;
  if (
    !Array.isArray(assignees) ||
    !matches(job.result) ||
    !tasks.some((task) => assignees.some((id) => same(id, task.userId)) && matches(task.result))
  ) {
    throw new Error('The exact review has not received the required manual decision');
  }
}
