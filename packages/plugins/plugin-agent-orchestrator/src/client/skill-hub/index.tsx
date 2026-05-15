import { Plugin } from '@nocobase/client';
import { SkillManager } from './components/SkillManager';
import { ExecutionHistory } from './components/ExecutionHistory';

import { SkillMetrics } from './components/SkillMetrics';
import { InteractionSchemasProvider } from './tools/InteractionSchemasProvider';
import { SkillHubCard } from './tools/SkillHubCard';
import { parseJsonText } from './utils/jsonFields';

const sanitize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

export class PluginSkillHubClient extends Plugin {
  async load() {
    (this as any).app.use(InteractionSchemasProvider);

    (this as any).app.pluginSettingsManager.add('skill-hub', {
      title: (this as any).t('Skill Hub'),
      icon: 'CodeOutlined',
    });

    (this as any).app.pluginSettingsManager.add('skill-hub.definitions', {
      title: (this as any).t('Skill Definitions'),
      Component: SkillManager,
      aclSnippet: 'pm.skill-hub',
    });

    (this as any).app.pluginSettingsManager.add('skill-hub.executions', {
      title: (this as any).t('Execution History'),
      Component: ExecutionHistory,
      aclSnippet: 'pm.skill-hub',
    });

    (this as any).app.pluginSettingsManager.add('skill-hub.metrics', {
      title: (this as any).t('Dashboard Metrics'),
      Component: SkillMetrics,
      aclSnippet: 'pm.skill-hub',
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

export { SkillManager, ExecutionHistory, SkillMetrics };
export default PluginSkillHubClient;
