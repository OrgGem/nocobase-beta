// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import type { Plugin } from '@nocobase/server';
import { isDeepStrictEqual } from 'node:util';
import PluginAIServer, { AIEmployee } from '@nocobase/plugin-ai/server';
import { listSystemTools } from '@nocobase/ai';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { HarnessProfileService } from './HarnessProfileService';
import { compileHarness, decideTool } from './HarnessCompiler';
import { authorizeDelegatedEmployee } from './GovernanceAdmission';
import { runWithNativeUsageAttribution } from './NativeUsageAttribution';
import { HierarchyInvocationJournal } from './HierarchyInvocationJournal';
import { ExecutionSpanService } from './ExecutionSpanService';
import { guardHierarchyEnrollment } from './HierarchyEnrollmentGuard';
import { hasHierarchyRequest, hierarchyRequestSignal } from './HierarchyRequestCancellation';
import { sessionAutoApprovalEnabled, skillRequiresUserInput } from './SessionAutoApproval';
import { getAIToolsManager } from '../utils/ai-manager';
import { asRecord, read } from '../utils/record-utils';

export const HIERARCHY_LIST_TOOL = 'orchestrator_list_agents';
export const HIERARCHY_DISPATCH_TOOL = 'orchestrator_delegate_task';

type RoutingRole = 'orchestrator' | 'specialist' | 'worker';
type InvocationBudget = { count: number; max: number | null };
type EvidenceRef = {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  username: string;
  parentUsername: string;
  parentSessionId: string;
  profileTag: string;
  profileVersionId: number;
  model: { llmService: string; model: string };
};
type CompletedResult = {
  sessionId: string;
  username: string;
  role: string;
  model: { llmService: string; model: string };
  answer: string;
  evidenceRefs: EvidenceRef[];
  evidenceOmitted: number;
};
type HierarchyScope = {
  rootSessionId: string;
  sessionId: string;
  username: string;
  role: RoutingRole;
  ancestors: string[];
  signal?: AbortSignal;
  harness?: ReturnType<typeof compileHarness>;
  budget: InvocationBudget;
  delegationCount: number;
  spanId?: string;
  rootContext: Context;
  evidence: EvidenceRef[];
  evidenceOmitted: number;
  approvedToolCalls: Set<string>;
  completed: Map<string, CompletedResult>;
  recordedChildren: Set<string>;
  remainingDepth: number | null;
  parentScope?: HierarchyScope;
  bindingSnapshot?: {
    timeout: number;
    maxDepth: number;
    profileVersionId: number;
    model: { llmService: string; model: string };
  };
};

type HierarchyContext = Context & { action: Context['action'] };
type ToolEntry = {
  scope?: string;
  execution?: string;
  defaultPermission?: string;
  from?: string;
  definition: { name: string };
};
type Writer = (chunk: unknown) => void;

// Scope is held on the actual Context object and cannot be supplied in a tool call or HTTP body.
const scopes = new WeakMap<object, HierarchyScope>();
const pendingRootScopes = new WeakMap<object, Promise<HierarchyScope>>();

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toolName(value: unknown): string {
  const item = asRecord(value);
  return stringValue(item.name) || stringValue(asRecord(item.function).name);
}

function toolCallKey(sessionId: string, messageId: string, toolCallId: string, name: string): string {
  return JSON.stringify([sessionId, messageId, toolCallId, name]);
}

function abortError() {
  return new Error('The delegation was cancelled or timed out.');
}

