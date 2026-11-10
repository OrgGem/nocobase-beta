/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import type { WorkflowModel } from '@nocobase/plugin-workflow';
import { isRecord, type ID, type PostMode } from './contracts';
import { buildTemplate, type TemplateBindings, type TemplateName } from './templates';
import { assertSafeWorkflow } from './safe-graph';
import { assertEligibleApprover } from './approvals';

export type SetupInput = { flowId: ID; template?: TemplateName; approverIds?: ID[]; createRevision?: boolean };
type ModelRef = { llmService: string; model: string };
type AIPlugin = {
  aiEmployeesManager: { resolveModel(employee: unknown, model?: ModelRef | null): Promise<ModelRef> };
  aiManager: { llmProviders: { get(name: string): unknown } };
};

export type SetupStatus = {
  flowId: ID;
  workflowId: ID | null;
  workflowKey: string | null;
  enabled: boolean;
  blockers: string[];
  template: TemplateName;
  approverIds: ID[];
};

const TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function supportsRuntime(app: Application): boolean {
  const workflow = app.pm.get('workflow') as unknown as
    | {
        registerInstruction?: unknown;
        resume?: unknown;
        start?: unknown;
        execute?: unknown;
        timeoutManager?: unknown;
        instructions?: { get(key: string): unknown };
        triggers?: { get(key: string): unknown };
      }
    | undefined;
  const ai = app.pm.get('ai') as unknown as AIPlugin | undefined;
  const git = (app.pm.get('plugin-git-manager') || app.pm.get('git-manager')) as unknown as
    | { reviewService?: { claim?: unknown; prepareContext?: unknown; publish?: unknown } }
    | undefined;
  return Boolean(
    workflow &&
      typeof workflow.registerInstruction === 'function' &&
      typeof workflow.resume === 'function' &&
      typeof workflow.start === 'function' &&
      typeof workflow.execute === 'function' &&
      workflow.timeoutManager &&
      workflow.instructions?.get('git-review-llm') &&
      workflow.instructions?.get('manual') &&
      workflow.instructions?.get('git-review-context') &&
      workflow.instructions?.get('git-review-result') &&
      workflow.instructions?.get('git-review-publish') &&
      workflow.triggers?.get('collection') &&
      typeof ai?.aiEmployeesManager?.resolveModel === 'function' &&
      typeof git?.reviewService?.claim === 'function' &&
      typeof git.reviewService.prepareContext === 'function' &&
      typeof git.reviewService.publish === 'function' &&
      app.db.getCollection('workflowManualTasks') &&
      app.db.getCollection('gitReviewRequests'),
  );
}

