import { toPlain, asObject, normalizeEmployeeUsername } from '../utils/ctx-utils';

type OrchestratorConfigRow = {
  leaderUsername?: string;
  subAgentUsername?: string;
};

type ModelRef = { llmService: string; model: string };

/**
 * Normalize an AI employee's `modelSettings` (or a per-rule override) into a
 * flat { llmService, model } the harness can hand to getLLMService().
 *
 * The admin UI (plugin-ai ModelSettings) stores the dedicated model selection
 * as `{ enabled, models: [{ llmService, model }] }` and clears the flat
 * `llmService`/`model` fields. Older records still use the flat shape, and
 * per-rule overrides arrive flat too. Mirror plugin-ai's resolveModel:
 *   - if `enabled`, prefer `models[0]`, else fall back to the flat fields
 *   - a bare flat { llmService, model } (e.g. a rule override) is also valid
 */
function extractModelRef(value: any): ModelRef | undefined {
  if (!value) return undefined;

  const isValid = (m: any): m is ModelRef => Boolean(m?.llmService && m?.model);

  // Dedicated model configuration (UI shape).
  if (value.enabled) {
    const models = Array.isArray(value.models) ? value.models : [];
    const first = models.find(isValid);
    if (first) {
      return { llmService: first.llmService, model: first.model };
    }
  }

  // Flat legacy shape, or a per-rule override.
  if (isValid(value)) {
    return { llmService: value.llmService, model: value.model };
  }

  return undefined;
}

function sanitizeToolPart(value: string) {
  return (value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildDelegateToolName(leaderUsername: string, subAgentUsername: string) {
  return `delegate_${sanitizeToolPart(leaderUsername)}_to_${sanitizeToolPart(subAgentUsername)}`;
}

function buildDispatchToolName(leaderUsername: string) {
  return `dispatch_subagents_${sanitizeToolPart(leaderUsername)}`;
}

function buildLegacyDelegateToolName(subAgentUsername: string) {
  return `delegate_to_${sanitizeToolPart(subAgentUsername)}`;
}

export class AgentRegistryService {
  constructor(private readonly plugin: any) {}

  get db() {
    return this.plugin.db;
  }

  async getHarnessProfile(tag: string) {
    try {
      const repo = this.db.getRepository('agentHarnessProfiles');
      if (!repo) return null;
      const profile = await repo.findOne({
        filter: {
          tag: tag || 'default',
          enabled: true,
        },
      });
      return profile ? toPlain(profile) : null;
    } catch {
      return null;
    }
  }

  async getOrchestratorConfig(leaderUsername: string, subAgentUsername: string) {
    try {
      const repo = this.db.getRepository('orchestratorConfig');
      if (!repo) return null;
      const config = await repo.findOne({
        filter: {
          leaderUsername,
          subAgentUsername,
          enabled: true,
        },
      });
      return config ? toPlain(config) : null;
    } catch {
      return null;
    }
  }

  async getAIEmployee(username: string) {
    try {
      const repo = this.db.getRepository('aiEmployees');
      if (!repo) return null;
      const employee = await repo.findOne({
        filter: { username },
      });
      return employee ? toPlain(employee) : null;
    } catch {
      return null;
    }
  }

  async resolveModelSettings(subAgentUsername: string, leaderUsername?: string, dynamicValues?: any) {
    const subAgent = await this.getAIEmployee(subAgentUsername);
    if (!subAgent) {
      throw new Error(`Sub-agent "${subAgentUsername}" was not found.`);
    }

    // 1. Explicit per-rule override (already a flat { llmService, model }).
    const dynamic = extractModelRef(dynamicValues);
    if (dynamic) {
      return dynamic;
    }

    // 2. Sub-agent's own dedicated model configuration.
    const subAgentModel = extractModelRef(subAgent.modelSettings);
    if (subAgentModel) {
      return subAgentModel;
    }

    // 3. Inherit from leader.
    if (leaderUsername) {
      const leader = await this.getAIEmployee(leaderUsername);
      const leaderModel = extractModelRef(leader?.modelSettings);
      if (leaderModel) {
        return leaderModel;
      }
    }

    return undefined;
  }

  /**
   * Find alternative sub-agents for the same leader, excluding a specific one.
   * Used by the smart retry feature to route around a failing sub-agent.
   */
  async findAlternativeSubAgents(
    leaderUsername: string,
    excludeSubAgentUsername: string,
  ): Promise<{ username: string; label: string }[]> {
    try {
      const repo = this.db.getRepository('orchestratorConfig');
      if (!repo) return [];
      const configs = await repo.find({
        filter: {
          leaderUsername,
          enabled: true,
          subAgentUsername: { $ne: excludeSubAgentUsername },
        },
      });
      if (!configs || configs.length === 0) return [];

      // Enrich with AI employee display names
      const result: { username: string; label: string }[] = [];
      for (const config of configs) {
        const plain = toPlain(config);
        const employee = await this.getAIEmployee(plain.subAgentUsername);
        result.push({
          username: plain.subAgentUsername,
          label: employee?.nickname || employee?.username || plain.subAgentUsername,
        });
      }
      return result;
    } catch {
      return [];
    }
  }

  async isRegisteredDelegationTool(toolName: string): Promise<boolean> {
    if (!toolName || typeof toolName !== 'string') return false;
    if (!toolName.startsWith('delegate_') && !toolName.startsWith('dispatch_subagents_')) {
      return false;
    }

    try {
      const configRepo = this.db.getRepository('orchestratorConfig');
      if (!configRepo) return false;

      const configs: OrchestratorConfigRow[] = await configRepo.find({
        filter: { enabled: true },
      });
      if (!configs || configs.length === 0) return false;

      // 1. Check if it matches dispatch_subagents_${leader}
      if (toolName.startsWith('dispatch_subagents_')) {
        return configs.some((config) => buildDispatchToolName(config.leaderUsername || '') === toolName);
      }

      // 2. Check legacy alias: delegate_to_${subAgent}
      if (toolName.startsWith('delegate_to_')) {
        const matchingConfigs = configs.filter(
          (config) => buildLegacyDelegateToolName(config.subAgentUsername || '') === toolName,
        );
        if (matchingConfigs.length === 1) {
          return true;
        }
      }

      // 3. Check if it matches delegate_${leader}_to_${subAgent}
      if (toolName.startsWith('delegate_') && toolName.includes('_to_')) {
        return configs.some(
          (config) => buildDelegateToolName(config.leaderUsername || '', config.subAgentUsername || '') === toolName,
        );
      }

      return false;
    } catch {
      return false;
    }
  }
}
