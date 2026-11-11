/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, lazy } from '@nocobase/client';
import { ExecutionHistoryPage, LoopSettingsPage, SkillDefinitionsPage, SkillMetricsPage } from './SkillPages';
import { InteractionSchemasProvider } from './skill-hub/tools/InteractionSchemasProvider';
import { registerSkillLoopCards } from './skill-hub/tools/registerSkillLoopCards';

const RulesPage = lazy(() => import('../client-v2/pages/RulesPage'));
const TracingPage = lazy(() => import('../client-v2/pages/TracingPage'));
const UsageGovernancePage = lazy(() => import('../client-v2/pages/UsageGovernancePage'));
const EmployeeGovernancePage = lazy(() => import('../client-v2/pages/EmployeeGovernancePage'));
const HarnessProfilesPage = lazy(() => import('../client-v2/pages/HarnessProfilesPage'));
const ApprovalsPage = lazy(() => import('../client-v2/pages/ApprovalsPage'));
const AgentBindingsPage = lazy(() => import('../client-v2/pages/AgentBindingsPage'));
const KnowledgeAccessPage = lazy(() => import('../client-v2/pages/KnowledgeAccessPage'));
const RetrievalTracePage = lazy(() => import('../client-v2/pages/RetrievalTracePage'));
const MemoryInspectorPage = lazy(() => import('../client-v2/pages/MemoryInspectorPage'));

export class PluginAgentOrchestratorClient extends Plugin {
  async load() {
    (this as any).app.use(InteractionSchemasProvider);

    this.app.pluginSettingsManager.add('ai-orchestrator', {
      title: this.t('Agent Orchestrator'),
      icon: 'ApartmentOutlined',
      aclSnippet: 'pm.ai-orchestrator',
    });

    const pages = [
      { key: 'index', title: this.t('Native Monitor'), Component: RulesPage },
      { key: 'tracing', title: this.t('Execution Tracing'), Component: TracingPage },
      { key: 'usage-governance', title: this.t('Usage and cost'), Component: UsageGovernancePage },
      { key: 'employee-governance', title: this.t('Employee governance'), Component: EmployeeGovernancePage },
      { key: 'harness-profiles', title: this.t('Policy Profiles'), Component: HarnessProfilesPage },
      { key: 'approvals', title: this.t('Approvals'), Component: ApprovalsPage },
      { key: 'agent-bindings', title: this.t('Agent Bindings'), Component: AgentBindingsPage },
      { key: 'knowledge-access', title: this.t('Knowledge Access'), Component: KnowledgeAccessPage },
      { key: 'retrieval-trace', title: this.t('Retrieval Trace'), Component: RetrievalTracePage },
      { key: 'memory-inspector', title: this.t('Memory Inspector'), Component: MemoryInspectorPage },
      { key: 'skill-definitions', title: this.t('Skill Hub Definitions'), Component: SkillDefinitionsPage },
      { key: 'skill-executions', title: this.t('Execution History'), Component: ExecutionHistoryPage },
      { key: 'skill-loop-settings', title: this.t('Skill Review Settings'), Component: LoopSettingsPage },
      { key: 'skill-metrics', title: this.t('Metrics'), Component: SkillMetricsPage },
    ];
    pages.forEach(({ key, title, Component }, sort) => {
      this.app.pluginSettingsManager.add(`ai-orchestrator.${key}`, {
        title,
        Component,
        sort,
        aclSnippet: 'pm.ai-orchestrator',
      });
    });

    (this as any).app.eventBus?.addEventListener?.('auth:tokenChanged', (event: Event) => {
      const token = (event as CustomEvent<{ token?: string | null }>).detail?.token;
      if (token) {
        registerSkillLoopCards((this as any).app);
      }
    });

    await this.registerSkillUiCards();
  }

  private async registerSkillUiCards() {
    await registerSkillLoopCards((this as any).app);
  }
}

export default PluginAgentOrchestratorClient;
