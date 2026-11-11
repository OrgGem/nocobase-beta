/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import type { Context, Next } from '@nocobase/actions';
import type { Filter, Model } from '@nocobase/database';
import type { Plugin } from '@nocobase/server';
import { read } from '../utils/record-utils';
import { AgentGovernanceService } from './AgentGovernanceService';
import { resolveUserDepartment } from './DepartmentAttribution';
import { runWithNativeUsageAttribution } from './NativeUsageAttribution';

type ModelReference = { llmService: string; model: string };
type AiPlugin = {
  aiEmployeesManager: { resolveModel: (employee: Model, model?: ModelReference) => Promise<ModelReference> };
};
type Policy = Awaited<ReturnType<AgentGovernanceService['activePolicies']>>[number];

function valueString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function monthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function quotaError(ctx: Context, message: string): never {
  return ctx.throw(403, ctx.t(message));
}

/** Monthly checks use the observed ledger. They do not reserve future provider spending. */
async function checkObservedQuota(ctx: Context, policy: Policy, userId: number, departmentId: string | number | null) {
  const { settings } = policy;
  const checksTokens = settings.maxMonthlyTokens != null;
  const checksCost = settings.maxMonthlyCost != null;
  if (!checksTokens && !checksCost) return;
  const db = ctx.db;
  const repo = db.getRepository('agentExecutionSpans');
  const start = monthStart();
  const filter: Record<string, unknown> = {
    type: 'model_call',
    $or: [{ usageOccurredAt: { $gte: start } }, { usageOccurredAt: null, createdAt: { $gte: start } }],
  };
  if (policy.scope === 'user') filter.userId = userId;
  if (policy.scope === 'department') {
    if (departmentId == null) quotaError(ctx, 'AI governance requires an assigned primary department.');
    filter.departmentId = departmentId;
    filter.departmentAttribution = 'snapshot';
  }
  if (policy.scope === 'employee') filter.employeeUsername = policy.scopeId;
  if (policy.employeeUsername) filter.employeeUsername = policy.employeeUsername;
  const modelParts = policy.modelKey ? policy.modelKey.split(/:(.*)/s) : undefined;
  if (modelParts) {
    filter.$and = [
      { $or: [{ llmService: null }, { model: null }, { llmService: modelParts[0], model: modelParts[1] }] },
    ];
  }
  const rows = await repo.find({ filter: filter as Filter, limit: 10001, sort: ['id'] });
  if (rows.length > 10000) quotaError(ctx, 'AI quota cannot be checked because usage coverage is incomplete.');
  let tokens = 0;
  let cost = 0;
  for (const row of rows) {
    const actualModel = `${valueString(read(row, 'llmService'))}:${valueString(read(row, 'model'))}`;
    if (policy.modelKey && actualModel !== policy.modelKey) {
      if (!read(row, 'llmService') || !read(row, 'model'))
        quotaError(ctx, 'AI quota cannot be checked because usage coverage is incomplete.');
      continue;
    }
    const usage = read(row, 'totalTokens');
    const amount = read(row, 'cost');
    if (checksTokens) {
      if (read(row, 'usageSource') !== 'actual' || usage == null || !Number.isFinite(Number(usage))) {
        quotaError(ctx, 'AI quota cannot be checked because usage coverage is incomplete.');
      }
      tokens += Number(usage);
    }
    if (checksCost) {
      if (
        read(row, 'usageSource') !== 'actual' ||
        amount == null ||
        !Number.isFinite(Number(amount)) ||
        read(row, 'priceCurrency') !== 'USD'
      ) {
        quotaError(ctx, 'AI quota cannot be checked because cost is incomplete or unpriced.');
      }
      cost += Number(amount);
    }
  }

  // Model events from workflows, child sessions, and other unattributed paths have no reliable
  // invocation-time department snapshot. They are exposed separately by usage reporting.
  if (checksTokens && tokens >= Number(settings.maxMonthlyTokens)) quotaError(ctx, 'AI token quota reached.');
  if (checksCost && cost >= Number(settings.maxMonthlyCost)) quotaError(ctx, 'AI cost quota reached.');
}

