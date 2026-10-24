import { Plugin, Application } from '@nocobase/client-v2';
import { InteractionSchemasProvider, registerSkillCard } from './skill-hub/tools/InteractionSchemasProvider';

export class PluginAgentOrchestratorClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.app.use(InteractionSchemasProvider);
    registerSkillCard(this.ai.toolsManager, 'skill_hub_execute');
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-orchestrator',
      title: this.t('Agent Orchestrator'),
      icon: 'ApartmentOutlined',
      aclSnippet: 'pm.plugin-agent-orchestrator',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'index',
      title: this.t('Native Monitor'),
      componentLoader: () => import('./pages/RulesPage'),
      sort: -1,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'tracing',
      title: this.t('Execution Tracing'),
      componentLoader: () => import('./pages/TracingPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'harness-profiles',
      title: this.t('Policy Profiles'),
      componentLoader: () => import('./pages/HarnessProfilesPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'approvals',
      title: this.t('Approvals'),
      componentLoader: () => import('./pages/ApprovalsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'agent-bindings',
      title: this.t('Agent Bindings'),
      componentLoader: () => import('./pages/AgentBindingsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'knowledge-access',
      title: this.t('Knowledge Access'),
      componentLoader: () => import('./pages/KnowledgeAccessPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'retrieval-trace',
      title: this.t('Retrieval Trace'),
      componentLoader: () => import('./pages/RetrievalTracePage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'memory-inspector',
      title: this.t('Memory Inspector'),
      componentLoader: () => import('./pages/MemoryInspectorPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'skill-definitions',
      title: this.t('Skill Hub Definitions'),
      componentLoader: () => import('./pages/SkillDefinitionsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'skill-executions',
      title: this.t('Execution History'),
      componentLoader: () => import('./pages/ExecutionHistoryPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'skill-loop-settings',
      title: this.t('Skill Review Settings'),
      componentLoader: () => import('./pages/LoopSettingsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-orchestrator',
      aclSnippet: 'pm.plugin-agent-orchestrator',
      key: 'skill-metrics',
      title: this.t('Metrics'),
      componentLoader: () => import('./pages/SkillMetricsPage'),
    });
  }
}

export default PluginAgentOrchestratorClient;
