export type EmployeeToolBinding = {
  name: string;
  autoCall?: boolean;
};

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isOrchestratorToolName(name: string) {
  return (
    name === 'dispatch-sub-agent-task' ||
    name === 'external_rag_search' ||
    name === 'skill_hub_execute' ||
    name.startsWith('skill_hub_') ||
    name.startsWith('browser_') ||
    name.startsWith('drawio-')
  );
}

export function isRetiredOrchestratorToolName(name: string) {
  return (
    name === 'orchestrator_plan_goal' ||
    name === 'orchestrator_execute_plan' ||
    name === 'orchestrator_status' ||
    name === 'orchestrator_cancel' ||
    name.startsWith('delegate_') ||
    name.startsWith('dispatch_subagents_')
  );
}

function toToolBinding(value: unknown): EmployeeToolBinding | null {
  if (typeof value === 'string') {
    const name = value.trim();
    return name ? { name, autoCall: false } : null;
  }
  if (!isRecord(value) || typeof value.name !== 'string') {
    return null;
  }
  const name = value.name.trim();
  if (!name) {
    return null;
  }
  return {
    name,
    autoCall: value.autoCall === true,
  };
}

function addToolBinding(toolsByName: Map<string, EmployeeToolBinding>, binding: EmployeeToolBinding | null) {
  if (!binding) return;
  if (!toolsByName.has(binding.name)) {
    toolsByName.set(binding.name, binding);
  }
}

export function normalizeAIEmployeeSkillSettings(value: unknown): {
  changed: boolean;
  skillSettings: RecordLike & { skills: string[]; tools: EmployeeToolBinding[] };
} {
  const source = isRecord(value) ? value : {};
  const toolsByName = new Map<string, EmployeeToolBinding>();
  const nextSkills: string[] = [];
  let changed = false;

  const sourceTools = source.tools;
  if (Array.isArray(sourceTools)) {
    for (const item of sourceTools) {
      const binding = toToolBinding(item);
      if (binding) {
        if (isRetiredOrchestratorToolName(binding.name)) {
          changed = true;
          continue;
        }
        addToolBinding(toolsByName, binding);
        if (typeof item === 'string') {
          changed = true;
        }
      } else {
        changed = true;
      }
    }
  }

  const sourceSkills = source.skills;
  if (Array.isArray(sourceSkills)) {
    for (const item of sourceSkills) {
      if (typeof item === 'string') {
        const name = item.trim();
        if (!name) {
          changed = true;
          continue;
        }
        if (isRetiredOrchestratorToolName(name)) {
          changed = true;
          continue;
        }
        if (isOrchestratorToolName(name)) {
          addToolBinding(toolsByName, { name, autoCall: false });
          changed = true;
          continue;
        }
        nextSkills.push(name);
        if (name !== item) {
          changed = true;
        }
        continue;
      }

      const legacyToolBinding = toToolBinding(item);
      if (legacyToolBinding) {
        if (isRetiredOrchestratorToolName(legacyToolBinding.name)) {
          changed = true;
          continue;
        }
        addToolBinding(toolsByName, legacyToolBinding);
      }
      changed = true;
    }
  }

  const normalized = {
    ...source,
    skills: nextSkills,
    tools: Array.from(toolsByName.values()),
  };

  return {
    changed,
    skillSettings: normalized,
  };
}