export function createGovernanceAdmission(plugin: Plugin, enabled: () => boolean) {
  const service = new AgentGovernanceService(plugin.db);
  return async (context: Context, next: Next) => {
    if (!enabled()) return next();
    const { resourceName, actionName } = context.action || {};
    if (
      resourceName !== 'aiConversations' ||
      !['sendMessages', 'resendMessages', 'resumeToolCall'].includes(actionName)
    ) {
      return next();
    }
    const rawUserId = context.auth?.user?.id;
    const userId = Number(rawUserId);
    const values = context.action?.params?.values || {};
    const sessionId = valueString(values.sessionId);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !sessionId || !context.db.hasCollection('aiConversations')) {
      return next();
    }
    const conversation = await context.db.getRepository('aiConversations').findOne({ filter: { sessionId, userId } });
    if (!conversation) return next();
    const employeeUsername =
      actionName === 'sendMessages'
        ? valueString(values.aiEmployee)
        : valueString(read(conversation, 'aiEmployeeUsername'));
    if (!employeeUsername) return next();
    const employee = await context.db.getRepository('aiEmployees').findOne({ filter: { username: employeeUsername } });
    if (!employee) return next();
    let department;
    try {
      department = await resolveUserDepartment(context.db, userId);
    } catch (error) {
      const departmentPolicies = await context.db.getRepository('agentGovernancePolicies').count({
        filter: { scope: 'department', currentVersionId: { $ne: null } },
      });
      if (departmentPolicies) throw error;
      department = { departmentId: null, status: 'departments_unavailable' as const };
    }
    const run = async () => {
      const policyRepo = context.db.getRepository('agentGovernancePolicies');
      const configured = await policyRepo.count({ filter: { currentVersionId: { $ne: null } } });
      const binding = await context.db
        .getRepository('agentGovernancePromptBindings')
        .findOne({ filter: { userId, employeeUsername } });
      if (!configured && !binding) return next();
      if (department.status === 'departments_unavailable') {
        const departmentPolicies = await policyRepo.count({
          filter: { scope: 'department', currentVersionId: { $ne: null } },
        });
        if (departmentPolicies) quotaError(context, 'AI governance cannot check department policies.');
      }
      const storedEmployee = valueString(read(conversation, 'aiEmployeeUsername'));
      if (storedEmployee && storedEmployee !== employeeUsername) {
        const [requestedPolicies, storedPolicies, storedBinding] = await Promise.all([
          service.activePolicies(userId, employeeUsername, department.departmentId, undefined, undefined, true),
          service.activePolicies(userId, storedEmployee, department.departmentId, undefined, undefined, true),
          context.db
            .getRepository('agentGovernancePromptBindings')
            .findOne({ filter: { userId, employeeUsername: storedEmployee } }),
        ]);
        if (requestedPolicies.length || storedPolicies.length || binding || storedBinding) {
          quotaError(context, 'The AI employee must match the conversation for managed usage.');
        }
      }
      let policies: Policy[] = [];
      let modelKey = '';
      if (configured) {
        const aiPlugin = context.app.pm.get('ai') as unknown as AiPlugin | undefined;
        if (!aiPlugin?.aiEmployeesManager?.resolveModel)
          quotaError(context, 'AI governance could not resolve the model.');
        const rawModel = values.model;
        const requestedModel =
          rawModel &&
          typeof rawModel === 'object' &&
          typeof rawModel.llmService === 'string' &&
          typeof rawModel.model === 'string'
            ? { llmService: rawModel.llmService, model: rawModel.model }
            : undefined;
        const model = await aiPlugin.aiEmployeesManager.resolveModel(employee, requestedModel);
        if (!model?.llmService || !model?.model) quotaError(context, 'AI governance could not resolve the model.');
        modelKey = `${model.llmService}:${model.model}`;
        policies = await service.activePolicies(userId, employeeUsername, department.departmentId, undefined, modelKey);
      }
      for (const policy of policies) {
        if (
          policy.scope === 'employee' &&
          policy.settings.systemPrompt !== undefined &&
          (read(employee, 'about') ?? null) !== policy.settings.systemPrompt
        ) {
          quotaError(context, 'The managed AI employee prompt changed and needs administrator review.');
        }
        if (
          policy.settings.allow === false ||
          (policy.settings.allowedModels && !policy.settings.allowedModels.includes(modelKey))
        ) {
          quotaError(context, 'Your AI employee or model is not allowed by governance policy.');
        }
        await checkObservedQuota(context, policy, userId, department.departmentId);
      }
      const prompt = await service.preview({ userId, employeeUsername });
      if (prompt.instruction || binding) {
        if (!prompt.instruction || prompt.promptMode !== 'default' || !binding) {
          quotaError(context, 'Managed AI instructions need to be applied by an administrator.');
        }
        const expected = createHash('sha256').update(prompt.projectedPrompt).digest('hex');
        const native = await context.db
          .getRepository('usersAiEmployees')
          .findOne({ filter: { userId, aiEmployee: employeeUsername } });
        const actual = createHash('sha256')
          .update(valueString(read(native, 'prompt')))
          .digest('hex');
        const versions = prompt.policies
          .filter((policy) => policy.settings.instruction?.trim())
          .map((policy) => ({ id: policy.id, versionId: policy.versionId }));
        if (
          expected !== read(binding, 'contentHash') ||
          expected !== actual ||
          String(prompt.departmentId ?? '') !== String(read(binding, 'departmentId') ?? '') ||
          JSON.stringify(versions) !== JSON.stringify(read(binding, 'policyVersions'))
        ) {
          quotaError(context, 'Managed AI instructions need to be applied by an administrator.');
        }
      }
      return next();
    };
    return runWithNativeUsageAttribution(
      {
        db: context.db,
        userId,
        sessionId,
        ...(department.status === 'resolved' && department.departmentId != null
          ? { departmentId: department.departmentId }
          : {}),
      },
      run,
    );
  };
}