async function bindingsFor(app: Application, flow: Record<string, unknown>, input: SetupInput) {
  const blockers: string[] = [];
  if (!supportsRuntime(app)) {
    const postMode: PostMode = flow.postMode === 'auto' || flow.postMode === 'disabled' ? flow.postMode : 'manual';
    return {
      blockers: ['unsupported_dependencies'],
      bindings: {
        template: input.template === 'full' ? 'full' : 'quick',
        username: '',
        persona: '',
        llmService: '',
        model: '',
        userId: null,
        approverIds: input.approverIds ?? [],
        postMode,
      } as TemplateBindings,
    };
  }
  const username = typeof flow.aiEmployeeUsername === 'string' ? flow.aiEmployeeUsername.trim() : '';
  const employee = username ? await app.db.getRepository('aiEmployees').findOne({ filter: { username } }) : null;
  if (!employee || employee.enabled === false) blockers.push('employee_missing');
  const persona =
    typeof employee?.about === 'string'
      ? employee.about
      : typeof employee?.defaultPrompt === 'string'
        ? employee.defaultPrompt
        : '';
  if (/\{\{[^{}]+\}\}/.test(persona)) blockers.push('employee_prompt_dynamic');
  const repositoryId = flow.repositoryId;
  const repository =
    (typeof repositoryId === 'string' && repositoryId) || typeof repositoryId === 'number'
      ? await app.db.getRepository('gitRepositories').findOne({ filterByTk: repositoryId })
      : (await app.db.getRepository('gitRepositories').find({ limit: 1 }))[0];
  if (!repository) blockers.push('repository_missing');
  const suppliedService = typeof flow.llmService === 'string' ? flow.llmService.trim() : '';
  const suppliedModel = typeof flow.model === 'string' ? flow.model.trim() : '';
  let resolved: ModelRef | null = null;
  if ((suppliedService && !suppliedModel) || (!suppliedService && suppliedModel)) blockers.push('model_incomplete');
  if (employee && !blockers.includes('model_incomplete')) {
    try {
      const ai = app.pm.get('ai') as unknown as AIPlugin;
      resolved = await ai.aiEmployeesManager.resolveModel(
        employee,
        suppliedService && suppliedModel ? { llmService: suppliedService, model: suppliedModel } : null,
      );
      const service = await app.db.getRepository('llmServices').findOne({ filter: { name: resolved.llmService } });
      if (
        !resolved.model ||
        !service ||
        service.enabled === false ||
        !ai.aiManager.llmProviders.get(service.provider)
      ) {
        resolved = null;
      }
    } catch (_error) {
      resolved = null;
    }
  }
  if (!resolved) blockers.push('model_missing');
  const creator = flow.createdById as ID | undefined;
  const proposed = input.approverIds ?? (creator != null ? [creator] : []);
  const approverIds: ID[] = [];
  for (const id of proposed) {
    if ((typeof id !== 'string' && typeof id !== 'number') || approverIds.some((item) => String(item) === String(id))) {
      continue;
    }
    const user = await app.db.getRepository('users').findOne({ filterByTk: id });
    const roles = await app.db.getRepository('rolesUsers').find({ filter: { userId: id }, limit: 1 });
    if (user && roles.length) approverIds.push(user.id as ID);
  }
  const postMode: PostMode = flow.postMode === 'auto' || flow.postMode === 'disabled' ? flow.postMode : 'manual';
  if (postMode === 'manual' && (!approverIds.length || approverIds.length !== proposed.length)) {
    blockers.push('approver_missing');
  }
  if (
    postMode === 'manual' &&
    approverIds.length &&
    (typeof flow.repositoryId === 'string' || typeof flow.repositoryId === 'number')
  ) {
    try {
      await assertEligibleApprover(app, approverIds, flow.repositoryId);
    } catch (_error) {
      blockers.push('approver_unavailable');
    }
  }
  const userId = creator ?? approverIds[0] ?? null;
  if (userId == null || !(await app.db.getRepository('users').findOne({ filterByTk: userId }))) {
    blockers.push('execution_user_missing');
  }
  const bindings: TemplateBindings = {
    template: input.template === 'full' ? 'full' : 'quick',
    username,
    persona,
    llmService: resolved?.llmService ?? '',
    model: resolved?.model ?? '',
    userId,
    approverIds,
    postMode,
  };
  return { blockers, bindings };
}

function optionsFor(workflow: WorkflowModel | null): Record<string, unknown> {
  const options: unknown = workflow?.options;
  return isRecord(options) ? options : {};
}

export async function getStatus(app: Application, flowId: ID): Promise<SetupStatus> {
  const flow = await app.db.getRepository('gitReviewFlows').findOne({ filterByTk: flowId });
  if (!flow) throw new Error('Review flow not found');
  const bound = flow.workflowId
    ? ((await app.db.getRepository('workflows').findOne({ filterByTk: flow.workflowId })) as WorkflowModel | null)
    : null;
  const boundMarker = optionsFor(bound).gitReview;
  const workflow =
    isRecord(boundMarker) && boundMarker.draft === true
      ? bound
      : flow.workflowKey
        ? ((await app.db
            .getRepository('workflows')
            .findOne({ filter: { key: flow.workflowKey, current: true } })) as WorkflowModel | null)
        : bound;
  const marker = optionsFor(workflow).gitReview;
  const saved = isRecord(marker) ? marker : {};
  const input: SetupInput = {
    flowId,
    template: saved.template === 'full' ? 'full' : 'quick',
    approverIds: Array.isArray(saved.approverIds) ? (saved.approverIds as ID[]) : undefined,
  };
  const { blockers, bindings } = await bindingsFor(app, flow.toJSON(), input);
  if (!workflow) blockers.push('workflow_missing');
  if (workflow?.enabled && !blockers.includes('unsupported_dependencies')) {
    try {
      await assertSafeWorkflow(app, workflow.id, bindings.postMode);
    } catch (_error) {
      blockers.push('unsafe_graph');
    }
  }
  return {
    flowId,
    workflowId: workflow?.id ?? null,
    workflowKey: workflow?.key ?? null,
    enabled: Boolean(workflow?.enabled),
    blockers,
    template: bindings.template,
    approverIds: bindings.approverIds,
  };
}

