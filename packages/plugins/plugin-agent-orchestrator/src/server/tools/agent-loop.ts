import { z } from 'zod';
import { AgentLoopPlanStepInput, AgentLoopService } from '../services/AgentLoopService';
import { getOrchestratorTraceContext, setOrchestratorTraceContext } from '../services/ExecutionSpanService';
import {
  currentUserId,
  resolveSessionId,
  resolveMessageId,
  normalizeEmployeeUsername,
  resolveLeaderUsername,
  valuesFromCtx,
} from '../utils/ctx-utils';

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

function setLoopTraceContext(ctx: any, snapshot: any, step?: any) {
  if (!ctx || !snapshot?.run) return;
  const existing: any = getOrchestratorTraceContext(ctx) || {};
  setOrchestratorTraceContext(ctx, {
    ...existing,
    rootRunId: snapshot.run.rootRunId || existing.rootRunId,
    leaderUsername: snapshot.run.leaderUsername || existing.leaderUsername,
    agentLoopRunId: String(snapshot.run.id),
    agentLoopStepId: step?.id ? String(step.id) : undefined,
  } as any);
}

function planFromArgs(plan: AgentLoopPlanStepInput[] | undefined) {
  return Array.isArray(plan) ? plan : [];
}

export function createAgentLoopTools(plugin: any, service: AgentLoopService) {
  return [
    {
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ALLOW' as const,
      introduction: {
        title: 'Agent Loop - Start',
        about: 'Create a persistent agent loop run and initial plan for a user goal.',
      },
      definition: {
        name: 'agent_loop_start',
        description:
          'Start a persistent agent loop run. Use this first when the user asks for a multi-step task. Provide a concrete plan with small executable steps before calling other tools.',
        schema: z.object({
          goal: z.string().min(1).describe('The user goal to complete.'),
          leaderUsername: z
            .string()
            .optional()
            .describe('Leader AI employee username. Usually omit; inferred from chat.'),
          sessionId: z.string().optional(),
          messageId: z.string().optional(),
          policy: policySchema,
          metadata: z.any().optional(),
          plan: z
            .array(stepSchema)
            .optional()
            .describe('Initial plan steps. Use stable planKey values for dependencies.'),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          const leaderUsername = await resolveLeaderUsername(ctx, plugin, args);
          const snapshot = await service.createRun({
            goal: args.goal,
            leaderUsername,
            sessionId: resolveSessionId(ctx, args),
            messageId: resolveMessageId(ctx, args),
            userId: currentUserId(ctx),
            policy: args.policy,
            metadata: args.metadata,
            plan: planFromArgs(args.plan),
          });
          setLoopTraceContext(ctx, snapshot, snapshot.nextSteps?.[0]);
          return toolResult('success', snapshot);
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
        title: 'Agent Loop - Status',
        about: 'Read the current run, steps, and next executable steps.',
      },
      definition: {
        name: 'agent_loop_status',
        description: 'Fetch an agent loop run. Call this to check which steps are ready for execution.',
        schema: z.object({
          runId: z.union([z.string(), z.number()]),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          const snapshot = await service.getRunSnapshot(args.runId);
          setLoopTraceContext(ctx, snapshot, snapshot.nextSteps?.[0]);
          return toolResult('success', snapshot);
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
        title: 'Agent Loop - Update Step',
        about: 'Move a plan step through running, succeeded, failed, or skipped states.',
      },
      definition: {
        name: 'agent_loop_update_step',
        description:
          'Update one plan step after executing the corresponding skill/tool/sub-agent action. Use status="running" before the action and status="succeeded" or "failed" after it.',
        schema: z.object({
          stepId: z.union([z.string(), z.number()]),
          status: z.enum(['running', 'succeeded', 'failed', 'skipped']),
          output: z.any().optional(),
          error: z.string().optional(),
          reason: z.string().optional(),
          skillExecutionId: z.union([z.string(), z.number()]).optional(),
          agentExecutionSpanId: z.union([z.string(), z.number()]).optional(),
          metadata: z.any().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          let snapshot;
          if (args.status === 'running') {
            snapshot = await service.startStep(args.stepId, {
              userId: currentUserId(ctx),
              agentExecutionSpanId: args.agentExecutionSpanId,
            });
            const currentStep = snapshot.steps.find((step: any) => String(step.id) === String(args.stepId));
            setLoopTraceContext(ctx, snapshot, currentStep);
          } else if (args.status === 'succeeded') {
            snapshot = await service.completeStep(args.stepId, args.output === undefined ? {} : args.output, {
              userId: currentUserId(ctx),
              skillExecutionId: args.skillExecutionId,
              agentExecutionSpanId: args.agentExecutionSpanId,
              metadata: args.metadata,
            });
            setLoopTraceContext(ctx, snapshot, snapshot.nextSteps?.[0]);
          } else if (args.status === 'failed') {
            snapshot = await service.failStep(args.stepId, args.error || 'Step failed.', {
              userId: currentUserId(ctx),
              metadata: args.metadata,
            });
            setLoopTraceContext(ctx, snapshot, snapshot.nextSteps?.[0]);
          } else {
            snapshot = await service.skipStep(args.stepId, args.reason || 'Skipped.', {
              userId: currentUserId(ctx),
            });
            setLoopTraceContext(ctx, snapshot, snapshot.nextSteps?.[0]);
          }
          return toolResult('success', snapshot);
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
        title: 'Agent Loop - Replan',
        about: 'Replace pending work or append new plan steps when execution needs a new path.',
      },
      definition: {
        name: 'agent_loop_replan',
        description:
          'Update the plan when a step fails, required context is missing, or a better execution path is discovered.',
        schema: z.object({
          runId: z.union([z.string(), z.number()]),
          reason: z.string().optional(),
          mode: z.enum(['replace_pending', 'append']).optional(),
          plan: z.array(stepSchema).min(1),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          await service.replan(args.runId, args.plan, {
            reason: args.reason,
            mode: args.mode || 'replace_pending',
            userId: currentUserId(ctx),
          });
          const snapshot = await service.getRunSnapshot(args.runId);
          setLoopTraceContext(ctx, snapshot, snapshot.nextSteps?.[0]);
          return toolResult('success', snapshot);
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
        title: 'Agent Loop - Request Approval',
        about: 'Pause a run and request user approval or edited input for a step.',
      },
      definition: {
        name: 'agent_loop_request_approval',
        description:
          'Pause the loop when a step needs user approval, user-edited input, or an ASK/human-review tool cannot run headlessly.',
        schema: z.object({
          stepId: z.union([z.string(), z.number()]),
          reason: z.string().optional(),
          approval: z.any().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          const snapshot = await service.requestApproval(args.stepId, args.approval || {}, {
            reason: args.reason,
            userId: currentUserId(ctx),
          });
          setLoopTraceContext(ctx, snapshot, snapshot.nextSteps?.[0]);
          return toolResult('success', snapshot);
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
        title: 'Agent Loop - Resume',
        about: 'Resume a waiting run after user approval or rejection.',
      },
      definition: {
        name: 'agent_loop_resume',
        description:
          'Resume a run that is waiting for user approval. Pass editedInput when the user changed step input.',
        schema: z.object({
          runId: z.union([z.string(), z.number()]),
          stepId: z.union([z.string(), z.number()]).optional(),
          approved: z.boolean(),
          editedInput: z.any().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          const snapshot = await service.resumeRun(args.runId, {
            stepId: args.stepId,
            approved: args.approved,
            editedInput: args.editedInput,
            userId: currentUserId(ctx),
            ctx,
          });
          setLoopTraceContext(ctx, snapshot, snapshot.nextSteps?.[0]);
          return toolResult('success', snapshot);
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
        title: 'Agent Loop - Finish',
        about: 'Finish a run with final answer and optional evidence.',
      },
      definition: {
        name: 'agent_loop_finish',
        description:
          'Finish the agent loop after all required steps and verification are complete. Use status="failed" if the goal cannot be completed.',
        schema: z.object({
          runId: z.union([z.string(), z.number()]),
          finalAnswer: z.string().optional(),
          status: z.enum(['succeeded', 'failed']).optional(),
          summary: z.string().optional(),
          evidence: z.any().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          const snapshot = await service.finishRun(args.runId, args.finalAnswer || '', {
            status: args.status || 'succeeded',
            summary: args.summary,
            evidence: args.evidence,
            userId: currentUserId(ctx),
          });
          setLoopTraceContext(ctx, snapshot);
          return toolResult('success', snapshot);
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
        title: 'Agent Loop - Cancel',
        about: 'Cancel a run and skip unfinished steps.',
      },
      definition: {
        name: 'agent_loop_cancel',
        description: 'Cancel an agent loop run. Use this when the user stops the task or the goal is no longer valid.',
        schema: z.object({
          runId: z.union([z.string(), z.number()]),
          reason: z.string().optional(),
        }),
      },
      invoke: async (ctx: any, args: any) => {
        try {
          const snapshot = await service.cancelRun(args.runId, {
            reason: args.reason,
            userId: currentUserId(ctx),
          });
          setLoopTraceContext(ctx, snapshot);
          return toolResult('success', snapshot);
        } catch (error: any) {
          return toolResult('error', error?.message || String(error));
        }
      },
    },
  ];
}
