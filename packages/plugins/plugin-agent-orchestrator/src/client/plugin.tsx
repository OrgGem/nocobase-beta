import { Plugin } from '@nocobase/client';
import { OrchestratorSettings } from './OrchestratorSettings';

import { InteractionSchemasProvider } from './skill-hub/tools/InteractionSchemasProvider';
import { SkillHubCard } from './skill-hub/tools/SkillHubCard';
import { parseJsonText } from './skill-hub/utils/jsonFields';

const sanitize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

export class PluginAgentOrchestratorClient extends Plugin {
  async load() {
    (this as any).app.use(InteractionSchemasProvider);

    // Register under the "AI" settings group for consistency with other AI plugins
    (this as any).app.pluginSettingsManager.add('ai.orchestrator', {
      title: 'Agent Orchestrator',
      icon: 'ApartmentOutlined',
      Component: OrchestratorSettings,
    });

    await this.registerSkillUiCards();
  }

  private async registerSkillUiCards() {
    const toolsManager = (this as any).app.aiManager?.toolsManager;
    if (!toolsManager) return;

    try {
      const { data } = await (this as any).app.apiClient.request({
        url: 'skillDefinitions:list',
        params: {
          filter: { enabled: true },
          fields: ['name', 'autoCall', 'interactionSchema'],
          pageSize: 200,
        },
      });
      const list = (data as any)?.data ?? [];
      for (const s of list) {
        if (s.autoCall) continue;
        if (!parseJsonText(s.interactionSchema, null)) continue;
        toolsManager.registerTools(`skill_hub_${sanitize(s.name)}`, { ui: { card: SkillHubCard } });
      }
    } catch {
      // user without ACL or backend unavailable — skip silently
    }
  }
}

export default PluginAgentOrchestratorClient;
