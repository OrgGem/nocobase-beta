import { AgentLoopPlanStepInput } from './AgentLoopService';

import { normalizeStepType, normalizePlanKey, asArray, asObject } from '../utils/ctx-utils';

/**
 * Deterministic, template-based plan builder. This service does NOT call an LLM:
 * it either passes through a caller-provided plan or emits a fixed
 * prepare → (delegate|execute) → verify skeleton.
 *
 * The run's `plannerModel` field is metadata only (records which model an
 * upstream caller used to author a provided plan); it does not drive any
 * generation here. If LLM-authored planning is added later, it belongs in a
 * separate path — keep this builder deterministic so it stays test-stable.
 */
export class AgentPlannerService {
  buildPlan(
    goal: string,
    plan: AgentLoopPlanStepInput[] | undefined,
    options: { targetAgent?: string; harnessTag?: string; metadata?: any },
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
