import { toPlain, asObject, normalizeEmployeeUsername } from '../utils/ctx-utils';

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

    const hasModelSettings = (val: any): val is { llmService: string; model: string } => {
      return Boolean(val?.llmService && val?.model);
    };

    let modelSettings = hasModelSettings(dynamicValues) ? dynamicValues : undefined;

    if (!modelSettings) {
      if (hasModelSettings(subAgent.modelSettings)) {
        modelSettings = subAgent.modelSettings;
      }
    }

    if (!modelSettings && leaderUsername) {
      const leader = await this.getAIEmployee(leaderUsername);
      if (leader && hasModelSettings(leader.modelSettings)) {
        modelSettings = leader.modelSettings;
      }
    }

    return modelSettings;
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

      // 1. Check if it matches dispatch_subagents_${leader}
      if (toolName.startsWith('dispatch_subagents_')) {
        const leader = toolName.substring('dispatch_subagents_'.length);
        const count = await configRepo.count({
          filter: {
            leaderUsername: leader,
            enabled: true,
          },
        });
        return count > 0;
      }

      // 2. Check if it matches delegate_${leader}_to_${subAgent}
      if (toolName.startsWith('delegate_') && toolName.includes('_to_')) {
        const parts = toolName.substring('delegate_'.length).split('_to_');
        if (parts.length === 2) {
          const [leader, subAgent] = parts;
          const count = await configRepo.count({
            filter: {
              leaderUsername: leader,
              subAgentUsername: subAgent,
              enabled: true,
            },
          });
          if (count > 0) return true;
        }
      }

      // 3. Check legacy alias: delegate_to_${subAgent}
      if (toolName.startsWith('delegate_to_')) {
        const subAgent = toolName.substring('delegate_to_'.length);
        const configs = await configRepo.find({
          filter: {
            subAgentUsername: subAgent,
            enabled: true,
          },
        });
        // Legacy alias is only registered if there is exactly one leader for this subAgent
        if (configs?.length === 1) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }
}
