/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { Transaction } from '@nocobase/database';
import type { LLMProvider, LLMProviderMeta, LLMProviderOptions } from '@nocobase/plugin-ai';
import {
  EXECUTION_STATUS,
  getExecutionLockKey,
  Instruction,
  isWorkflowTimeoutError,
  JOB_STATUS,
  type FlowNodeModel,
  type IJob,
  type JobModel,
  type Processor,
} from '@nocobase/plugin-workflow';
import { isRecord, type ID } from './contracts';
import { withOwnedRequest, type LockedRequest } from './ownership';

type AIPlugin = { aiManager: { llmProviders: Map<string, LLMProviderMeta> } };
type BackgroundHandle = ReturnType<Processor['createBackgroundAbortHandle']>;
type ProviderOutcome = { ok: true; response: unknown } | { ok: false; error: unknown };

function parseTextMessages(value: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Review LLM messages are required');
  return value.map((message: unknown) => {
    if (!isRecord(message)) throw new Error('Invalid review LLM message');
    if (message.role === 'system' || message.role === 'assistant') {
      if (typeof message.message !== 'string') throw new Error('Invalid review LLM message');
      return message.role === 'system' ? new SystemMessage(message.message) : new AIMessage(message.message);
    }
    if (message.role !== 'user' || !Array.isArray(message.content)) throw new Error('Invalid review LLM message');
    const content = message.content.map((part: unknown) => {
      if (!isRecord(part) || part.type !== 'text' || (part.content != null && typeof part.content !== 'string')) {
        throw new Error('Review LLM messages support text content only');
      }
      return { type: 'text' as const, text: typeof part.content === 'string' ? part.content : '' };
    });
    return content.length === 1 ? new HumanMessage(content[0].text) : new HumanMessage({ content });
  });
}

function reviewRequestId(processor: Processor): ID {
  const context: unknown = processor.execution.context;
  if (!isRecord(context) || !isRecord(context.data)) throw new Error('Review request context is missing');
  const { id, workflowId } = context.data;
  if (
    (typeof id !== 'number' && typeof id !== 'string') ||
    String(workflowId) !== String(processor.execution.workflowId)
  ) {
    throw new Error('Review request is not bound to this workflow revision');
  }
  return id;
}

