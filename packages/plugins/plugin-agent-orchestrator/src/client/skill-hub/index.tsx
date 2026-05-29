import { Plugin } from '@nocobase/client';
import { SkillManager } from './components/SkillManager';
import { ExecutionHistory } from './components/ExecutionHistory';
import { SkillMetrics } from './components/SkillMetrics';
import { LoopSettings } from './components/LoopSettings';
import { InteractionSchemasProvider } from './tools/InteractionSchemasProvider';
import { registerSkillLoopCards } from './tools/registerSkillLoopCards';

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

    (this as any).app.pluginSettingsManager.add('skill-hub.loop-settings', {
      title: (this as any).t('Skill Review Settings'),
      Component: LoopSettings,
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
    await registerSkillLoopCards((this as any).app);
  }
}

export { SkillManager, ExecutionHistory, SkillMetrics, LoopSettings };
export default PluginSkillHubClient;
