import { Plugin } from '@nocobase/client';
import { SkillManager } from './components/SkillManager';
import { ExecutionHistory } from './components/ExecutionHistory';
import { WorkerSetup } from './components/WorkerSetup';
import { SkillMetrics } from './components/SkillMetrics';

export class PluginSkillHubClient extends Plugin {
  async load() {
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
  }
}

export default PluginSkillHubClient;