/** A review-only LLM node that persists its pending job before any provider call begins. */
export class GitReviewLLMInstruction extends Instruction {
  async run(node: FlowNodeModel, input: JobModel | { result: unknown } | undefined, processor: Processor) {
    const requestId = reviewRequestId(processor);
    const claimed = await this.claimNode(requestId, processor.execution.id, node.id);
    if (!claimed) {
      await processor.exit();
      return;
    }
    const config: unknown = processor.getParsedValue(node.config, node.id);
    if (!isRecord(config) || typeof config.llmService !== 'string' || !isRecord(config.structuredOutput)) {
      throw new Error('Review LLM service and structured output are required');
    }
    const { llmService, messages, structuredOutput, ...modelOptions } = config;
    const parsedMessages = parseTextMessages(messages);
    const service = await this.workflow.db.getRepository('llmServices').findOne({ filter: { name: llmService } });
    const ai = this.workflow.app.pm.get('ai') as unknown as AIPlugin | undefined;
    const providerMeta = service && ai?.aiManager?.llmProviders.get(service.provider);
    if (!service || service.enabled === false || !providerMeta) throw new Error('Review LLM service is unavailable');
    const options: LLMProviderOptions = {
      app: this.workflow.app,
      serviceOptions: service.options,
      modelOptions: { ...modelOptions, structuredOutput },
      requestContext: { sessionId: `workflow-${processor.execution.id}-${node.id}` },
    };
    let provider: LLMProvider;
    try {
      provider = new providerMeta.provider(options);
    } catch (_error) {
      throw new Error('Review LLM service is unavailable');
    }
    const job = processor.saveJob({
      status: JOB_STATUS.PENDING,
      nodeId: node.id,
      nodeKey: node.key,
      upstreamId: input && 'id' in input ? input.id : null,
    });
    const abort = processor.createBackgroundAbortHandle();
    try {
      await processor.exit();
    } catch (error) {
      abort.dispose();
      throw error;
    }

    const finish = async () => {
      try {
        const lock = await this.workflow.app.lockManager.tryAcquire(
          getExecutionLockKey(processor.execution.id),
          60_000,
        );
        const started = await lock.runExclusive(
          () =>
            this.withOwnedRequest(requestId, processor.execution.id, async (request, transaction) => {
              abort.throwIfAborted();
              const claims = request.get('llmClaims');
              if (!isRecord(claims) || claims[String(node.id)] !== String(processor.execution.id)) return null;
              const pending = await this.workflow.db.getCollection('jobs').model.findOne({
                where: { id: job.id, executionId: processor.execution.id, nodeId: node.id, status: JOB_STATUS.PENDING },
                transaction,
                lock: transaction.LOCK.UPDATE,
              });
              if (!pending) return null;
              abort.throwIfAborted();
              try {
                const outcome: Promise<ProviderOutcome> = provider
                  .invoke(
                    {
                      messages: parsedMessages as unknown as Parameters<LLMProvider['invoke']>[0]['messages'],
                      structuredOutput: structuredOutput as Parameters<LLMProvider['invoke']>[0]['structuredOutput'],
                    },
                    { signal: abort.signal },
                  )
                  .then(
                    (response) => ({ ok: true, response }),
                    (error: unknown) => ({ ok: false, error }),
                  );
                return { outcome };
              } catch (error) {
                return { outcome: Promise.resolve<ProviderOutcome>({ ok: false, error }) };
              }
            }),
          60_000,
        );
        if (!started) return;
        let status: typeof JOB_STATUS.RESOLVED | typeof JOB_STATUS.ERROR;
        let result: unknown;
        const outcome = await started.outcome;
        if (outcome.ok) {
          const wrapper = isRecord(outcome.response) ? outcome.response : {};
          const raw = isRecord(wrapper.raw) ? wrapper.raw : wrapper;
          status = JOB_STATUS.RESOLVED;
          result = {
            id: raw.id,
            content: raw.content,
            additionalKwargs: raw.additional_kwargs,
            responseMetadata: raw.response_metadata,
            toolCalls: raw.tool_calls,
            structuredContent: wrapper.parsed,
          };
        } else {
          const error = outcome.error;
          if (abort.signal.aborted || isWorkflowTimeoutError(error)) return;
          const errorName = error instanceof Error ? error.name : 'Error';
          processor.logger.error('Git review LLM invocation failed', { node: node.id, errorName });
          status = JOB_STATUS.ERROR;
          result = 'Review LLM invocation failed';
        }
        abort.throwIfAborted();
        await this.settle(requestId, processor.execution.id, node.id, job.id, status, result, abort);
      } finally {
        abort.dispose();
      }
    };
    finish().catch((error: unknown) => {
      processor.logger.error('Git review LLM completion could not be recorded', {
        node: node.id,
        errorName: error instanceof Error ? error.name : 'Error',
      });
    });
  }

  private async withOwnedRequest<T>(
    requestId: ID,
    executionId: ID,
    work: (request: LockedRequest, transaction: Transaction) => Promise<T>,
  ): Promise<T | null> {
    return withOwnedRequest(this.workflow, requestId, executionId, work);
  }

  private async claimNode(requestId: ID, executionId: ID, nodeId: ID): Promise<boolean> {
    if (!/^\d+$/.test(String(nodeId))) throw new Error('Invalid review node');
    const claimed = await this.withOwnedRequest(requestId, executionId, async (request, transaction) => {
      const existing = request.get('llmClaims');
      if (existing != null && !isRecord(existing)) throw new Error('Invalid review LLM claims');
      const claims = existing ?? {};
      if (Object.prototype.hasOwnProperty.call(claims, String(nodeId))) return false;
      const jobs = await this.workflow.db.getCollection('jobs').model.count({
        where: { executionId, nodeId },
        transaction,
      });
      if (jobs) return false;
      await request.update({ llmClaims: { ...claims, [String(nodeId)]: String(executionId) } }, { transaction });
      return true;
    });
    return claimed === true;
  }

  private async isCurrentPendingRequest(requestId: ID, executionId: ID, nodeId: ID, jobId: ID): Promise<boolean> {
    const db = this.workflow.db;
    const request = await db.getRepository('gitReviewRequests').findOne({ filterByTk: requestId });
    if (!request || request.fenced || String(request.executionId) !== String(executionId)) return false;
    const execution = await db.getRepository('executions').findOne({ filterByTk: executionId });
    if (
      !execution ||
      execution.status !== EXECUTION_STATUS.STARTED ||
      String(execution.workflowId) !== String(request.workflowId)
    )
      return false;
    if (execution.expiresAt && new Date(execution.expiresAt).getTime() <= Date.now()) return false;
    const inbox = await db.getRepository('gitReviewInbox').findOne({ filterByTk: request.inboxId });
    if (!inbox || inbox.state !== 'running') return false;
    const project = await db.getRepository('gitReviewProjects').findOne({ filter: { projectKey: inbox.projectKey } });
    if (!project || String(project.activeInboxId) !== String(inbox.id)) return false;
    const job = await db.getRepository('jobs').findOne({ filterByTk: jobId });
    return Boolean(
      job &&
        job.status === JOB_STATUS.PENDING &&
        String(job.executionId) === String(executionId) &&
        String(job.nodeId) === String(nodeId),
    );
  }

