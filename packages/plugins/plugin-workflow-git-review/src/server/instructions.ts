/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'crypto';
import { Instruction, JOB_STATUS, type FlowNodeModel, type IJob, type Processor } from '@nocobase/plugin-workflow';
import { isRecord, reviewService, type ID } from './contracts';
import { parseReview, renderReview, validateFindingLocations } from './review-result';
import { assertSafeWorkflow, assertSafeNodes, verifyManualDecision, type SafeNode } from './safe-graph';
import { persistPublishCheckpoint, persistReviewCheckpoint } from './checkpoint';

function requestId(processor: Processor): ID {
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

function errorJob(error: unknown) {
  return { status: JOB_STATUS.ERROR, result: error instanceof Error ? error.message : String(error) };
}

export class ReviewContextInstruction extends Instruction {
  async run(_node: FlowNodeModel, _input: unknown, processor: Processor) {
    try {
      const id = requestId(processor);
      const service = reviewService(this.workflow.app);
      if (!(await service.claim(id, processor.execution.id))) throw new Error('Review request is already owned');
      const context = await service.prepareContext(id, processor.execution.id);
      await assertSafeWorkflow(this.workflow.app, processor.execution.workflowId, context.postMode);
      assertSafeNodes(processor.nodes as unknown as SafeNode[], context.postMode);
      const workflow = await this.workflow.db
        .getRepository('workflows')
        .findOne({ filterByTk: processor.execution.workflowId });
      const approvers: unknown = workflow?.options?.gitReview?.approverIds;
      if (
        !context.headSha ||
        (typeof context.userId !== 'number' && typeof context.userId !== 'string') ||
        typeof context.diff !== 'string' ||
        !isRecord(context.coverage) ||
        typeof context.coverage.complete !== 'boolean' ||
        !Array.isArray(context.coverage.limitations) ||
        !context.coverage.limitations.every((item) => typeof item === 'string' && item.trim()) ||
        (!context.coverage.complete && !context.coverage.limitations.length)
      )
        throw new Error('Pinned Git context or coverage is incomplete');
      return {
        status: JOB_STATUS.RESOLVED,
        result: {
          ...context,
          instructions: context.instructions ?? '',
          approverIds:
            context.targetType === 'mr' && context.postMode === 'manual' && Array.isArray(approvers) ? approvers : [],
        },
      };
    } catch (error) {
      return errorJob(error);
    }
  }

  async resume(_node: FlowNodeModel, job: IJob): Promise<IJob> {
    return job;
  }
}

export class ReviewResultInstruction extends Instruction {
  async run(node: FlowNodeModel, input: unknown, processor: Processor) {
    try {
      const id = requestId(processor);
      const service = reviewService(this.workflow.app);
      const context = await service.prepareContext(id, processor.execution.id);
      const nodes = await assertSafeWorkflow(this.workflow.app, processor.execution.workflowId, context.postMode);
      assertSafeNodes(processor.nodes as unknown as SafeNode[], context.postMode);
      const value: unknown = processor.getParsedValue(node.config.value, node.id);
      const review = parseReview(value);
      validateFindingLocations(review, context.diff);
      for (const llm of nodes.filter((item) => item.type === 'git-review-llm')) {
        const jobs = await this.workflow.db.getRepository('jobs').find({
          filter: { executionId: processor.execution.id, nodeId: llm.id },
        });
        if (jobs.length !== 1 || jobs[0].status !== JOB_STATUS.RESOLVED || !isRecord(jobs[0].result)) {
          throw new Error('Every review pass must finish successfully');
        }
        const pass = parseReview(jobs[0].result.structuredContent);
        validateFindingLocations(pass, context.diff);
        for (const finding of pass.findings) {
          if (
            !review.findings.some(
              (item) => item.file === finding.file && item.line === finding.line && item.title === finding.title,
            )
          ) {
            review.findings.push(finding);
          }
        }
        for (const limitation of pass.coverage.limitations) {
          if (!review.coverage.limitations.includes(limitation)) review.coverage.limitations.push(limitation);
        }
      }
      if (review.findings.length) review.verdict = 'findings';
      if (
        !context.coverage ||
        typeof context.coverage.complete !== 'boolean' ||
        !Array.isArray(context.coverage.limitations)
      ) {
        throw new Error('Source coverage is unavailable');
      }
      for (const limitation of context.coverage.limitations) {
        if (typeof limitation !== 'string' || !limitation.trim()) throw new Error('Source coverage is invalid');
        if (!review.coverage.limitations.includes(limitation)) review.coverage.limitations.push(limitation);
      }
      if (!context.coverage.complete && !context.coverage.limitations.length)
        throw new Error('Source limitations are missing');
      const markdown = renderReview(review, context.headSha);
      const fingerprint = await service.saveResult(id, processor.execution.id, markdown);
      const expected = createHash('sha256').update(markdown, 'utf8').digest('hex');
      if (fingerprint !== expected) throw new Error('Stored review fingerprint does not match the result');
      await service.markAISettled(id, processor.execution.id);
      const upstreamId =
        isRecord(input) && (typeof input.id === 'string' || typeof input.id === 'number') ? input.id : null;
      const checkpoint = await persistReviewCheckpoint(
        this.workflow,
        processor,
        nodes,
        context,
        markdown,
        fingerprint,
        upstreamId,
      );
      await processor.exit();
      if (checkpoint.created && checkpoint.resumeJobId != null) {
        const job = await this.workflow.db.getRepository('jobs').findOne({ filterByTk: checkpoint.resumeJobId });
        if (job) await this.workflow.resume(job);
      }
      return;
    } catch (error) {
      const existing = await this.workflow.db.getRepository('jobs').findOne({
        filter: { executionId: processor.execution.id, nodeId: node.id, status: JOB_STATUS.RESOLVED },
      });
      if (existing) {
        await processor.exit();
        return;
      }
      return errorJob(error);
    }
  }

  async resume(_node: FlowNodeModel, job: IJob): Promise<IJob> {
    return job;
  }
}

export class ReviewPublishInstruction extends Instruction {
  async run(node: FlowNodeModel, input: unknown, processor: Processor) {
    try {
      const id = requestId(processor);
      const service = reviewService(this.workflow.app);
      const context = await service.prepareContext(id, processor.execution.id);
      await assertSafeWorkflow(this.workflow.app, processor.execution.workflowId, context.postMode);
      const result: unknown = processor.getParsedValue(node.config.result, node.id);
      if (!isRecord(result) || typeof result.fingerprint !== 'string' || typeof result.markdown !== 'string') {
        throw new Error('Validated review result is missing');
      }
      const expected = createHash('sha256').update(result.markdown, 'utf8').digest('hex');
      if (result.fingerprint !== expected) throw new Error('Review result fingerprint is invalid');
      if (context.postMode === 'manual') {
        await verifyManualDecision(
          this.workflow.app,
          processor.execution.workflowId,
          processor.execution.id,
          result.fingerprint,
          'approve',
        );
      }
      const publication = await service.publish(id, processor.execution.id, result.fingerprint);
      if (publication.status === 'in_progress') {
        await processor.exit();
        return;
      }
      const upstreamId =
        isRecord(input) && (typeof input.id === 'string' || typeof input.id === 'number') ? input.id : null;
      const nodeKey: unknown = node.get('key');
      if (typeof nodeKey !== 'string' || !nodeKey) throw new Error('Review publication node key is missing');
      const checkpoint = await persistPublishCheckpoint(
        this.workflow,
        id,
        processor.execution.id,
        { id: node.id, key: nodeKey },
        result.fingerprint,
        context.postMode,
        publication.status,
        upstreamId,
      );
      await processor.exit();
      if (checkpoint.created) {
        const job = await this.workflow.db.getRepository('jobs').findOne({ filterByTk: checkpoint.jobId });
        if (job) await this.workflow.resume(job);
      }
      return;
    } catch (error) {
      const existing = await this.workflow.db.getRepository('jobs').findOne({
        filter: { executionId: processor.execution.id, nodeId: node.id, status: JOB_STATUS.RESOLVED },
      });
      if (existing) {
        await processor.exit();
        return;
      }
      return errorJob(error);
    }
  }

  async resume(_node: FlowNodeModel, job: IJob): Promise<IJob> {
    return job;
  }
}
