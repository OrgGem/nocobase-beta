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
      title: this.t('Native Monitor'),
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
      title: this.t('Native Agent Runs'),
      componentLoader: () => import('./pages/AgentRunsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'harness-profiles',
      title: this.t('Policy Profiles'),
      componentLoader: () => import('./pages/HarnessProfilesPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'agent-bindings',
      title: this.t('Agent Bindings'),
      componentLoader: () => import('./pages/AgentBindingsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'knowledge-access',
      title: this.t('Knowledge Access'),
      componentLoader: () => import('./pages/KnowledgeAccessPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'retrieval-trace',
      title: this.t('Retrieval Trace'),
      componentLoader: () => import('./pages/RetrievalTracePage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai.orchestrator',
      key: 'memory-inspector',
      title: this.t('Memory Inspector'),
      componentLoader: () => import('./pages/MemoryInspectorPage'),
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
