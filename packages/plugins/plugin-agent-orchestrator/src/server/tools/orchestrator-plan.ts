import { z } from 'zod';
import { AgentLoopPlanStepInput, AgentLoopService } from '../services/AgentLoopService';

const stepSchema = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  planKey: z.string().optional(),
  parentStepId: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(['reasoning', 'skill', 'tool', 'sub_agent', 'verification']).optional(),
  target: z.string().optional(),
  input: z.any().optional(),
  dependsOn: z.array(z.string()).optional(),
  dependencyPolicy: z.enum(['require_success', 'allow_skipped']).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  metadata: z.any().optional(),
});

const policySchema = z
  .object({
    maxIterations: z.number().int().min(1).max(100).optional(),
    maxStepAttempts: z.number().int().min(1).max(10).optional(),
    allowReplan: z.boolean().optional(),
    requireVerification: z.boolean().optional(),
    stopOnApprovalRequired: z.boolean().optional(),
  })
  .optional();

function toolResult(status: 'success' | 'error', payload: any) {
  return {
    status,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function valuesFromCtx(ctx: any) {
  return ctx?.action?.params?.values || ctx?.request?.body || {};
}

function currentUserId(ctx: any) {
  return ctx?.state?.currentUser?.id || ctx?.auth?.user?.id;
}

function resolveSessionId(ctx: any, args: any) {
  const values = valuesFromCtx(ctx);
  return args?.sessionId || values.sessionId || ctx?.action?.params?.sessionId || ctx?.state?.sessionId;
}

function resolveMessageId(ctx: any, args: any) {
  const values = valuesFromCtx(ctx);
  return args?.messageId || values.messageId || ctx?.action?.params?.messageId;
}

function normalizeEmployeeUsername(raw: any) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  return raw.username || raw.aiEmployeeUsername || raw.name || null;
}

async function resolveLeaderUsername(ctx: any, plugin: any, args: any) {
  const values = valuesFromCtx(ctx);
  const direct = normalizeEmployeeUsername(
    args?.leaderUsername ||
      ctx?._currentAIEmployee ||
      ctx?.state?.currentAIEmployee ||
      ctx?.runtime?.context?.currentAIEmployee ||
      values.aiEmployee,
  );
  if (direct) return direct;

  const sessionId = resolveSessionId(ctx, args);
  if (!sessionId) return undefined;
  try {
    const repo = ctx?.db?.getRepository?.('aiConversations') || plugin.db.getRepository('aiConversations');
    const conversation = await repo.findOne({ filter: { sessionId } });
    return normalizeEmployeeUsername(conversation?.aiEmployeeUsername || conversation?.get?.('aiEmployeeUsername'));
  } catch {
    return undefined;
  }
}

function summarizePlan(steps: any[]) {
  return (steps || []).map((step) => ({
    id: step.id,
    planKey: step.planKey,
    title: step.title,
    description: step.description,
    type: step.type,
    target: step.target,
    dependsOn: step.dependsOn || [],
    status: step.status,
  }));
}

function inferTargetAgent(args: any) {
  if (args?.targetAgent) return args.targetAgent;
  const plan = Array.isArray(args?.plan) ? args.plan : [];
  const subAgentStep = plan.find((step: any) => step?.type === 'sub_agent' && step?.target);
  return subAgentStep?.target;
}

async function resolveHarnessTag(plugin: any, leaderUsername: string | undefined, targetAgent: string | undefined, args: any) {
  const direct = String(args?.harnessTag || args?.metadata?.harnessTag || '').trim();
  if (direct) return direct;
  if (!leaderUsername || !targetAgent) return 'default';
  try {
    const repo = plugin.db.getRepository('orchestratorConfig');
    const config = await repo.findOne({
      filter: {
        leaderUsername,
        subAgentUsername: targetAgent,
        enabled: true,
      },
    });
    return config?.harnessTag || config?.get?.('harnessTag') || 'default';
  } catch {
    return 'default';
  }
}

export function createOrchestratorPlanTools(plugin: any, service: AgentLoopService) {
  return [
    {
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ALLOW' as const,
      introduction: {
        title: 'Orchestrator - Plan Goal',
        about: 'Create a draft plan and pause for explicit user approval before execution.',
      },
      definition: {
        name: 'orchestrator_plan_goal',
        description:
          'Create or revise a persistent orchestrator run in waiting_plan_approval state. Use this before any multi-step/sub-agent execution. Provide a concrete plan with small executable steps and stable planKey dependencies whenever possible. Pass runId only when revising after user-requested changes. This tool does not execute the plan.',
        schema: z.object({
          goal: z.string().min(1).describe('The user goal to complete.'),
          runId: z
            .union([z.string(), z.number()])
            .optional()
            .describe('Existing run id to revise after the user requested plan changes. Omit for a new run.'),
          leaderUsername: z.string().optional().describe('Leader AI employee username. Usually omit; inferred from chat.'),
          sessionId: z.string().optional(),
          messageId: z.string().optional(),
          harnessTag: z.string().optional().default('default').describe('Harness profile tag, for example default, safe, or file-heavy.'),
          targetAgent: z.string().optional().describe('Optional sub-agent username for generated fallback plans.'),
          plannerModel: z.string().optional(),
          policy: policySchema,
          metadata: z.any().optional(),
          plan: z
            .array(stepSchema)
            .optional()
            .describe('Draft plan steps. Tool/sub_agent steps should include target. Dependencies must reference planKey values.'),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          const leaderUsername = await resolveLeaderUsername(ctx, plugin, args);
          const targetAgent = inferTargetAgent(args);
          const harnessTag = await resolveHarnessTag(plugin, leaderUsername, targetAgent, args);
          const detail = await service.planGoal({
            goal: args.goal,
            runId: args.runId,
            leaderUsername,
            sessionId: resolveSessionId(ctx, args),
            messageId: resolveMessageId(ctx, args),
            userId: currentUserId(ctx),
            policy: args.policy,
            metadata: args.metadata,
            plan: Array.isArray(args.plan) ? (args.plan as AgentLoopPlanStepInput[]) : undefined,
            plannerModel: args.plannerModel,
            harnessTag,
            targetAgent,
          });
          return toolResult('success', {
            run: detail.run,
            plan: summarizePlan(detail.steps),
            approval: {
              required: true,
              nextTool: 'orchestrator_execute_plan',
              args: {
                runId: detail.run.id,
                planVersion: detail.run.planVersion || 1,
                plan: summarizePlan(detail.steps),
              },
            },
          });
        } catch (error: any) {
          return toolResult('error', error?.message || String(error));
        }
      },
    },
    {
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ASK' as const,
      introduction: {
        title: 'Orchestrator - Execute Approved Plan',
        about: 'Execute a draft plan only after the user approves the plan card.',
      },
      definition: {
        name: 'orchestrator_execute_plan',
        description:
          'Execute a run created by orchestrator_plan_goal. This tool must be called with the runId after the user reviews the plan. The UI will ask the user to accept or reject the plan before invoke runs.',
        schema: z.object({
          runId: z.union([z.string(), z.number()]).describe('The agentLoopRuns id returned by orchestrator_plan_goal.'),
          planVersion: z.number().int().optional(),
          plan: z.array(stepSchema).optional().describe('Optional copy of the displayed plan for the approval UI.'),
          reason: z.string().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          const detail = await service.approvePlanAndExecute(args.runId, {
            userId: currentUserId(ctx),
            ctx,
            reason: args.reason,
          });
          return toolResult('success', detail);
        } catch (error: any) {
          return toolResult('error', error?.message || String(error));
        }
      },
    },
    {
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ALLOW' as const,
      introduction: {
        title: 'Orchestrator - Status',
        about: 'Read a run, its plan steps, events, and linked traces.',
      },
      definition: {
        name: 'orchestrator_status',
        description: 'Read the current status of an orchestrator run without mutating it.',
        schema: z.object({
          runId: z.union([z.string(), z.number()]),
        }),
      },
      invoke: async (_ctx: any, args: any) => {
        try {
          return toolResult('success', await service.getRunDetail(args.runId));
        } catch (error: any) {
          return toolResult('error', error?.message || String(error));
        }
      },
    },
    {
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ASK' as const,
      introduction: {
        title: 'Orchestrator - Cancel Run',
        about: 'Cancel an orchestrator run with user approval.',
      },
      definition: {
        name: 'orchestrator_cancel',
        description: 'Cancel an orchestrator run. This mutates run state and therefore requires user approval.',
        schema: z.object({
          runId: z.union([z.string(), z.number()]),
          reason: z.string().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          return toolResult(
            'success',
            await service.cancelRun(args.runId, {
              reason: args.reason,
              userId: currentUserId(ctx),
            }),
          );
        } catch (error: any) {
          return toolResult('error', error?.message || String(error));
        }
      },
    },
  ];
}
