import { AgentRegistryService } from './AgentRegistryService';
import { AgentPlannerService } from './AgentPlannerService';
import { AgentPlanValidator } from './AgentPlanValidator';
import { AgentLoopRepository } from './AgentLoopRepository';
import { AgentHarness } from './AgentHarness';
import { AgentLoopPolicy, AgentLoopPlanStepInput, AgentLoopRunStatus, AgentLoopStepStatus } from './AgentLoopService';
import { createHash } from 'crypto';

const DEFAULT_POLICY: AgentLoopPolicy = {
  maxIterations: 20,
  maxStepAttempts: 2,
  allowReplan: true,
  requireVerification: true,
  stopOnApprovalRequired: true,
};

const TERMINAL_RUN_STATUSES = new Set<AgentLoopRunStatus>(['succeeded', 'failed', 'rejected', 'canceled']);
const TERMINAL_STEP_STATUSES = new Set<AgentLoopStepStatus>(['succeeded', 'skipped']);
const ORCHESTRATOR_CONTROLLER_MAX_STEPS = 100;

function now() {
  return new Date();
}

function createRootRunId(seed = '') {
  const hash = createHash('sha1').update(`${Date.now()}::${Math.random()}::${seed}`).digest('hex').slice(0, 10);
  return `loop_${Date.now()}_${hash}`;
}

