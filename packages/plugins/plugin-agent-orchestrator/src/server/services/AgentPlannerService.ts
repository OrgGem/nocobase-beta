import { AgentLoopPlanStepInput } from './AgentLoopService';

function normalizeStepType(value: any) {
  return ['reasoning', 'skill', 'tool', 'sub_agent', 'verification'].includes(value) ? value : 'tool';
}

function normalizePlanKey(step: any, index: number) {
  return String(step.planKey || step.key || step.id || `step_${index + 1}`);
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

export class AgentPlannerService {
  buildPlan(
    goal: string,
    plan: AgentLoopPlanStepInput[] | undefined,
    options: { targetAgent?: string; harnessTag?: string; metadata?: any }
  ): AgentLoopPlanStepInput[] {
    if (Array.isArray(plan) && plan.length > 0) {
      return plan.map((step, index) => ({
        ...step,
        planKey: normalizePlanKey(step, index),
        type: normalizeStepType(step.type),
        dependsOn: asArray(step.dependsOn).map(String),
        metadata: {
          ...asObject(step.metadata),
          harnessTag: options.harnessTag || options.metadata?.harnessTag || 'default',
        },
      }));
    }

    const harnessTag = options.harnessTag || options.metadata?.harnessTag || 'default';
    const steps: AgentLoopPlanStepInput[] = [
      {
        planKey: 'prepare_context',
        title: 'Prepare execution context',
        description: 'Review the user goal, available context, and constraints before execution.',
        type: 'reasoning',
        input: { goal },
        metadata: { harnessTag },
      },
    ];

    if (options.targetAgent) {
      steps.push({
        planKey: 'delegate_execution',
        title: `Delegate execution to ${options.targetAgent}`,
        description: goal,
        type: 'sub_agent',
        target: options.targetAgent,
        input: { goal },
        dependsOn: ['prepare_context'],
        metadata: { harnessTag },
      });
    } else {
      steps.push({
        planKey: 'execute_goal',
        title: 'Execute approved goal',
        description: 'Execute the user goal in the leader harness using the available approved tools.',
        type: 'reasoning',
        input: { goal },
        dependsOn: ['prepare_context'],
        metadata: { harnessTag, controllerOnly: true },
      });
    }

    steps.push({
      planKey: 'verify_result',
      title: 'Verify result',
      description: 'Check that the completed work matches the approved goal and report evidence.',
      type: 'verification',
      input: { goal },
      dependsOn: [steps[steps.length - 1].planKey || 'execute_goal'],
      metadata: { harnessTag },
    });
    return steps;
  }
}