async function withAbort<T>(signal: AbortSignal, run: () => T | PromiseLike<T>): Promise<T> {
  if (signal.aborted) throw abortError();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    if (signal.aborted) throw abortError();
    return await Promise.race([Promise.resolve().then(run), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function bindingLimits(binding: Model) {
  const rawDepth = read(binding, 'maxDepth');
  const rawTimeout = read(binding, 'timeout');
  const maxDepth = rawDepth == null ? 1 : Number(rawDepth);
  const timeout = rawTimeout == null ? 120000 : Number(rawTimeout);
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 10) {
    throw new Error('The delegation depth is invalid.');
  }
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000) {
    throw new Error('The delegation timeout is invalid.');
  }
  return { maxDepth, timeout };
}

class RestrictedAIEmployee extends AIEmployee {
  allowedToolNames = new Set<string>();
  autoApprovedToolNames = new Set<string>();
  recursionLimit = 200;
  guardTool?: (name: string, toolCallId: string) => Promise<void>;
  signal?: AbortSignal;

  isAutoCall(tools: Parameters<AIEmployee['isAutoCall']>[0]) {
    if (tools?.definition?.name && this.autoApprovedToolNames.has(tools.definition.name)) return true;
    return super.isAutoCall(tools);
  }

  async createAgent(options: Parameters<AIEmployee['createAgent']>[0]) {
    // The native employee retains several system tools irrespective of skillSettings.tools.
    // Filter the model-facing tools in our own child instance as well.
    const tools = options.tools?.filter((item: unknown) => this.allowedToolNames.has(toolName(item)));
    const signal = this.signal;
    const guardTool = this.guardTool;
    const guard = createMiddleware({
      name: 'HierarchyLiveAuthorization',
      wrapToolCall: async (request, handler) => {
        if (!signal || !guardTool) throw new Error('The hierarchy tool guard is unavailable.');
        await withAbort(signal, () => guardTool(request.toolCall.name, request.toolCall.id));
        return withAbort(signal, () => handler(request));
      },
      wrapModelCall: async (request, handler) => {
        if (!signal) throw new Error('The hierarchy model guard is unavailable.');
        return withAbort(signal, () => handler(request));
      },
    });
    return super.createAgent({ ...options, tools, middleware: [...(options.middleware ?? []), guard] });
  }

  async agentInvoke(...args: Parameters<AIEmployee['agentInvoke']>) {
    const [provider, context, config, state] = args;
    return super.agentInvoke(provider, context, { ...config, recursionLimit: this.recursionLimit }, state);
  }
}

export class HierarchicalAgentRuntime {
  constructor(private readonly plugin: Plugin) {}

  private get ai(): PluginAIServer {
    const ai = this.plugin.app.pm.get('ai') as PluginAIServer | undefined;
    if (!ai) throw new Error('AI Employee is unavailable.');
    return ai;
  }

  private async getScope(ctx: Context, toolCallId?: string, expectedTool?: string): Promise<HierarchyScope> {
    const userId = ctx.auth?.user?.id;
    if (!userId) throw new Error('Authentication is required.');
    const local = scopes.get(ctx);
    if (local) {
      if (local.signal?.aborted) throw new Error('The request was cancelled.');
      await this.accessibleEmployee(ctx, local.username);
      if (toolCallId) await this.assertCallingTool(ctx, local, toolCallId, expectedTool);
      if (toolCallId) await guardHierarchyEnrollment(local.rootContext, async () => undefined);
      if (local.signal?.aborted) throw new Error('The request was cancelled.');
      return local;
    }
    if (
      toolCallId &&
      (ctx.action?.resourceName !== 'aiConversations' ||
        !['sendMessages', 'resendMessages', 'resumeToolCall'].includes(ctx.action?.actionName))
    ) {
      throw new Error('Hierarchy routing is not available in this execution context.');
    }
    if (toolCallId && !hasHierarchyRequest(ctx)) {
      throw new Error('The managed request is unavailable.');
    }
    let pending = pendingRootScopes.get(ctx);
    if (!pending) {
      pending = this.createRootScope(ctx);
      pendingRootScopes.set(ctx, pending);
    }
    let scope: HierarchyScope;
    try {
      scope = await pending;
    } catch (error) {
      pendingRootScopes.delete(ctx);
      throw error;
    }
    if (scope.signal?.aborted) throw new Error('The request was cancelled.');
    if (toolCallId) {
      await this.assertCallingTool(ctx, scope, toolCallId, expectedTool);
      await guardHierarchyEnrollment(ctx, async () => undefined);
      if (scope.signal?.aborted) throw new Error('The request was cancelled.');
      scopes.set(ctx, scope);
    }
    return scope;
  }

  private async createRootScope(ctx: Context): Promise<HierarchyScope> {
    const userId = ctx.auth?.user?.id;
    const sessionId = stringValue(ctx.action?.params?.values?.sessionId);
    if (!sessionId) throw new Error('A conversation is required.');
    const conversation = await ctx.db.getRepository('aiConversations').findOne({ filter: { sessionId, userId } });
    const username = stringValue(read(conversation, 'aiEmployeeUsername'));
    if (!conversation || !username || read(conversation, 'from') === 'sub-agent') {
      throw new Error('The current conversation is unavailable.');
    }
    const requested = stringValue(ctx.action?.params?.values?.aiEmployee);
    if (requested && requested !== username) throw new Error('The employee does not match the conversation.');
    await this.accessibleEmployee(ctx, username);
    const controller = this.ai.aiEmployeesManager.conversationController.get(sessionId);
    return {
      rootSessionId: sessionId,
      sessionId,
      username,
      role: 'orchestrator',
      ancestors: [username],
      signal: hierarchyRequestSignal(ctx, controller?.signal),
      budget: { count: 0, max: null },
      delegationCount: 0,
      rootContext: ctx,
      evidence: [],
      evidenceOmitted: 0,
      approvedToolCalls: new Set(),
      completed: new Map(),
      recordedChildren: new Set(),
      remainingDepth: null,
    };
  }

  private async assertCallingTool(ctx: Context, scope: HierarchyScope, toolCallId: string, toolName?: string) {
    const toolCall = await ctx.db.getRepository('aiToolMessages').findOne({
      filter: { sessionId: scope.sessionId, toolCallId, toolName },
    });
    const messageId = read(toolCall, 'messageId');
    if (!messageId) throw new Error('The invoking tool call is unavailable.');
    const message = await ctx.db.getRepository('aiMessages').findOne({
      filter: { sessionId: scope.sessionId, messageId, role: scope.username },
    });
    if (!message) throw new Error('The invoking employee could not be verified.');
    return String(messageId);
  }

  private async accessibleEmployee(ctx: Context, username: string): Promise<Model> {
    const filter: Record<string, unknown> = { username, enabled: true, category: 'business', deprecated: false };
    const roles = await this.currentRoles(ctx);
    if (!roles.includes('root')) {
      const mappings = await ctx.db.getRepository('rolesAiEmployees').find({ filter: { roleName: roles } });
      if (!mappings.some((row: Model) => read(row, 'aiEmployee') === username)) {
        throw new Error('The requested AI employee is unavailable.');
      }
    }
    const employee = await ctx.db.getRepository('aiEmployees').findOne({ filter });
    if (!employee) throw new Error('The requested AI employee is unavailable.');
    return employee;
  }

  private async currentRoles(ctx: Context): Promise<string[]> {
    const requestedRoles = ctx.state.currentRoles;
    if (!Array.isArray(requestedRoles)) throw new Error('Current roles are unavailable.');
    const memberships = await ctx.db.getRepository('rolesUsers').find({ filter: { userId: ctx.auth?.user?.id } });
    const currentRoles = new Set(memberships.map((row: Model) => read(row, 'roleName')));
    const roles = requestedRoles.filter((role: string) => currentRoles.has(role));
    if (!roles.length) throw new Error('The requested AI employee is unavailable.');
    const selectedRole = ctx.state.currentRole;
    if (typeof selectedRole === 'string' && selectedRole !== '__union__' && !roles.includes(selectedRole)) {
      throw new Error('The selected role is no longer available.');
    }
    return roles;
  }

  private async authorizeTool(ctx: Context, scope: HierarchyScope, name: string, toolCallId: string) {
    if (scope.signal?.aborted) throw abortError();
    const messageId = await this.assertCallingTool(ctx, scope, toolCallId, name);
    await guardHierarchyEnrollment(scope.rootContext, async () => undefined);
    for (const ancestor of scope.ancestors) await this.accessibleEmployee(ctx, ancestor);
    let current: HierarchyScope | undefined = scope;
    while (current?.parentScope && current.bindingSnapshot) {
      const target = await this.resolveTarget(scope.rootContext, current.parentScope, current.username);
      const snapshot = current.bindingSnapshot;
      if (
        target.profile.id !== snapshot.profileVersionId ||
        !isDeepStrictEqual(target.model, snapshot.model) ||
        !isDeepStrictEqual(target.bindingLimits, { timeout: snapshot.timeout, maxDepth: snapshot.maxDepth })
      )
        throw new Error('The delegation policy changed while the request was running.');
      current = current.parentScope;
    }
    const employee = await this.accessibleEmployee(ctx, scope.username);
    const settings = asRecord(read(employee, 'skillSettings'));
    const originalTools = Array.isArray(settings.tools) ? settings.tools : [];
    if (!scope.harness) throw new Error('The delegation policy is unavailable.');
    const autoApprove = await sessionAutoApprovalEnabled(ctx, scope.rootSessionId);
    const approvalRequired = new Set<string>();
    const allowed = await this.allowedTools(
      ctx,
      scope.sessionId,
      scope.role,
      originalTools,
      scope.harness,
      autoApprove,
      approvalRequired,
    );
    if (!allowed.includes(name)) throw new Error('The requested tool is no longer permitted.');
    const roles = await this.currentRoles(ctx);
    if (scope.signal?.aborted) throw abortError();
    ctx.state = { ...ctx.state, currentRoles: roles };
    if (scope.role === 'worker' && autoApprove && approvalRequired.has(name)) {
      scope.approvedToolCalls.add(toolCallKey(scope.sessionId, messageId, toolCallId, name));
    }
  }

  private async bindings(ctx: Context, scope: HierarchyScope) {
    if (scope.role === 'worker') return [];
    if (scope.remainingDepth === 0) return [];
    if (scope.harness?.delegation.maxDepth === 0) return [];
    const expectedRole = scope.role === 'orchestrator' ? 'specialist' : 'worker';
    return ctx.db.getRepository('orchestratorConfig').find({
      filter: { leaderUsername: scope.username, routingEnabled: true, enabled: true, routingRole: expectedRole },
      sort: ['subAgentUsername'],
    });
  }

  async list(ctx: Context, toolCallId?: string) {
    const scope = await this.getScope(ctx, toolCallId, HIERARCHY_LIST_TOOL);
    const result: Array<{ username: string; description: string; role: string }> = [];
    for (const binding of await this.bindings(ctx, scope)) {
      const username = stringValue(read(binding, 'subAgentUsername'));
      if (!username || scope.ancestors.includes(username)) continue;
      const allowed = scope.harness?.delegation.allowedEmployees ?? [];
      if (allowed.length && !allowed.includes(username)) continue;
      try {
        await this.accessibleEmployee(ctx, username);
        result.push({
          username,
          description: stringValue(read(binding, 'routingPrompt')),
          role: stringValue(read(binding, 'routingRole')),
        });
      } catch {
        // An inaccessible employee is neither listed nor usable.
      }
    }
    if (scope.signal?.aborted) throw abortError();
    return result;
  }

  private async resolveTarget(ctx: Context, scope: HierarchyScope, username: string) {
    if (!username || scope.ancestors.includes(username)) throw new Error('Invalid delegation request.');
    const allowed = scope.harness?.delegation.allowedEmployees ?? [];
    if (allowed.length && !allowed.includes(username)) throw new Error('The requested delegation is unavailable.');
    const binding = (await this.bindings(ctx, scope)).find((row: Model) => read(row, 'subAgentUsername') === username);
    if (!binding) throw new Error('The requested delegation is unavailable.');
    const employee = await this.accessibleEmployee(ctx, username);
    const role = stringValue(read(binding, 'routingRole')) as RoutingRole;
    const limits = bindingLimits(binding);
    const profileTag = stringValue(read(binding, 'harnessTag')) || 'default';
    const profile = await new HarnessProfileService(ctx.db).getPublishedByTag(profileTag);
    if (!profile) throw new Error('The delegation policy profile is unavailable.');
    const harness = compileHarness([{ source: `${profileTag}@${profile.version}`, settings: profile.settings }]);
    if (
      harness.limits.maxToolCalls != null ||
      harness.limits.maxInputTokens != null ||
      harness.limits.maxOutputTokens != null ||
      harness.limits.maxTotalTokens != null ||
      harness.limits.maxCost != null ||
      harness.isolation.requireWorktree ||
      harness.isolation.mode === 'worktree'
    ) {
      throw new Error('This delegation policy contains limits or isolation not supported by the chat runtime.');
    }
    const modelService = stringValue(read(binding, 'llmService'));
    const modelName = stringValue(read(binding, 'model'));
    if (Boolean(modelService) !== Boolean(modelName)) throw new Error('The delegation model is incomplete.');
    const override = modelService && modelName ? { llmService: modelService, model: modelName } : undefined;
    const routing = profile.settings.routing?.models;
    const primary = override || routing?.primary || (await this.ai.aiEmployeesManager.resolveModel(employee));
    const candidates = [primary, ...(routing?.fallback ?? [])];
    const services = await this.ai.aiManager.listAllEnabledModels();
    const seen = new Set<string>();
    for (const [index, option] of candidates.entries()) {
      if (
        typeof option.llmService !== 'string' ||
        !option.llmService ||
        typeof option.model !== 'string' ||
        !option.model
      ) {
        continue;
      }
      const candidate = { llmService: option.llmService, model: option.model };
      const key = `${candidate.llmService}\u0000${candidate.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = await this.ai.aiEmployeesManager.resolveModel(employee, candidate);
      if (resolved.llmService !== candidate.llmService || resolved.model !== candidate.model) {
        throw new Error('The delegation model is not enabled for this employee.');
      }
      const service = services.find(
        (item) =>
          item.llmService === candidate.llmService && item.enabledModels.some((m) => m.value === candidate.model),
      );
      if (!service) continue;
      const attribution = await authorizeDelegatedEmployee(ctx, employee, candidate);
      return {
        binding,
        bindingLimits: limits,
        employee,
        role,
        profile,
        profileTag,
        harness,
        model: candidate,
        attribution,
        provider: service.provider,
        fallback: index > 0,
      };
    }
    throw new Error('The delegation model is unavailable.');
  }

  async preview(ctx: Context, username: string, specialistUsername?: string) {
    const scope = await this.getScope(ctx);
    const rootCtx = Object.create(ctx) as HierarchyContext;
    const action = Object.create(ctx.action) as Context['action'];
    action.resourceName = 'aiConversations';
    action.actionName = 'sendMessages';
    action.params = { ...ctx.action.params, values: { ...ctx.action.params.values, aiEmployee: scope.username } };
    rootCtx.action = action;
    await guardHierarchyEnrollment(rootCtx, async () => undefined);
    const checkInvocation = (parent: HierarchyScope, harness: ReturnType<typeof compileHarness>) => {
      const maxChildren = parent.harness?.delegation.maxCount;
      if (maxChildren != null && parent.delegationCount >= maxChildren) {
        throw new Error('The delegation limit has been reached.');
      }
      const limits = [parent.budget.max, harness.limits.maxInvocations].filter(
        (limit): limit is number => limit != null,
      );
      if (limits.length && parent.budget.count >= Math.min(...limits)) {
        throw new Error('The delegation limit has been reached.');
      }
    };
    const checkSpecialistTools = async (employee: Model, harness: ReturnType<typeof compileHarness>) => {
      const settings = asRecord(read(employee, 'skillSettings'));
      const configured = Array.isArray(settings.tools) ? settings.tools : [];
      const autoApprove = await sessionAutoApprovalEnabled(ctx, scope.rootSessionId);
      const allowed = await this.allowedTools(rootCtx, scope.sessionId, 'specialist', configured, harness, autoApprove);
      if (!allowed.includes(HIERARCHY_LIST_TOOL) || !allowed.includes(HIERARCHY_DISPATCH_TOOL)) {
        throw new Error('The delegation profile does not provide the required allowed tools.');
      }
    };
    let parentScope = scope;
    let specialist:
      | {
          username: string;
          model: { llmService: string; model: string };
          fallback: boolean;
          profile: { tag: string; version: number };
        }
      | undefined;
    if (specialistUsername) {
      const selected = stringValue(specialistUsername);
      const parent = await this.resolveTarget(ctx, scope, selected);
      if (parent.role !== 'specialist') throw new Error('The intermediate employee is not a specialist.');
      checkInvocation(scope, parent.harness);
      await checkSpecialistTools(parent.employee, parent.harness);
      parentScope = {
        ...scope,
        username: selected,
        role: 'specialist',
        ancestors: [...scope.ancestors, selected],
        harness: parent.harness,
        budget: { count: 1, max: parent.harness.limits.maxInvocations },
        delegationCount: 0,
        remainingDepth: parent.bindingLimits.maxDepth - 1,
        parentScope: scope,
      };
      specialist = {
        username: selected,
        model: parent.model,
        fallback: parent.fallback,
        profile: { tag: parent.profileTag, version: parent.profile.version },
      };
    }
    const resolved = await this.resolveTarget(ctx, parentScope, stringValue(username));
    checkInvocation(parentScope, resolved.harness);
    if (resolved.role === 'specialist') await checkSpecialistTools(resolved.employee, resolved.harness);
    return {
      username,
      role: resolved.role,
      model: resolved.model,
      fallback: resolved.fallback,
      profile: { tag: resolved.profileTag, version: resolved.profile.version },
      ...(specialist ? { specialist } : {}),
    };
  }

  private async readEvidence(ctx: Context, rootSessionId: string, refs: EvidenceRef[], approvedToolCalls: Set<string>) {
    const evidence: Array<Record<string, unknown>> = [];
    let remaining = 12000;
    let omitted = 0;
    for (const ref of refs) {
      if (evidence.length >= 10 || remaining <= 0) {
        omitted += 1;
        continue;
      }
      const userId = ctx.auth?.user?.id;
      const parent = await ctx.db.getRepository('aiConversations').findOne({
        filter: { sessionId: ref.parentSessionId, userId, aiEmployeeUsername: ref.parentUsername },
      });
      const conversation = await ctx.db.getRepository('aiConversations').findOne({
        filter: { sessionId: ref.sessionId, userId, aiEmployeeUsername: ref.username, from: 'sub-agent' },
      });
      const options = asRecord(read(conversation, 'options'));
      if (
        !parent ||
        !conversation ||
        options.hierarchyRootSessionId !== rootSessionId ||
        options.hierarchyParentSessionId !== ref.parentSessionId
      )
        throw new Error('The evidence conversation is unavailable.');
      await this.accessibleEmployee(ctx, ref.parentUsername);
      const worker = await this.accessibleEmployee(ctx, ref.username);
      const binding = await ctx.db.getRepository('orchestratorConfig').findOne({
        filter: {
          leaderUsername: ref.parentUsername,
          subAgentUsername: ref.username,
          routingRole: 'worker',
          routingEnabled: true,
          enabled: true,
        },
      });
      if (!binding || (stringValue(read(binding, 'harnessTag')) || 'default') !== ref.profileTag) {
        throw new Error('The evidence delegation is unavailable.');
      }
      const profile = await new HarnessProfileService(ctx.db).getPublishedByTag(ref.profileTag);
      if (!profile || profile.id !== ref.profileVersionId) throw new Error('The evidence policy changed.');
      const harness = compileHarness([{ source: ref.profileTag, settings: profile.settings }]);
      const settings = asRecord(read(worker, 'skillSettings'));
      const originalTools = Array.isArray(settings.tools) ? settings.tools : [];
      const workerCtx = Object.create(ctx) as HierarchyContext;
      const action = Object.create(ctx.action) as Context['action'];
      action.params = {
        ...ctx.action.params,
        values: { ...ctx.action.params.values, sessionId: ref.sessionId, aiEmployee: ref.username, model: ref.model },
      };
      workerCtx.action = action;
      workerCtx.state = { ...ctx.state, currentAIEmployee: { username: ref.username } };
      const autoApprove =
        (await sessionAutoApprovalEnabled(ctx, rootSessionId)) ||
        approvedToolCalls.has(toolCallKey(ref.sessionId, ref.messageId, ref.toolCallId, ref.toolName));
      const allowed = await this.allowedTools(workerCtx, ref.sessionId, 'worker', originalTools, harness, autoApprove);
      if (!allowed.includes(ref.toolName)) throw new Error('The evidence tool is no longer permitted.');
      await authorizeDelegatedEmployee(ctx, worker, ref.model);
      const message = await ctx.db.getRepository('aiMessages').findOne({
        filter: { sessionId: ref.sessionId, messageId: ref.messageId, role: ref.username },
      });
      const tool = await ctx.db.getRepository('aiToolMessages').findOne({
        filter: {
          sessionId: ref.sessionId,
          messageId: ref.messageId,
          toolCallId: ref.toolCallId,
          toolName: ref.toolName,
          status: 'success',
        },
      });
      if (!message || !tool || !['done', 'confirmed'].includes(String(read(tool, 'invokeStatus')))) {
        throw new Error('The evidence is unavailable.');
      }
      const content = read(tool, 'content');
      const raw = typeof content === 'string' ? content : JSON.stringify(content ?? null);
      const bytes = Buffer.from(raw, 'utf8');
      const allowedBytes = Math.min(2000, remaining);
      const excerpt = bytes.subarray(0, allowedBytes).toString('utf8');
      remaining -= Math.min(bytes.length, allowedBytes);
      evidence.push({
        sessionId: ref.sessionId,
        messageId: ref.messageId,
        toolCallId: ref.toolCallId,
        toolName: ref.toolName,
        excerpt,
        truncated: bytes.length > allowedBytes,
      });
    }
    return { items: evidence, omitted };
  }

  async dispatch(
    ctx: Context,
    input: { username: string; question: string },
    runtime: { toolCallId: string; writer?: Writer },
  ) {
    const dispatchStartedAt = Date.now();
    if (!runtime?.toolCallId) throw new Error('The invoking tool call is required.');
    const scope = await this.getScope(ctx, runtime.toolCallId, HIERARCHY_DISPATCH_TOOL);
    const username = stringValue(input.username);
    const question = stringValue(input.question);
    if (!question || question.length > 50000) throw new Error('Invalid delegation request.');
    const {
      employee,
      role,
      harness,
      model,
      attribution,
      profile,
      profileTag,
      provider,
      fallback,
      bindingLimits: limitsForBinding,
    } = await this.resolveTarget(ctx, scope, username);
    if (scope.signal?.aborted) throw new Error('The request was cancelled.');
    if (Date.now() - dispatchStartedAt >= Math.min(limitsForBinding.timeout, harness.limits.timeoutMs ?? 120000)) {
      throw abortError();
    }
    if (role !== 'specialist' && role !== 'worker') throw new Error('Invalid delegation role.');
    const journal = new HierarchyInvocationJournal(ctx.db);
    const key = {
      ownerId: attribution.userId,
      parentSessionId: scope.sessionId,
      parentToolCallId: runtime.toolCallId,
    };
    const snapshot = {
      profileTag,
      profileVersion: profile.version,
      profileVersionId: profile.id,
      policy: profile.settings,
      model,
      provider,
      ancestors: [...scope.ancestors],
      bindingTimeout: limitsForBinding.timeout,
      bindingMaxDepth: limitsForBinding.maxDepth,
    };
    const stored = await journal.reserve({
      ...key,
      rootSessionId: scope.rootSessionId,
      parentEmployee: scope.username,
      employeeUsername: username,
      role,
      question,
      snapshot,
    });
    if (scope.signal?.aborted) throw abortError();
    if (!isDeepStrictEqual(read(stored, 'snapshot'), snapshot)) {
      throw new Error('The delegation policy changed after the request was created.');
    }
    if (read(stored, 'status') === 'succeeded') {
      const saved = asRecord(read(stored, 'result'));
      const childSessionId = stringValue(saved.sessionId);
      if (
        childSessionId !== read(stored, 'childSessionId') ||
        saved.username !== username ||
        saved.role !== role ||
        !isDeepStrictEqual(saved.model, model)
      ) {
        throw new Error('The stored delegation result is invalid.');
      }
      for (const ancestor of scope.ancestors) await this.accessibleEmployee(ctx, ancestor);
      await guardHierarchyEnrollment(scope.rootContext, async () => undefined);
      // The tool contract has no general way to reauthorize the source records of
      // an old answer. A later request receives only a completion status.
      const cached = scope.completed.get(runtime.toolCallId);
      if (!cached) return { status: 'already_completed', sessionId: childSessionId };
      const { answer, evidenceRefs, evidenceOmitted } = cached;
      const evidence = await this.readEvidence(ctx, scope.rootSessionId, evidenceRefs, scope.approvedToolCalls);
      if (scope.signal?.aborted) throw abortError();
      this.recordEvidence(scope, runtime.toolCallId, evidenceRefs, evidenceOmitted);
      return {
        sessionId: childSessionId,
        username,
        role,
        model: saved.model,
        answer,
        evidence: { ...evidence, omitted: evidence.omitted + evidenceOmitted },
      };
    }
    if (read(stored, 'status') !== 'reserved') {
      throw new Error('The delegation has an unfinished or uncertain outcome and cannot be replayed.');
    }
    const maxChildren = scope.harness?.delegation.maxCount;
    if (maxChildren != null && scope.delegationCount >= maxChildren) {
      throw new Error('The delegation limit has been reached.');
    }
    const limits = [scope.budget.max, harness.limits.maxInvocations].filter((limit): limit is number => limit != null);
    const max = limits.length ? Math.min(...limits) : null;
    if (max != null && scope.budget.count >= max) throw new Error('The delegation limit has been reached.');
    scope.budget.max = max;
    scope.budget.count += 1;
    scope.delegationCount += 1;
    const { token } = await journal.claim(key);
    if (scope.signal?.aborted) {
      await journal.markUncertain(key, token);
      throw abortError();
    }
    const startedAt = Date.now();
    const trace = new ExecutionSpanService(this.plugin);
    const span =
      harness.observability.enabled && harness.observability.sharing !== 'disabled'
        ? await trace.create({
            rootRunId: `hierarchy:${scope.rootSessionId}`,
            parentSpanId: scope.spanId,
            depth: scope.ancestors.length,
            source: 'hierarchy',
            parentSessionId: scope.sessionId,
            toolCallId: runtime.toolCallId,
            type: 'sub_agent',
            status: 'running',
            leaderUsername: scope.username,
            employeeUsername: username,
            toolName: HIERARCHY_DISPATCH_TOOL,
            userId: attribution.userId,
            metadata: { model, provider, fallback, profileTag, profileVersion: profile.version },
          })
        : null;
    const spanId = span && (typeof span.id === 'number' || typeof span.id === 'string') ? String(span.id) : undefined;

    let invocationSignal: AbortSignal | undefined;
    try {
      if (scope.signal?.aborted) throw abortError();
      const conversation = await this.ai.aiConversationsManager.create({
        userId: ctx.auth.user.id,
        aiEmployee: { username },
        title: question.slice(0, 30),
        from: 'sub-agent',
        options: { hierarchyRootSessionId: scope.rootSessionId, hierarchyParentSessionId: scope.sessionId },
      });
      const sessionId = stringValue(read(conversation, 'sessionId'));
      if (!sessionId) throw new Error('The delegated conversation could not be created.');
      await journal.attachChild(key, token, sessionId);

      const child = Object.create(ctx) as HierarchyContext;
      const action = Object.create(ctx.action) as Context['action'];
      action.resourceName = 'aiConversations';
      action.actionName = 'sendMessages';
      action.params = {
        ...ctx.action.params,
        values: { ...ctx.action.params.values, sessionId, aiEmployee: username, model },
      };
      child.action = action;
      child.state = { ...ctx.state, currentAIEmployee: { username } };
      const controller = new AbortController();
      invocationSignal = controller.signal;
      const abort = () => controller.abort();
      scope.signal?.addEventListener('abort', abort, { once: true });
      if (scope.signal?.aborted) controller.abort();
      const timeoutMs = Math.min(limitsForBinding.timeout, harness.limits.timeoutMs ?? 120000);
      const remaining = timeoutMs - (Date.now() - dispatchStartedAt);
      if (remaining <= 0) controller.abort();
      const timeout = setTimeout(abort, Math.max(0, remaining));
      const childScope: HierarchyScope = {
        rootSessionId: scope.rootSessionId,
        sessionId,
        username,
        role,
        ancestors: [...scope.ancestors, username],
        signal: controller.signal,
        harness,
        budget: scope.budget,
        delegationCount: 0,
        spanId,
        rootContext: scope.rootContext,
        evidence: [],
        evidenceOmitted: 0,
        approvedToolCalls: scope.approvedToolCalls,
        completed: new Map(),
        recordedChildren: new Set(),
        remainingDepth: Math.min(
          limitsForBinding.maxDepth - 1,
          scope.remainingDepth == null ? limitsForBinding.maxDepth - 1 : Math.max(0, scope.remainingDepth - 1),
        ),
        parentScope: scope,
        bindingSnapshot: { ...limitsForBinding, profileVersionId: profile.id, model },
      };
      scopes.set(child, childScope);
      try {
        const execute = async () => {
          const originalSettings = asRecord(read(employee, 'skillSettings'));
          const originalTools = Array.isArray(originalSettings.tools) ? originalSettings.tools : [];
          const autoApprove = await sessionAutoApprovalEnabled(child, scope.rootSessionId);
          const tools = await this.allowedTools(child, sessionId, role, originalTools, harness, autoApprove);
          if (
            (role === 'specialist' &&
              (!tools.includes(HIERARCHY_LIST_TOOL) || !tools.includes(HIERARCHY_DISPATCH_TOOL))) ||
            (role === 'worker' && tools.length === 0)
          ) {
            throw new Error('The delegation profile does not provide the required allowed tools.');
          }
          employee.set('skillSettings', {
            ...originalSettings,
            tools: tools.map((name) => ({ name, autoCall: true })),
          });
          employee.set('chatSettings', { ...asRecord(read(employee, 'chatSettings')), enableSkills: false });
          employee.set('enableKnowledgeBase', false);
          const agent = new RestrictedAIEmployee({
            ctx: child,
            employee,
            sessionId,
            model,
            webSearch: false,
            skillSettings: { skillsVersion: 2, toolsVersion: 2, skills: [], tools },
            // A dedicated checkpoint lets us detect interruptions without passing them off as results.
            from: 'main-agent',
          });
          agent.allowedToolNames = new Set(tools);
          if (autoApprove) agent.autoApprovedToolNames = new Set(tools);
          agent.recursionLimit = harness.limits.recursionLimit ?? 200;
          agent.signal = controller.signal;
          agent.guardTool = async (name, toolCallId) => this.authorizeTool(child, childScope, name, toolCallId);
          const writer = runtime.writer
            ? (chunk: unknown) => {
                if (controller.signal.aborted) return;
                const event = asRecord(chunk);
                const current = asRecord(event.currentConversation);
                runtime.writer?.({
                  ...event,
                  currentConversation: Object.keys(current).length ? { ...current, from: 'sub-agent' } : current,
                });
              }
            : undefined;
          const result = (await agent.invoke({
            userMessages: [{ role: 'user', content: { type: 'text', content: question } }],
            signal: controller.signal,
            writer,
          })) as { messages?: Array<{ content?: unknown }>; __interrupt__?: unknown };
          if (controller.signal.aborted) throw new Error('The delegation was cancelled.');
          if (
            result.__interrupt__ != null &&
            (!Array.isArray(result.__interrupt__) || result.__interrupt__.length > 0)
          ) {
            throw new Error('A delegated tool requires approval and cannot be completed here.');
          }
          const content = result.messages?.at(-1)?.content;
          const answer =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content.map((part) => stringValue(asRecord(part).text)).join('')
                : '';
          if (!answer) throw new Error('The delegated employee returned no answer.');
          const message = await ctx.db.getRepository('aiMessages').findOne({
            filter: { sessionId, role: username },
            sort: ['-messageId'],
          });
          const messageId = stringValue(String(read(message, 'messageId') || ''));
          const persistedAnswer = stringValue(asRecord(read(message, 'content')).content);
          if (!messageId || !persistedAnswer || persistedAnswer !== answer.trim()) {
            throw new Error('The delegated answer could not be persisted.');
          }
          for (const ancestor of scope.ancestors) await this.accessibleEmployee(ctx, ancestor);
          await guardHierarchyEnrollment(scope.rootContext, async () => undefined);
          const current = await this.resolveTarget(ctx, scope, username);
          if (
            current.profile.id !== profile.id ||
            current.profile.version !== profile.version ||
            !isDeepStrictEqual(current.model, model)
          ) {
            throw new Error('The delegation policy changed while the request was running.');
          }
          if (role === 'worker') {
            const toolRepo = ctx.db.getRepository('aiToolMessages');
            const filter = { sessionId, status: 'success', invokeStatus: { $in: ['done', 'confirmed'] } };
            const [calls, count] = await Promise.all([
              toolRepo.find({ filter, sort: ['id'], limit: 10 }),
              toolRepo.count({ filter }),
            ]);
            childScope.evidenceOmitted += Math.max(0, count - calls.length);
            for (const call of calls as Model[]) {
              const name = stringValue(read(call, 'toolName'));
              if (!tools.includes(name)) throw new Error('An unapproved evidence tool was recorded.');
              childScope.evidence.push({
                sessionId,
                messageId: String(read(call, 'messageId') || ''),
                toolCallId: stringValue(read(call, 'toolCallId')),
                toolName: name,
                username,
                parentUsername: scope.username,
                parentSessionId: scope.sessionId,
                profileTag,
                profileVersionId: profile.id,
                model,
              });
            }
          }
          const evidenceRefs = childScope.evidence.slice(0, 10);
          const evidenceOmitted =
            childScope.evidenceOmitted + Math.max(0, childScope.evidence.length - evidenceRefs.length);
          const evidence = await this.readEvidence(ctx, scope.rootSessionId, evidenceRefs, scope.approvedToolCalls);
          if (controller.signal.aborted) throw abortError();
          await journal.complete(
            key,
            token,
            { sessionId, username, role, model, messageId, evidenceRefs, evidenceOmitted },
            controller.signal,
          );
          if (controller.signal.aborted) throw abortError();
          scope.completed.set(runtime.toolCallId, {
            sessionId,
            username,
            role,
            model,
            answer: persistedAnswer,
            evidenceRefs,
            evidenceOmitted,
          });
          this.recordEvidence(scope, runtime.toolCallId, evidenceRefs, evidenceOmitted);
          await trace.finish(spanId, 'success', startedAt, { subSessionId: sessionId });
          return {
            sessionId,
            username,
            role,
            model,
            answer: persistedAnswer,
            evidence: { ...evidence, omitted: evidence.omitted + evidenceOmitted },
          };
        };
        await authorizeDelegatedEmployee(child, employee, model);
        return await withAbort(controller.signal, () =>
          runWithNativeUsageAttribution(
            {
              db: child.db,
              userId: attribution.userId,
              sessionId,
              ...(attribution.departmentId == null ? {} : { departmentId: attribution.departmentId }),
            },
            execute,
          ),
        );
      } finally {
        clearTimeout(timeout);
        scope.signal?.removeEventListener('abort', abort);
        scopes.delete(child);
      }
    } catch (error) {
      await journal.markUncertain(key, token).catch(() => undefined);
      if (invocationSignal?.aborted) await journal.invalidateCompleted(key);
      await trace.finish(spanId, scope.signal?.aborted ? 'canceled' : 'error', startedAt);
      throw error;
    }
  }

  private async allowedTools(
    ctx: Context,
    sessionId: string,
    role: RoutingRole,
    originalTools: unknown[],
    harness: ReturnType<typeof compileHarness>,
    autoApprove = false,
    approvalRequired?: Set<string>,
  ): Promise<string[]> {
    const manager = getAIToolsManager(this.plugin.app);
    const configured = new Map(originalTools.map((item) => [stringValue(asRecord(item).name), asRecord(item)]));
    const candidates =
      role === 'specialist'
        ? [HIERARCHY_LIST_TOOL, HIERARCHY_DISPATCH_TOOL]
        : [...new Set([...harness.tools.allow, ...(autoApprove ? harness.tools.ask : [])])];
    const result: string[] = [];
    for (const name of candidates) {
      if (!name) continue;
      if (role === 'specialist' && !harness.tools.allow.includes(name) && !harness.tools.ask.includes(name)) continue;
      const decision = decideTool(harness, name, 'read');
      if (decision === 'deny' || (decision === 'ask' && !autoApprove)) continue;
      if (role === 'worker' && harness.tools.effects[name] !== 'read') continue;
      if (role === 'worker' && listSystemTools().includes(name)) continue;
      if (role === 'worker' && [HIERARCHY_LIST_TOOL, HIERARCHY_DISPATCH_TOOL, 'dispatch-sub-agent-task'].includes(name))
        continue;
      const entry = (await manager.getTools(name, { ctx, sessionId })) as ToolEntry | undefined;
      if (!entry || entry.execution === 'frontend') continue;
      const requiresApproval =
        decision === 'ask' || entry.defaultPermission !== 'ALLOW' || configured.get(name)?.autoCall === false;
      if (requiresApproval && (!autoApprove || entry.from === 'mcp')) continue;
      if (requiresApproval && (await skillRequiresUserInput(ctx, name, {}))) continue;
      if (role === 'worker' && entry.scope !== 'GENERAL' && !configured.has(name)) continue;
      if (requiresApproval) approvalRequired?.add(name);
      result.push(name);
    }
    return result;
  }

  private recordEvidence(scope: HierarchyScope, toolCallId: string, refs: EvidenceRef[], omitted: number) {
    if (scope.recordedChildren.has(toolCallId)) return;
    scope.recordedChildren.add(toolCallId);
    scope.evidence.push(...refs);
    scope.evidenceOmitted += omitted;
  }
}

export function createHierarchicalAgentTools(plugin: Plugin) {
  const service = new HierarchicalAgentRuntime(plugin);
  return [
    {
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ALLOW' as const,
      introduction: { title: '{{t("List delegated AI employees", { ns: "plugin-agent-orchestrator" })}}' },
      definition: {
        name: HIERARCHY_LIST_TOOL,
        description: 'List AI employees available for delegation in the current conversation.',
        schema: z.object({}),
      },
      invoke: async (ctx: Context, _input: unknown, runtime: { toolCallId: string }) => {
        if (!runtime?.toolCallId) throw new Error('The invoking tool call is required.');
        return service.list(ctx, runtime.toolCallId);
      },
    },
    {
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ALLOW' as const,
      introduction: { title: '{{t("Delegate to an AI employee", { ns: "plugin-agent-orchestrator" })}}' },
      definition: {
        name: HIERARCHY_DISPATCH_TOOL,
        description:
          'Delegate one bounded task to an available AI employee. Use orchestrator_list_agents to discover candidates.',
        schema: z.object({
          username: z.string().min(1).max(200),
          question: z.string().min(1).max(50000),
        }),
      },
      invoke: async (
        ctx: Context,
        input: { username: string; question: string },
        runtime: { toolCallId: string; writer?: Writer },
      ) => service.dispatch(ctx, input, runtime),
    },
  ];
}
