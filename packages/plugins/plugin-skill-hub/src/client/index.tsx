import { Plugin } from '@nocobase/client';
import { SkillManager } from './components/SkillManager';
import { ExecutionHistory } from './components/ExecutionHistory';
import { WorkerSetup } from './components/WorkerSetup';
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
    this.app.use(InteractionSchemasProvider);

    this.app.pluginSettingsManager.add('skill-hub', {
      title: this.t('Skill Hub'),
      icon: 'CodeOutlined',
    });

    this.app.pluginSettingsManager.add('skill-hub.definitions', {
      title: this.t('Skill Definitions'),
      Component: SkillManager,
      aclSnippet: 'pm.skill-hub',
    });

    this.app.pluginSettingsManager.add('skill-hub.executions', {
      title: this.t('Execution History'),
      Component: ExecutionHistory,
      aclSnippet: 'pm.skill-hub',
    });

    this.app.pluginSettingsManager.add('skill-hub.metrics', {
      title: this.t('Dashboard Metrics'),
      Component: SkillMetrics,
      aclSnippet: 'pm.skill-hub',
    });

    this.app.pluginSettingsManager.add('skill-hub.worker-setup', {
      title: this.t('Worker Setup'),
      Component: WorkerSetup,
      aclSnippet: 'pm.skill-hub',
    });

    await this.registerSkillUiCards();
  }

  private async registerSkillUiCards() {
    const toolsManager = this.app.aiManager?.toolsManager;
    if (!toolsManager) return;

    try {
      const { data } = await this.app.apiClient.request({
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

export default PluginSkillHubClient;