  private async settle(
    requestId: ID,
    executionId: ID,
    nodeId: ID,
    jobId: ID,
    status: typeof JOB_STATUS.RESOLVED | typeof JOB_STATUS.ERROR,
    result: unknown,
    abort: BackgroundHandle,
  ) {
    const lock = await this.workflow.app.lockManager.tryAcquire(getExecutionLockKey(executionId), 60_000);
    await lock.runExclusive(async () => {
      abort.throwIfAborted();
      if (!(await this.isCurrentPendingRequest(requestId, executionId, nodeId, jobId))) return;
      abort.throwIfAborted();
      const [updated] = await this.workflow.db
        .getModel('jobs')
        .update({ status, result }, { where: { id: jobId, executionId, nodeId, status: JOB_STATUS.PENDING } });
      if (updated !== 1) return;
      const job = await this.workflow.db.getRepository('jobs').findOne({ filterByTk: jobId });
      if (job) await this.workflow.resume(job);
    }, 60_000);
  }

  private async isContinuationFrontier(requestId: ID, executionId: ID, nodeId: ID, jobId: ID): Promise<boolean> {
    const allowed = await this.withOwnedRequest(requestId, executionId, async (request, transaction) => {
      const claims = request.get('llmClaims');
      if (!isRecord(claims) || claims[String(nodeId)] !== String(executionId)) return false;
      const node = await this.workflow.db.getCollection('flow_nodes').model.findOne({
        where: { id: nodeId, workflowId: request.get('workflowId'), type: 'git-review-llm' },
        transaction,
      });
      const job = await this.workflow.db.getCollection('jobs').model.findOne({
        where: { id: jobId, executionId, nodeId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!node || !job || ![JOB_STATUS.RESOLVED, JOB_STATUS.ERROR].some((status) => status === job.get('status')))
        return false;
      const downstreamId = node.get('downstreamId');
      if (downstreamId == null) return false;
      const nextNode = await this.workflow.db.getCollection('flow_nodes').model.findOne({
        where: { id: downstreamId, workflowId: request.get('workflowId') },
        transaction,
      });
      if (!nextNode) return false;
      const nextJob = await this.workflow.db.getCollection('jobs').model.findOne({
        where: { executionId, nodeId: downstreamId },
        transaction,
      });
      if (nextJob) {
        if (nextNode.get('type') !== 'git-review-result') return false;
        const followingId = nextNode.get('downstreamId');
        const following =
          followingId == null
            ? null
            : await this.workflow.db.getCollection('flow_nodes').model.findOne({
                where: { id: followingId, workflowId: request.get('workflowId'), type: 'manual' },
                transaction,
              });
        if (!following) return false;
        const manualJob = await this.workflow.db.getCollection('jobs').model.findOne({
          where: { executionId, nodeId: followingId },
          transaction,
        });
        return !manualJob;
      }
      if (
        nextNode.get('type') === 'git-review-llm' &&
        Object.prototype.hasOwnProperty.call(claims, String(downstreamId))
      )
        return false;
      return true;
    });
    return allowed === true;
  }

  /** A terminal LLM job is itself the durable continuation record. */
  async reconcileContinuations(requestId: ID, executionId: ID): Promise<void> {
    const jobs = await this.workflow.db.getRepository('jobs').find({
      filter: { executionId, status: [JOB_STATUS.RESOLVED, JOB_STATUS.ERROR] },
      fields: ['id', 'nodeId', 'executionId', 'status'],
    });
    for (const job of jobs) {
      const lock = await this.workflow.app.lockManager.tryAcquire(getExecutionLockKey(executionId), 60_000);
      await lock.runExclusive(async () => {
        if (!(await this.isContinuationFrontier(requestId, executionId, job.nodeId, job.id))) return;
        const terminal = await this.workflow.db.getRepository('jobs').findOne({ filterByTk: job.id });
        if (terminal) await this.workflow.resume(terminal);
      }, 60_000);
    }
  }

  async resume(node: FlowNodeModel, job: IJob, processor: Processor): Promise<IJob | void> {
    const id = job.id;
    if (
      (typeof id !== 'number' && typeof id !== 'string') ||
      !(await this.isContinuationFrontier(reviewRequestId(processor), processor.execution.id, node.id, id))
    ) {
      await processor.exit();
      return;
    }
    return job;
  }
}