function normalizePolicy(policy?: Partial<AgentLoopPolicy>): AgentLoopPolicy {
  const next = { ...DEFAULT_POLICY, ...(policy || {}) };
  next.maxIterations = Math.max(1, Number(next.maxIterations || DEFAULT_POLICY.maxIterations));
  next.maxStepAttempts = Math.max(1, Number(next.maxStepAttempts || DEFAULT_POLICY.maxStepAttempts));
  next.allowReplan = next.allowReplan !== false;
  next.requireVerification = next.requireVerification !== false;
  next.stopOnApprovalRequired = next.stopOnApprovalRequired !== false;
  return next;
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function trimText(value: any, max = 50000) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value != null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function normalizeStepType(value: any) {
  return ['reasoning', 'skill', 'tool', 'sub_agent', 'verification'].includes(value) ? value : 'tool';
}

function normalizePlanKey(step: AgentLoopPlanStepInput, index: number) {
  return String(step.planKey || step.key || step.id || `step_${index + 1}`);
}

export class AgentLoopController {
  constructor(
    private readonly registryService: AgentRegistryService,
    private readonly plannerService: AgentPlannerService,
    private readonly validator: AgentPlanValidator,
    private readonly repository: AgentLoopRepository,
    private readonly harness: AgentHarness
  ) {}

  async createRun(options: {
    goal: string;
    leaderUsername?: string;
    sessionId?: string;
    messageId?: string;
    userId?: string | number;
    policy?: Partial<AgentLoopPolicy>;
    metadata?: any;
    plan?: AgentLoopPlanStepInput[];
  }) {
    const goal = String(options.goal || '').trim();
    if (!goal) {
      throw new Error('Agent loop goal is required.');
    }

    const policy = normalizePolicy(options.policy);
    const rootRunId = createRootRunId(options.leaderUsername || goal);
    const run = await this.repository.createRun({
      rootRunId,
      sessionId: options.sessionId,
      messageId: options.messageId,
      leaderUsername: options.leaderUsername,
      goal,
      status: 'planning',
      policy,
      iterationCount: 0,
      metadata: options.metadata || {},
      userId: options.userId,
      startedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      type: 'created',
      title: 'Agent loop created',
      content: goal,
      status: 'planning',
      userId: options.userId,
      payload: { rootRunId },
    });

    if (Array.isArray(options.plan) && options.plan.length > 0) {
      this.validator.validate(options.plan);
      await this.replacePlan(run.id, options.plan, {
        userId: options.userId,
        mode: 'append',
        markRunning: true,
      });
    }

    return this.getRunSnapshot(run.id);
  }

  async planGoal(options: {
    goal: string;
    leaderUsername?: string;
    sessionId?: string;
    messageId?: string;
    userId?: string | number;
    policy?: Partial<AgentLoopPolicy>;
    metadata?: any;
    plan?: AgentLoopPlanStepInput[];
    planSource?: string;
    plannerModel?: string;
    harnessTag?: string;
    targetAgent?: string;
    runId?: string | number;
  }) {
    const plan = this.plannerService.buildPlan(options.goal, options.plan, options);
    this.validator.validate(plan);

    const harnessTag = String(options.harnessTag || options.metadata?.harnessTag || 'default').trim() || 'default';
    const harnessProfile = await this.registryService.getHarnessProfile(harnessTag);
    const harnessSettings = asObject(harnessProfile?.settings);

    if (options.runId) {
      return this.revisePlanGoal(options.runId, plan, {
        goal: options.goal,
        userId: options.userId,
        metadata: options.metadata,
        planSource: options.planSource || (Array.isArray(options.plan) && options.plan.length ? 'provided' : 'template'),
        plannerModel: options.plannerModel,
        harnessTag,
        harnessProfileId: harnessProfile?.id,
        harnessSettings,
      });
    }

    const snapshot = await this.createRun({
      goal: options.goal,
      leaderUsername: options.leaderUsername,
      sessionId: options.sessionId,
      messageId: options.messageId,
      userId: options.userId,
      policy: options.policy,
      metadata: {
        ...asObject(options.metadata),
        harnessTag,
        harnessProfileId: harnessProfile?.id,
        harnessSettings,
        approvalMode: 'plan_first',
      },
      plan: [],
    });

    const runId = snapshot.run.id;
    await this.replacePlan(runId, plan, {
      userId: options.userId,
      mode: 'append',
      markRunning: false,
    });

    await this.repository.updateRun(runId, {
      status: 'waiting_plan_approval',
      approvalStatus: 'pending',
      planVersion: 1,
      planSource: options.planSource || (Array.isArray(options.plan) && options.plan.length ? 'provided' : 'template'),
      plannerModel: options.plannerModel || '',
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId,
      type: 'plan_approval_requested',
      title: 'Plan approval requested',
      content: `Waiting for user approval before executing ${plan.length} step(s).`,
      status: 'waiting_plan_approval',
      userId: options.userId,
      payload: {
        planVersion: 1,
        harnessTag,
        steps: plan.map((step, index) => ({
          planKey: normalizePlanKey(step, index),
          title: step.title || `Step ${index + 1}`,
          type: normalizeStepType(step.type),
          target: step.target || '',
          dependsOn: asArray(step.dependsOn).map(String),
        })),
      },
    });

    return this.getRunDetail(runId);
  }

  async revisePlanGoal(
    runId: string | number,
    plan: AgentLoopPlanStepInput[],
    options: {
      goal?: string;
      userId?: string | number;
      metadata?: any;
      planSource?: string;
      plannerModel?: string;
      harnessTag?: string;
      harnessProfileId?: string | number;
      harnessSettings?: any;
    } = {}
  ) {
    this.validator.validate(plan);
    const run = await this.repository.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }
    if (!['waiting_plan_approval', 'needs_replan'].includes(run.status)) {
      throw new Error(`Run ${run.id} is not waiting for plan revision.`);
    }

    await this.replacePlan(run.id, plan, {
      userId: options.userId,
      mode: 'replace_pending',
      reason: 'Plan revised',
      markRunning: false,
    });

    const nextPlanVersion = Number(run.planVersion || 1) + 1;
    await this.repository.updateRun(run.id, {
      goal: options.goal || run.goal,
      status: 'waiting_plan_approval',
      approvalStatus: 'pending',
      planVersion: nextPlanVersion,
      planSource: options.planSource || run.planSource || 'provided',
      plannerModel: options.plannerModel || run.plannerModel || '',
      rejectionReason: '',
      changeRequest: '',
      metadata: {
        ...asObject(run.metadata),
        ...asObject(options.metadata),
        harnessTag: options.harnessTag || asObject(run.metadata).harnessTag || 'default',
        harnessProfileId: options.harnessProfileId || asObject(run.metadata).harnessProfileId,
        harnessSettings: asObject(options.harnessSettings || asObject(run.metadata).harnessSettings),
        approvalMode: 'plan_first',
      },
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      type: 'plan_revision_requested',
      title: 'Plan revised for approval',
      content: `Waiting for approval of plan version ${nextPlanVersion}.`,
      status: 'waiting_plan_approval',
      userId: options.userId,
      payload: {
        planVersion: nextPlanVersion,
        steps: plan.map((step, index) => normalizePlanKey(step, index)),
      },
    });

    return this.getRunDetail(run.id);
  }

  async approvePlanAndExecute(
    runId: string | number,
    options: { userId?: string | number; ctx?: any; reason?: string } = {}
  ) {
    const run = await this.repository.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }
    if (!['waiting_plan_approval', 'approved'].includes(run.status)) {
      throw new Error(`Run ${run.id} is not waiting for plan approval.`);
    }

    await this.repository.updateRun(run.id, {
      status: 'approved',
      approvalStatus: 'approved',
      approvedById: options.userId,
      approvedAt: now(),
      rejectionReason: '',
      changeRequest: '',
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      type: 'plan_approved',
      title: 'Plan approved',
      content: options.reason || '',
      status: 'approved',
      userId: options.userId,
      payload: { planVersion: run.planVersion || 1 },
    });

    return this.executeApprovedPlan(run.id, options);
  }

  async rejectPlan(runId: string | number, options: { userId?: string | number; reason?: string } = {}) {
    const run = await this.repository.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return this.getRunSnapshot(run.id);
    }
    if (!['waiting_plan_approval', 'approved', 'needs_replan'].includes(run.status)) {
      throw new Error(`Run ${run.id} is not waiting for plan approval.`);
    }

    const steps = await this.repository.getSteps(run.id);
    for (const step of steps) {
      if (!TERMINAL_STEP_STATUSES.has(step.status) && step.status !== 'failed') {
        await this.repository.updateStep(step.id, {
          status: 'skipped',
          error: options.reason || 'Plan rejected by user.',
          endedAt: now(),
          updatedAt: now(),
        });
      }
    }

    await this.repository.updateRun(run.id, {
      status: 'rejected',
      approvalStatus: 'rejected',
      rejectionReason: options.reason || '',
      currentStepId: null,
      endedAt: now(),
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      type: 'plan_rejected',
      title: 'Plan rejected',
      content: options.reason || '',
      status: 'rejected',
      userId: options.userId,
    });

    return this.getRunSnapshot(run.id);
  }

  async requestPlanChanges(runId: string | number, options: { userId?: string | number; feedback?: string } = {}) {
    const run = await this.repository.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }
    if (!['waiting_plan_approval', 'needs_replan'].includes(run.status)) {
      throw new Error(`Run ${run.id} is not waiting for plan changes.`);
    }

    await this.repository.updateRun(run.id, {
      status: 'needs_replan',
      approvalStatus: 'changes_requested',
      changeRequest: options.feedback || '',
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      type: 'plan_changes_requested',
      title: 'Plan changes requested',
      content: options.feedback || '',
      status: 'needs_replan',
      userId: options.userId,
    });

    return this.getRunDetail(run.id);
  }

  async replacePlan(
    runId: string | number,
    plan: AgentLoopPlanStepInput[],
    options: {
      userId?: string | number;
      mode?: 'append' | 'replace_pending';
      reason?: string;
      markRunning?: boolean;
    } = {}
  ) {
    if (!Array.isArray(plan) || plan.length === 0) {
      throw new Error('Plan must include at least one step.');
    }
    this.validator.validate(plan);

    const run = await this.repository.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    const policy = normalizePolicy(run.policy);

    if (options.mode === 'replace_pending') {
      const existing = await this.repository.getSteps(run.id);
      for (const step of existing) {
        if (!TERMINAL_STEP_STATUSES.has(step.status) && step.status !== 'running') {
          await this.repository.updateStep(step.id, {
            status: 'skipped',
            error: options.reason || 'Replanned',
            endedAt: now(),
          });
        }
      }
    }

    const existingSteps = await this.repository.getSteps(run.id);
    const indexStart = existingSteps.reduce((max, step) => Math.max(max, Number(step.index || 0)), -1) + 1;
    const createdSteps = [];

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i] || {};
      const created = await this.repository.createStep({
        runId: run.id,
        parentStepId: step.parentStepId,
        planKey: normalizePlanKey(step, i),
        index: indexStart + i,
        title: step.title || `Step ${indexStart + i + 1}`,
        description: step.description || '',
        type: normalizeStepType(step.type),
        target: step.target || '',
        input: step.input || {},
        output: {},
        status: 'pending',
        attempt: 0,
        maxAttempts: step.maxAttempts || policy.maxStepAttempts,
        dependsOn: asArray(step.dependsOn).map(String),
        dependencyPolicy: step.dependencyPolicy || step.metadata?.dependencyPolicy || 'require_success',
        metadata: asObject(step.metadata),
      });
      createdSteps.push(created);
    }

    const nextStatus = options.markRunning === false ? run.status : 'running';
    await this.repository.updateRun(run.id, {
      status: nextStatus,
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      type: options.reason ? 'replanned' : 'planned',
      title: options.reason ? 'Plan updated' : 'Plan created',
      content: options.reason || `Created ${createdSteps.length} step(s).`,
      status: nextStatus,
      userId: options.userId,
      payload: { mode: options.mode || 'append', steps: createdSteps.map((step) => step.planKey) },
    });

    return createdSteps;
  }

  async replan(
    runId: string | number,
    plan: AgentLoopPlanStepInput[],
    options: { reason?: string; mode?: 'append' | 'replace_pending'; userId?: string | number } = {}
  ) {
    if (!Array.isArray(plan) || plan.length === 0) {
      throw new Error('Plan must include at least one step.');
    }

    const run = await this.repository.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    const policy = normalizePolicy(run.policy);
    if (!policy.allowReplan) {
      throw new Error('Replanning is disabled for this run.');
    }
    if (Number(run.iterationCount || 0) >= policy.maxIterations) {
      throw new Error(`Agent loop reached maxIterations=${policy.maxIterations}.`);
    }

    await this.repository.updateRun(run.id, {
      iterationCount: Number(run.iterationCount || 0) + 1,
      status: 'running',
      updatedAt: now(),
    });

    return this.replacePlan(run.id, plan, {
      mode: options.mode || 'replace_pending',
      reason: options.reason || 'Replan requested',
      userId: options.userId,
    });
  }

  async startStep(
    stepId: string | number,
    options: { userId?: string | number; agentExecutionSpanId?: string | number } = {}
  ) {
    const step = await this.repository.requireStep(stepId);
    const run = await this.repository.requireRun(step.runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    if (step.status !== 'pending' && step.status !== 'failed') {
      throw new Error(`Step ${step.id} cannot start from status "${step.status}".`);
    }

    const policy = normalizePolicy(run.policy);
    if (Number(step.attempt || 0) >= Number(step.maxAttempts || policy.maxStepAttempts)) {
      throw new Error(`Step ${step.id} reached maxAttempts=${step.maxAttempts}.`);
    }

    const nextAttempt = Number(step.attempt || 0) + 1;
    await this.repository.updateStep(step.id, {
      status: 'running',
      attempt: nextAttempt,
      error: '',
      agentExecutionSpanId: options.agentExecutionSpanId || step.agentExecutionSpanId,
      startedAt: now(),
      updatedAt: now(),
    });

    await this.repository.updateRun(run.id, {
      status: 'running',
      currentStepId: step.id,
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      stepId: step.id,
      type: 'step_started',
      title: `Started: ${step.title || step.planKey}`,
      status: 'running',
      userId: options.userId,
      payload: { attempt: nextAttempt },
    });

    if (['skill', 'tool', 'sub_agent'].includes(step.type)) {
      await this.repository.createEvent({
        runId: run.id,
        stepId: step.id,
        type: 'tool_called',
        title: `Calling ${step.type}: ${step.target || step.title || step.planKey}`,
        status: 'running',
        userId: options.userId,
        payload: {
          type: step.type,
          target: step.target,
          attempt: nextAttempt,
        },
      });
    }

    return this.getRunSnapshot(run.id);
  }

  async completeStep(
    stepId: string | number,
    output: any,
    options: {
      userId?: string | number;
      skillExecutionId?: string | number;
      agentExecutionSpanId?: string | number;
      metadata?: any;
    } = {}
  ) {
    const step = await this.repository.requireStep(stepId);
    const run = await this.repository.requireRun(step.runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    if (step.status !== 'running') {
      throw new Error(`Step ${step.id} cannot complete from status "${step.status}".`);
    }
    if (!run.currentStepId || String(run.currentStepId) !== String(step.id)) {
      throw new Error(`Step ${step.id} is not the current running step for run ${run.id}.`);
    }

    await this.repository.updateStep(step.id, {
      status: 'succeeded',
      output: output === undefined ? {} : output,
      error: '',
      skillExecutionId: options.skillExecutionId || step.skillExecutionId,
      agentExecutionSpanId: options.agentExecutionSpanId || step.agentExecutionSpanId,
      metadata: { ...asObject(step.metadata), ...asObject(options.metadata) },
      endedAt: now(),
      updatedAt: now(),
    });

    await this.repository.updateRun(run.id, {
      status: 'running',
      currentStepId: null,
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      stepId: step.id,
      type: 'step_succeeded',
      title: `Completed: ${step.title || step.planKey}`,
      content: trimText(output, 2000),
      status: 'succeeded',
      userId: options.userId,
    });

    return this.getRunSnapshot(run.id);
  }

  async failStep(stepId: string | number, error: string, options: { userId?: string | number; metadata?: any } = {}) {
    const step = await this.repository.requireStep(stepId);
    const run = await this.repository.requireRun(step.runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    if (step.status !== 'running') {
      throw new Error(`Step ${step.id} cannot fail from status "${step.status}".`);
    }
    if (!run.currentStepId || String(run.currentStepId) !== String(step.id)) {
      throw new Error(`Step ${step.id} is not the current running step for run ${run.id}.`);
    }

    const policy = normalizePolicy(run.policy);

    await this.repository.updateStep(step.id, {
      status: 'failed',
      error: trimText(error, 10000),
      metadata: { ...asObject(step.metadata), ...asObject(options.metadata) },
      endedAt: now(),
      updatedAt: now(),
    });

    await this.repository.updateRun(run.id, {
      status: 'running',
      currentStepId: null,
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      stepId: step.id,
      type: 'step_failed',
      title: `Failed: ${step.title || step.planKey}`,
      content: error,
      status: 'failed',
      userId: options.userId,
      payload: {
        retryable: Number(step.attempt || 0) < Number(step.maxAttempts || policy.maxStepAttempts),
      },
    });

    return this.getRunSnapshot(run.id);
  }

  async skipStep(stepId: string | number, reason = 'Skipped', options: { userId?: string | number} = {}) {
    const step = await this.repository.requireStep(stepId);
    const run = await this.repository.requireRun(step.runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    if (!['pending', 'running', 'failed'].includes(step.status)) {
      throw new Error(`Step ${step.id} cannot skip from status "${step.status}".`);
    }
    if (step.status === 'running') {
      if (!run.currentStepId || String(run.currentStepId) !== String(step.id)) {
        throw new Error(`Step ${step.id} is not the current running step for run ${run.id}.`);
      }
    }

    await this.repository.updateStep(step.id, {
      status: 'skipped',
      error: reason,
      endedAt: now(),
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      stepId: step.id,
      type: 'step_skipped',
      title: `Skipped: ${step.title || step.planKey}`,
      content: reason,
      status: 'skipped',
      userId: options.userId,
    });

    return this.getRunSnapshot(run.id);
  }

  async requestApproval(
    stepId: string | number,
    approval: any,
    options: { userId?: string | number; reason?: string } = {}
  ) {
    const step = await this.repository.requireStep(stepId);
    const run = await this.repository.requireRun(step.runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    if (!['pending', 'running'].includes(step.status)) {
      throw new Error(`Step ${step.id} cannot request approval for status "${step.status}".`);
    }
    if (step.status === 'running') {
      if (!run.currentStepId || String(run.currentStepId) !== String(step.id)) {
        throw new Error(`Step ${step.id} is not the current running step for run ${run.id}.`);
      }
    }

    await this.repository.updateStep(step.id, {
      status: 'waiting_user',
      approval: approval || {},
      updatedAt: now(),
    });

    await this.repository.updateRun(run.id, {
      status: 'waiting_user',
      currentStepId: step.id,
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      stepId: step.id,
      type: 'approval_requested',
      title: `Approval requested: ${step.title || step.planKey}`,
      content: options.reason || approval?.prompt || '',
      status: 'waiting_user',
      userId: options.userId,
      payload: approval || {},
    });

    return this.getRunSnapshot(run.id);
  }

  async resumeRun(
    runId: string | number,
    options: {
      stepId?: string | number;
      approved: boolean;
      editedInput?: any;
      userId?: string | number;
      ctx?: any;
    }
  ) {
    const run = await this.repository.requireRun(runId);
    const stepId = options.stepId || run.currentStepId;
    if (!stepId) {
      throw new Error('No waiting step found for this run.');
    }
    const step = await this.repository.requireStep(stepId);
    if (String(step.runId) !== String(run.id)) {
      throw new Error('Step does not belong to the run.');
    }
    if (run.status !== 'waiting_user' || step.status !== 'waiting_user') {
      throw new Error('Run is not waiting for user approval.');
    }
    if (run.currentStepId && String(run.currentStepId) !== String(step.id)) {
      throw new Error(`Step ${step.id} is not the current waiting step for run ${run.id}.`);
    }

    if (options.approved) {
      const nextValues: any = {
        status: 'pending',
        approval: { ...(step.approval || {}), approved: true, resolvedAt: now().toISOString() },
        updatedAt: now(),
      };
      if (options.editedInput !== undefined) {
        nextValues.input = options.editedInput;
      }
      await this.repository.updateStep(step.id, nextValues);
      await this.repository.updateRun(run.id, {
        status: 'running',
        currentStepId: null,
        updatedAt: now(),
      });
    } else {
      await this.repository.updateStep(step.id, {
        status: 'failed',
        approval: { ...(step.approval || {}), approved: false, resolvedAt: now().toISOString() },
        error: 'User rejected this step.',
        endedAt: now(),
        updatedAt: now(),
      });
      await this.repository.updateRun(run.id, {
        status: 'running',
        currentStepId: null,
        updatedAt: now(),
      });
    }

    await this.repository.createEvent({
      runId: run.id,
      stepId: step.id,
      type: 'approval_resolved',
      title: options.approved ? 'Approval granted' : 'Approval rejected',
      status: options.approved ? 'running' : 'failed',
      userId: options.userId,
      payload: {
        approved: options.approved,
        editedInput: options.editedInput,
      },
    });

    if (options.approved) {
      return this.executeApprovedPlan(run.id, { userId: options.userId, ctx: options.ctx });
    }
    return this.getRunSnapshot(run.id);
  }

  async retryStep(stepId: string | number, options: { userId?: string | number } = {}) {
    const step = await this.repository.requireStep(stepId);
    const run = await this.repository.requireRun(step.runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    if (step.status !== 'failed') {
      throw new Error('Only failed steps can be retried.');
    }

    const policy = normalizePolicy(run.policy);
    if (Number(step.attempt || 0) >= Number(step.maxAttempts || policy.maxStepAttempts)) {
      throw new Error(`Step ${step.id} reached maxAttempts=${step.maxAttempts}.`);
    }

    await this.repository.updateStep(step.id, {
      status: 'pending',
      error: '',
      endedAt: null,
      updatedAt: now(),
    });

    await this.repository.updateRun(run.id, {
      status: 'running',
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      stepId: step.id,
      type: 'step_retry',
      title: `Retry queued: ${step.title || step.planKey}`,
      status: 'pending',
      userId: options.userId,
    });

    return this.getRunSnapshot(run.id);
  }

  async finishRun(
    runId: string | number,
    finalAnswer: string,
    options: {
      status?: Extract<AgentLoopRunStatus, 'succeeded' | 'failed'>;
      summary?: string;
      evidence?: any;
      userId?: string | number;
    } = {}
  ) {
    const run = await this.repository.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Agent loop run ${run.id} is already ${run.status}.`);
    }

    const status = options.status || 'succeeded';
    if (status === 'succeeded') {
      const steps = await this.repository.getSteps(run.id);
      const unfinished = steps.filter((step) => !TERMINAL_STEP_STATUSES.has(step.status));
      if (unfinished.length) {
        throw new Error(`Cannot finish run ${run.id}: ${unfinished.length} step(s) are not complete.`);
      }
      const policy = normalizePolicy(run.policy);
      const verificationPassed = steps.some((step) => step.type === 'verification' && step.status === 'succeeded');
      if (policy.requireVerification && !verificationPassed) {
        throw new Error('Cannot finish run: policy requires a succeeded verification step.');
      }
    }

    await this.repository.updateRun(run.id, {
      status,
      finalAnswer: finalAnswer || '',
      summary: options.summary || run.summary,
      currentStepId: null,
      metadata: { ...asObject(run.metadata), evidence: options.evidence },
      endedAt: now(),
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      type: 'finished',
      title: status === 'succeeded' ? 'Agent loop finished' : 'Agent loop failed',
      content: finalAnswer,
      status,
      userId: options.userId,
      payload: { evidence: options.evidence },
    });

    return this.getRunSnapshot(run.id);
  }

  async cancelRun(runId: string | number, options: { userId?: string | number; reason?: string } = {}) {
    const run = await this.repository.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return this.getRunSnapshot(run.id);
    }

    const steps = await this.repository.getSteps(run.id);
    for (const step of steps) {
      if (!TERMINAL_STEP_STATUSES.has(step.status) && step.status !== 'failed') {
        await this.repository.updateStep(step.id, {
          status: 'skipped',
          error: options.reason || 'Run canceled.',
          endedAt: now(),
          updatedAt: now(),
        });
      }
    }

    await this.repository.updateRun(run.id, {
      status: 'canceled',
      currentStepId: null,
      endedAt: now(),
      updatedAt: now(),
    });

    await this.repository.createEvent({
      runId: run.id,
      type: 'canceled',
      title: 'Agent loop canceled',
      content: options.reason || '',
      status: 'canceled',
      userId: options.userId,
    });

    return this.getRunSnapshot(run.id);
  }

  async executeApprovedPlan(runId: string | number, options: { userId?: string | number; ctx?: any } = {}) {
    // Concurrency check using a unique process-specific database lock token
    const lockToken = `exec-${runId}-${Math.random().toString(36).slice(2, 10)}`;
    const acquired = await this.repository.lockRun(runId, lockToken, 300000); // 5 mins lock
    if (!acquired) {
      throw new Error(`Run ${runId} is currently locked and executing in another process.`);
    }

    try {
      let iterations = 0;
      let snapshot = await this.getRunSnapshot(runId);
      const harnessSettings = asObject(snapshot.run?.metadata?.harnessSettings);
      const maxControllerSteps = Math.max(
        1,
        Math.min(
          ORCHESTRATOR_CONTROLLER_MAX_STEPS,
          Number(harnessSettings.maxControllerSteps || ORCHESTRATOR_CONTROLLER_MAX_STEPS)
        )
      );

      const policy = normalizePolicy(snapshot.run.policy);

      while (snapshot.nextStep && iterations < maxControllerSteps) {
        iterations += 1;
        const nextStep = snapshot.nextStep;
        snapshot = await this.startStep(nextStep.id, { userId: options.userId });
        const runningStep = snapshot.steps.find((step: any) => String(step.id) === String(nextStep.id)) || nextStep;

        try {
          const output = await this.harness.executeStep(snapshot.run, runningStep, options);
          snapshot = await this.completeStep(runningStep.id, output, {
            userId: options.userId,
            metadata: { controller: 'agent-loop-service' },
          });
        } catch (error: any) {
          if (error?.message === 'requires_approval') {
            // Pause the execution and request approval
            snapshot = await this.requestApproval(runningStep.id, {
              prompt: `Execution of step "${runningStep.title}" requires permission.`,
            }, {
              userId: options.userId,
              reason: 'Dynamic tool approval required by policy.',
            });
            break;
          }

          snapshot = await this.failStep(runningStep.id, error?.message || String(error), {
            userId: options.userId,
            metadata: { controller: 'agent-loop-service' },
          });
          const failedStep = snapshot.steps.find((step: any) => String(step.id) === String(runningStep.id));
          if (!failedStep || Number(failedStep.attempt || 0) >= Number(failedStep.maxAttempts || policy.maxStepAttempts)) {
            break;
          }
        }
      }

      snapshot = await this.getRunSnapshot(runId);
      if (iterations >= maxControllerSteps && snapshot.nextStep) {
        return this.finishRun(runId, `Agent loop stopped after ${maxControllerSteps} controller steps.`, {
          status: 'failed',
          summary: 'Controller iteration limit reached.',
          userId: options.userId,
        });
      }

      // If waiting for approval or user, exit loop but don't finish
      if (snapshot.run.status === 'waiting_user') {
        return snapshot;
      }

      const steps = snapshot.steps || [];
      const failed = steps.filter((step: any) => step.status === 'failed');
      const unfinished = steps.filter((step: any) => !TERMINAL_STEP_STATUSES.has(step.status) && step.status !== 'failed');
      if (failed.length || unfinished.length) {
        return this.finishRun(
          runId,
          failed.length
            ? `Agent loop failed at ${failed.length} step(s).`
            : `Agent loop stopped with ${unfinished.length} unfinished step(s).`,
          {
            status: 'failed',
            summary: failed[0]?.error || 'No executable step is available.',
            evidence: { failedStepIds: failed.map((step: any) => step.id), unfinishedStepIds: unfinished.map((step: any) => step.id) },
            userId: options.userId,
          }
        );
      }

      const verification = steps.find((step: any) => step.type === 'verification' && step.status === 'succeeded');
      return this.finishRun(runId, 'Agent loop completed after plan execution.', {
        status: 'succeeded',
        summary: verification?.output?.summary || 'All approved plan steps completed.',
        evidence: { stepCount: steps.length, controllerIterations: iterations },
        userId: options.userId,
      });
    } finally {
      // Unlock only if we held this specific lockToken
      const current = await this.repository.getRun(runId);
      if (current && current.lockedBy === lockToken) {
        await this.repository.unlockRun(runId);
      }
    }
  }

  async getRunSnapshot(runId: string | number) {
    const run = await this.repository.requireRun(runId);
    const steps = await this.repository.getSteps(run.id);
    const nextStep = this.pickNextStep(steps, run.policy);
    return {
      run,
      steps,
      nextStep,
    };
  }

  async getRunDetail(runId: string | number) {
    const snapshot = await this.getRunSnapshot(runId);
    const events = await this.repository.getEvents(snapshot.run.id);
    const spans = await this.repository.getLinkedSpans(snapshot.run.id, snapshot.run.rootRunId);
    const skillExecutions = await this.repository.getLinkedSkillExecutions(snapshot.run.id, snapshot.steps);
    return {
      ...snapshot,
      events,
      spans,
      skillExecutions,
    };
  }

  pickNextStep(steps: any[], runPolicy?: any) {
    const byPlanKey = new Map(steps.map((step) => [String(step.planKey), step]));
    const policy = normalizePolicy(runPolicy);

    const candidates = steps
      .filter(
        (step) =>
          step.status === 'pending' ||
          (step.status === 'failed' &&
            Number(step.attempt || 0) < Number(step.maxAttempts || policy.maxStepAttempts))
      )
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));

    for (const step of candidates) {
      const dependencies = asArray(step.dependsOn).map(String);
      const allowSkipped =
        step.dependencyPolicy === 'allow_skipped' || step.metadata?.dependencyPolicy === 'allow_skipped';
      const ready = dependencies.every((key) => {
        const dependency = byPlanKey.get(key);
        return dependency?.status === 'succeeded' || (allowSkipped && dependency?.status === 'skipped');
      });
      if (ready) {
        return {
          ...step,
          retryable: step.status === 'failed',
        };
      }
    }
    return null;
  }
}
