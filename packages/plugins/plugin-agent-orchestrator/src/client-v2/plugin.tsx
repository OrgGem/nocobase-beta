import { Plugin, Application } from '@nocobase/client-v2';

export class PluginAgentOrchestratorClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai.orchestrator',
      title: this.t('Agent Orchestrator'),
      icon: 'ApartmentOutlined',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'index',
      title: this.t('Orchestration Rules'),
      componentLoader: () => import('./pages/RulesPage'),
      sort: -1,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'tracing',
      title: this.t('Execution Tracing'),
      componentLoader: () => import('./pages/TracingPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'agent-runs',
      title: this.t('Agent Runs'),
      componentLoader: () => import('./pages/AgentRunsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'harness-profiles',
      title: this.t('Harness Profiles'),
      componentLoader: () => import('./pages/HarnessProfilesPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'skill-definitions',
      title: this.t('Skill Hub Definitions'),
      componentLoader: () => import('./pages/SkillDefinitionsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'skill-executions',
      title: this.t('Execution History'),
      componentLoader: () => import('./pages/ExecutionHistoryPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'skill-loop-settings',
      title: this.t('Skill Review Settings'),
      componentLoader: () => import('./pages/LoopSettingsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'skill-metrics',
      title: this.t('Metrics'),
      componentLoader: () => import('./pages/SkillMetricsPage'),
    });
  }
}

export default PluginAgentOrchestratorClient;
