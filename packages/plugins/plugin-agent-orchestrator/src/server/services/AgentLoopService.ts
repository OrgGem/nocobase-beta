import { AgentRegistryService } from './AgentRegistryService';
import { AgentPlannerService } from './AgentPlannerService';
import { AgentPlanValidator } from './AgentPlanValidator';
import { AgentLoopRepository } from './AgentLoopRepository';
import { AgentHarness } from './AgentHarness';
import { AgentLoopController } from './AgentLoopController';
import { TokenTracker } from './TokenTracker';

export type AgentLoopRunStatus =
  | 'planning'
  | 'waiting_plan_approval'
  | 'approved'
  | 'running'
  | 'waiting_user'
  | 'needs_replan'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'canceled';
export type AgentLoopStepStatus = 'pending' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'skipped';
export type AgentLoopStepType = 'reasoning' | 'skill' | 'tool' | 'sub_agent' | 'verification';
export type AgentLoopStepDependencyPolicy = 'require_success' | 'allow_skipped';

export type AgentLoopPolicy = {
  maxIterations: number;
  maxStepAttempts: number;
  allowReplan: boolean;
  requireVerification: boolean;
  stopOnApprovalRequired: boolean;
  maxContextTokens?: number;
  contextSummaryStrategy?: 'last_n' | 'all';
  includeToolResults?: boolean;
  includeStepOutputs?: boolean;
  maxConcurrency?: number;
};

export type AgentLoopPlanStepInput = {
  id?: string;
  key?: string;
  planKey?: string;
  parentStepId?: string | number;
  title?: string;
  description?: string;
  type?: AgentLoopStepType;
  target?: string;
  input?: any;
  dependsOn?: string[];
  dependencyPolicy?: AgentLoopStepDependencyPolicy;
  maxAttempts?: number;
  metadata?: any;
};

export class AgentLoopService {
  public readonly registryService: AgentRegistryService;
  public readonly plannerService: AgentPlannerService;
  public readonly validator: AgentPlanValidator;
  public readonly repository: AgentLoopRepository;
  public readonly harness: AgentHarness;
  public readonly controller: AgentLoopController;

  constructor(private readonly plugin: any) {
    this.registryService = new AgentRegistryService(plugin);
    this.plannerService = new AgentPlannerService();
    this.validator = new AgentPlanValidator();
    this.repository = new AgentLoopRepository(plugin);
    const tokenTracker = new TokenTracker(plugin);
    this.harness = new AgentHarness(plugin, this.registryService, tokenTracker);
    this.controller = new AgentLoopController(
      this.registryService,
      this.plannerService,
      this.validator,
      this.repository,
      this.harness,
      tokenTracker,
    );
  }

  get db() {
    return this.plugin.db;
  }

  get app() {
    return this.plugin.app;
  }

  async createRun(options: any) {
    return this.controller.createRun(options);
  }

  async planGoal(options: any) {
    return this.controller.planGoal(options);
  }

  async revisePlanGoal(runId: any, plan: any, options: any = {}) {
    return this.controller.revisePlanGoal(runId, plan, options);
  }

  async approvePlanAndExecute(runId: any, options: any = {}) {
    return this.controller.approvePlanAndExecute(runId, options);
  }

  async rejectPlan(runId: any, options: any = {}) {
    return this.controller.rejectPlan(runId, options);
  }

  async requestPlanChanges(runId: any, options: any = {}) {
    return this.controller.requestPlanChanges(runId, options);
  }

  async replacePlan(runId: any, plan: any, options: any = {}) {
    return this.controller.replacePlan(runId, plan, options);
  }

  async replan(runId: any, plan: any, options: any = {}) {
    return this.controller.replan(runId, plan, options);
  }

  async startStep(stepId: any, options: any = {}) {
    return this.controller.startStep(stepId, options);
  }

  async completeStep(stepId: any, output: any, options: any = {}) {
    return this.controller.completeStep(stepId, output, options);
  }

  async failStep(stepId: any, error: any, options: any = {}) {
    return this.controller.failStep(stepId, error, options);
  }

  async skipStep(stepId: any, reason: any = 'Skipped', options: any = {}) {
    return this.controller.skipStep(stepId, reason, options);
  }

  async requestApproval(stepId: any, approval: any, options: any = {}) {
    return this.controller.requestApproval(stepId, approval, options);
  }

  async resumeRun(runId: any, options: any) {
    return this.controller.resumeRun(runId, options);
  }

  async retryStep(stepId: any, options: any = {}) {
    return this.controller.retryStep(stepId, options);
  }

  async stepFeedback(stepId: any, feedback: any, options: any = {}) {
    return this.controller.stepFeedback(stepId, feedback, options);
  }

  async finishRun(runId: any, finalAnswer: any, options: any = {}) {
    return this.controller.finishRun(runId, finalAnswer, options);
  }

  async cancelRun(runId: any, options: any = {}) {
    return this.controller.cancelRun(runId, options);
  }

  async executeApprovedPlan(runId: any, options: any = {}) {
    return this.controller.executeApprovedPlan(runId, options);
  }

  async getRunSnapshot(runId: any) {
    return this.controller.getRunSnapshot(runId);
  }

  async getRunDetail(runId: any) {
    return this.controller.getRunDetail(runId);
  }

  async createEvent(values: any) {
    return this.repository.createEvent(values);
  }
}
