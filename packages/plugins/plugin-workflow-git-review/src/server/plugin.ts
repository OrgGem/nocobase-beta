/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import { Plugin } from '@nocobase/server';
import WorkflowPlugin, { type ExecutionModel } from '@nocobase/plugin-workflow';
import { isRecord, reviewService, type ID } from './contracts';
import { ReviewContextInstruction, ReviewPublishInstruction, ReviewResultInstruction } from './instructions';
import { getStatus, provision, type SetupInput } from './provision';
import { reconcileRequests } from './reconcile';
import { assertEligibleApprover, assignedReview, listApprovals } from './approvals';
import { guardReviewWorkflows } from './guards';
import { assertLLMJobsSettled, assertNoInFlightAI, assertSafeWorkflow, verifyManualDecision } from './safe-graph';
import type { PostMode } from './contracts';
import type { Transaction } from '@nocobase/database';
import { graphDatabaseGuards } from './graph-db-guard';
import { GitReviewLLMInstruction } from './llm-instruction';
import { guardReviewReads } from './read-guard';

const NAMESPACE = 'plugin-workflow-git-review';
const MUTATIONS = new Set(['setup', 'repair']);

function validId(value: unknown): value is ID {
  return (
    (typeof value === 'string' && /^\d+$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  );
}

function setupInput(values: unknown, createRevision: boolean): SetupInput | null {
  if (!isRecord(values) || !validId(values.flowId)) return null;
  if (values.template != null && values.template !== 'quick' && values.template !== 'full') return null;
  if (values.approverIds != null && (!Array.isArray(values.approverIds) || !values.approverIds.every(validId)))
    return null;
  return {
    flowId: values.flowId,
    template: values.template === 'full' ? 'full' : 'quick',
    approverIds: values.approverIds as ID[] | undefined,
    createRevision,
  };
}

export default class PluginWorkflowGitReviewServer extends Plugin {
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private graphGuards = graphDatabaseGuards(this.app);

  async assertSafeWorkflow(workflowId: ID, postMode: PostMode, transaction?: Transaction, repositoryId?: ID) {
    const target = await this.db.getRepository('workflows').findOne({ filterByTk: workflowId, transaction });
    if (!target) throw new Error('Review workflow was not found');
    const listeners = await this.db
      .getRepository('workflows')
      .find({ filter: { enabled: true, type: 'collection' }, transaction });
    for (const listener of listeners) {
      const collection = listener.config?.collection;
      if (collection !== 'gitReviewRequests' && collection !== 'main:gitReviewRequests') continue;
      const condition: unknown = listener.config?.condition;
      if (
        !isRecord(condition) ||
        Object.keys(condition).length !== 1 ||
        !isRecord(condition.workflowKey) ||
        Object.keys(condition.workflowKey).length !== 1 ||
        condition.workflowKey.$eq !== listener.key
      ) {
        throw new Error('An unsafe workflow listener can receive review requests');
      }
      if (listener.key !== target.key) continue;
      const marker: unknown = listener.options?.gitReview;
      if (!isRecord(marker) || !['manual', 'auto', 'disabled'].includes(String(marker.postMode))) {
        throw new Error('Review listener has no immutable policy');
      }
      const mode = marker.postMode as PostMode;
      await assertSafeWorkflow(this.app, listener.id, mode, true, transaction);
    }
    const nodes = await assertSafeWorkflow(this.app, workflowId, postMode, true, transaction);
    if (postMode === 'manual') {
      const approverIds: unknown = target.options?.gitReview?.approverIds;
      if ((typeof repositoryId !== 'string' && typeof repositoryId !== 'number') || !Array.isArray(approverIds)) {
        throw new Error('No configured approver can access this repository');
      }
      await assertEligibleApprover(this.app, approverIds as ID[], repositoryId, transaction);
    }
    return nodes;
  }

  async assertAISettled(requestId: ID, executionId: ID) {
    await assertLLMJobsSettled(this.app, requestId, executionId);
  }

  async assertNoInFlightAI(requestId: ID, executionId: ID) {
    await assertNoInFlightAI(this.app, requestId, executionId);
  }

  async assertManualRejection(workflowId: ID, executionId: ID, fingerprint: string) {
    await verifyManualDecision(this.app, workflowId, executionId, fingerprint, 'reject');
  }

  async assertManualApproval(workflowId: ID, executionId: ID, fingerprint: string) {
    await verifyManualDecision(this.app, workflowId, executionId, fingerprint, 'approve');
  }

  private async provisionExisting() {
    if (!this.db.getCollection('gitReviewFlows') || !this.db.getCollection('workflows')) return;
    const flows = await this.db.getRepository('gitReviewFlows').find({ sort: ['id'] });
    for (const flow of flows) {
      if (flow.workflowId) continue;
      try {
        await provision(this.app, { flowId: flow.id });
      } catch (error) {
        this.log.warn('Unable to provision Git review workflow', { flowId: flow.id, error });
      }
    }
  }

  private async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const workflow = this.app.pm.get('workflow') as WorkflowPlugin | undefined;
      if (workflow && this.db.getCollection('gitReviewRequests')) await reconcileRequests(this.app, workflow);
    } finally {
      this.reconciling = false;
    }
  }

  private executionUpdated = async (
    execution: ExecutionModel,
    options: { transaction?: { afterCommit(fn: () => void): void } },
  ) => {
    if (typeof execution.status !== 'number' || execution.status === 0) return;
    const handle = async () => {
      const request = await this.db
        .getRepository('gitReviewRequests')
        .findOne({ filter: { executionId: execution.id } });
      if (request) await reviewService(this.app).onExecutionStatus(execution.id, execution.status);
    };
    if (options.transaction) {
      options.transaction.afterCommit(() => {
        handle().catch((error) => this.log.error('Git review execution status update failed', { error }));
      });
    } else {
      await handle();
    }
  };

  private flowDestroyed = async (
    flow: { workflowKey?: string },
    options: { transaction?: { afterCommit(fn: () => void): void } },
  ) => {
    const workflowKey = flow.workflowKey;
    if (!workflowKey) return;
    const disable = async () => {
      const flows = await this.db.getRepository('gitReviewFlows').count({ filter: { workflowKey } });
      if (flows) return;
      const revisions = await this.db.getRepository('workflows').find({ filter: { key: workflowKey, enabled: true } });
      for (const revision of revisions) await revision.update({ enabled: false });
    };
    if (options.transaction) {
      options.transaction.afterCommit(() => {
        disable().catch((error) => this.log.error('Could not disable orphaned review workflows', { error }));
      });
    } else {
      await disable();
    }
  };

  private async setupAction(ctx: Context, next: Next, createRevision: boolean) {
    this.requireRoot(ctx);
    const input = setupInput(ctx.action.params.values, createRevision);
    if (!input) ctx.throw(400, ctx.t('Invalid setup parameters', { ns: NAMESPACE }));
    try {
      ctx.body = await provision(this.app, input);
    } catch (error) {
      this.log.warn('Git review setup failed', { error });
      ctx.throw(400, ctx.t('Could not set up the review workflow', { ns: NAMESPACE }));
    }
    await next();
  }

  private requireRoot(ctx: Context) {
    if (
      !Array.isArray(ctx.state?.currentRoles) ||
      !ctx.state.currentRoles.includes('root') ||
      !ctx.state.currentUser?.id
    ) {
      ctx.throw(403, ctx.t('Permission denied', { ns: NAMESPACE }));
    }
  }

  async load() {
    const workflow = this.app.pm.get('workflow') as WorkflowPlugin | undefined;
    if (workflow?.registerInstruction) {
      workflow.registerInstruction('git-review-llm', new GitReviewLLMInstruction(workflow));
      workflow.registerInstruction('git-review-context', new ReviewContextInstruction(workflow));
      workflow.registerInstruction('git-review-result', new ReviewResultInstruction(workflow));
      workflow.registerInstruction('git-review-publish', new ReviewPublishInstruction(workflow));
    }
    this.app.resourceManager.define({
      name: 'workflowGitReview',
      actions: {
        status: async (ctx, next) => {
          this.requireRoot(ctx as unknown as Context);
          const flows = await this.db.getRepository('gitReviewFlows').find({ sort: ['id'] });
          const results = [];
          for (const flow of flows) results.push({ name: flow.name, ...(await getStatus(this.app, flow.id)) });
          ctx.body = { flows: results };
          await next();
        },
        setup: async (ctx, next) => this.setupAction(ctx as unknown as Context, next, false),
        repair: async (ctx, next) => this.setupAction(ctx as unknown as Context, next, true),
        approvals: async (ctx, next) => {
          ctx.body = await listApprovals(ctx as unknown as Context);
          await next();
        },
        approval: async (ctx, next) => {
          const id = ctx.action?.params.filterByTk;
          if (!validId(id)) ctx.throw(400, ctx.t('Invalid task', { ns: NAMESPACE }));
          const review = await assignedReview(ctx as unknown as Context, id);
          if (!review) ctx.throw(404, ctx.t('Review task is unavailable', { ns: NAMESPACE }));
          ctx.body = review;
          await next();
        },
      },
    });
    this.app.resourceManager.use((ctx, next) => guardReviewReads(ctx as unknown as Context, next));
    this.app.resourceManager.use((ctx, next) => guardReviewWorkflows(ctx as unknown as Context, next));
    this.app.resourceManager.use(async (ctx, next) => {
      if (ctx.action?.resourceName === 'workflowGitReview') {
        const allowed = MUTATIONS.has(ctx.action.actionName) ? ['POST'] : ['GET', 'HEAD'];
        if (!allowed.includes(ctx.method.toUpperCase())) {
          ctx.set('Allow', allowed.join(', '));
          ctx.throw(405, ctx.t('Method not allowed', { ns: NAMESPACE }));
        }
      }
      await next();
    });
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.manage`,
      actions: ['workflowGitReview:status', 'workflowGitReview:setup', 'workflowGitReview:repair'],
    });
    this.app.acl.allow('workflowGitReview', ['approvals', 'approval'], 'loggedIn');
    this.db.on('executions.afterUpdate', this.executionUpdated);
    this.db.on('gitReviewFlows.afterDestroy', this.flowDestroyed);
    this.db.on('workflows.beforeCreate', this.graphGuards.beforeWorkflowCreate);
    this.db.on('workflows.beforeUpdate', this.graphGuards.beforeWorkflowUpdate);
    this.db.on('flow_nodes.beforeCreate', this.graphGuards.beforeNodeMutation);
    this.db.on('flow_nodes.beforeUpdate', this.graphGuards.beforeNodeMutation);
    this.db.on('flow_nodes.beforeDestroy', this.graphGuards.beforeNodeMutation);
    this.app.on('afterStart', async () => {
      await this.provisionExisting();
      await this.reconcile().catch((error) => this.log.error('Git review reconciliation failed', { error }));
      if (!this.timer) {
        this.timer = setInterval(() => {
          this.reconcile().catch((error) => this.log.error('Git review reconciliation failed', { error }));
        }, 30_000);
      }
    });
    this.app.on('beforeStop', () => this.stop());
    this.app.on('beforeDestroy', () => this.stop());
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db.off('executions.afterUpdate', this.executionUpdated);
    this.db.off('gitReviewFlows.afterDestroy', this.flowDestroyed);
    this.db.off('workflows.beforeCreate', this.graphGuards.beforeWorkflowCreate);
    this.db.off('workflows.beforeUpdate', this.graphGuards.beforeWorkflowUpdate);
    this.db.off('flow_nodes.beforeCreate', this.graphGuards.beforeNodeMutation);
    this.db.off('flow_nodes.beforeUpdate', this.graphGuards.beforeNodeMutation);
    this.db.off('flow_nodes.beforeDestroy', this.graphGuards.beforeNodeMutation);
  }

  async install() {
    await this.provisionExisting();
  }

  async upgrade() {
    await this.provisionExisting();
  }

  async afterEnable() {
    await this.provisionExisting();
  }
}
