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

const ORCHESTRATOR_CONTROLLER_MAX_STEPS = 100;

export class AgentPlanValidator {
  validate(plan: AgentLoopPlanStepInput[]) {
    if (!Array.isArray(plan) || plan.length === 0) {
      throw new Error('Plan must include at least one step.');
    }
    if (plan.length > ORCHESTRATOR_CONTROLLER_MAX_STEPS) {
      throw new Error(`Plan cannot exceed ${ORCHESTRATOR_CONTROLLER_MAX_STEPS} steps.`);
    }

    const keys = new Set<string>();
    const graph = new Map<string, string[]>();
    for (let i = 0; i < plan.length; i++) {
      const key = normalizePlanKey(plan[i], i).trim();
      if (!key) {
        throw new Error(`Plan step ${i + 1} has an empty planKey.`);
      }
      if (keys.has(key)) {
        throw new Error(`Duplicate planKey "${key}" in plan.`);
      }
      const type = normalizeStepType(plan[i].type);
      if (['tool', 'skill', 'sub_agent'].includes(type) && !plan[i].target) {
        throw new Error(`Step "${key}" of type "${type}" must include a target.`);
      }
      keys.add(key);
      graph.set(key, asArray(plan[i].dependsOn).map(String));
    }

    for (const [key, dependencies] of graph.entries()) {
      for (const dependency of dependencies) {
        if (!keys.has(dependency)) {
          throw new Error(`Step "${key}" depends on unknown step "${dependency}".`);
        }
        if (dependency === key) {
          throw new Error(`Step "${key}" cannot depend on itself.`);
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string) => {
      if (visited.has(key)) return;
      if (visiting.has(key)) {
        throw new Error(`Plan has a dependency cycle at "${key}".`);
      }
      visiting.add(key);
      for (const dependency of graph.get(key) || []) {
        visit(dependency);
      }
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of graph.keys()) {
      visit(key);
    }
  }
}