async function provisionLocked(app: Application, input: SetupInput): Promise<SetupStatus> {
  const flows = app.db.getRepository('gitReviewFlows');
  const initial = await flows.findOne({ filterByTk: input.flowId });
  if (!initial) throw new Error('Review flow not found');
  if (initial.workflowId && !input.createRevision) return getStatus(app, input.flowId);
  const { blockers, bindings } = await bindingsFor(app, initial.toJSON(), input);
  if (blockers.includes('unsupported_dependencies')) return getStatus(app, input.flowId);

  const workflow = await app.db.sequelize.transaction(async (transaction) => {
    const flow = await flows.findOne({ filterByTk: input.flowId, transaction, lock: transaction.LOCK.UPDATE });
    if (!flow) throw new Error('Review flow not found');
    if (flow.workflowId && !input.createRevision) {
      return (await app.db
        .getRepository('workflows')
        .findOne({ filterByTk: flow.workflowId, transaction })) as WorkflowModel;
    }
    const key = typeof flow.workflowKey === 'string' && flow.workflowKey ? flow.workflowKey : `git-review-${flow.id}`;
    const workflow = (await app.db.getRepository('workflows').create({
      values: {
        key,
        current: null,
        enabled: false,
        title: `Git review: ${String(flow.name || flow.id)} (${bindings.template})`,
        type: 'collection',
        sync: false,
        config: { collection: 'gitReviewRequests', mode: 1 },
        options: {
          timeout: TIMEOUT_MS,
          gitReview: {
            flowId: flow.id,
            template: bindings.template,
            approverIds: bindings.approverIds,
            postMode: bindings.postMode,
            version: 2,
            draft: true,
            frozen: false,
          },
        },
      },
      transaction,
    })) as WorkflowModel;
    await workflow.update(
      { config: { collection: 'gitReviewRequests', mode: 1, condition: { workflowKey: { $eq: workflow.key } } } },
      { transaction },
    );
    let previous: Awaited<ReturnType<WorkflowModel['createNode']>> | null = null;
    for (const definition of buildTemplate(bindings)) {
      const next = await workflow.createNode({ ...definition, upstreamId: previous?.id ?? null }, { transaction });
      if (previous) await previous.update({ downstreamId: next.id }, { transaction });
      previous = next;
    }
    await flow.update({ workflowId: workflow.id, workflowKey: workflow.key }, { transaction });
    return workflow;
  });

  if (!blockers.length && !workflow.enabled) {
    const currentFlow = await flows.findOne({ filterByTk: input.flowId });
    const checked = currentFlow ? await bindingsFor(app, currentFlow.toJSON(), input) : null;
    if (
      currentFlow?.enabled !== false &&
      String(currentFlow?.workflowId) === String(workflow.id) &&
      checked &&
      !checked.blockers.length &&
      JSON.stringify(checked.bindings) === JSON.stringify(bindings)
    ) {
      await assertSafeWorkflow(app, workflow.id, bindings.postMode, false);
      await app.db.sequelize.transaction(async (transaction) => {
        const current = await flows.findOne({ filterByTk: input.flowId, transaction, lock: transaction.LOCK.UPDATE });
        if (!current || String(current.workflowId) !== String(workflow.id) || current.enabled === false) return;
        const options = optionsFor(workflow);
        const marker = isRecord(options.gitReview) ? options.gitReview : {};
        await workflow.update(
          { enabled: true, options: { ...options, gitReview: { ...marker, draft: false, frozen: true } } },
          { transaction },
        );
      });
    }
  }
  return getStatus(app, input.flowId);
}

export async function provision(app: Application, input: SetupInput): Promise<SetupStatus> {
  const lock = await app.lockManager.tryAcquire(`git-review-provision:${input.flowId}`, 60_000);
  return lock.runExclusive(() => provisionLocked(app, input), 120_000);
}
