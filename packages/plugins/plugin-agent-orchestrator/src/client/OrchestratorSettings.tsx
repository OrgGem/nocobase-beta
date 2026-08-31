import React from 'react';
import { Tabs } from 'antd';
import {
  ApiOutlined,
  AuditOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  MonitorOutlined,
  NodeIndexOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { TracingTab } from '../client-v2/components/TracingTab';
import { AgentBindingsTab } from '../client-v2/components/AgentBindingsTab';
import { KnowledgeAccessTab } from '../client-v2/components/KnowledgeAccessTab';
import { RetrievalTraceTab } from '../client-v2/components/RetrievalTraceTab';
import { MemoryInspectorTab } from '../client-v2/components/MemoryInspectorTab';
import { AgentRunsTab } from './AgentRunsTab';
import { HarnessProfilesTab } from './HarnessProfilesTab';
import { ApprovalsTab } from './ApprovalsTab';
import { AIEmployeesProvider } from '../client-v2/components/AIEmployeesContext';
import { useT } from './skill-hub/locale';
import { SkillManager, ExecutionHistory, SkillMetrics, LoopSettings } from './skill-hub';

const OrchestratorSettings: React.FC<{ embedded?: boolean }> = ({ embedded } = {}) => {
  const t = useT();

  return (
    <AIEmployeesProvider>
      <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
        <Tabs
          defaultActiveKey="native-monitor"
          items={[
            {
              key: 'native-monitor',
              label: (
                <span>
                  <MonitorOutlined /> {t('Native Monitor')}
                </span>
              ),
              children: <AgentRunsTab />,
            },
            {
              key: 'tracing',
              label: (
                <span>
                  <MonitorOutlined /> {t('Execution Tracing')}
                </span>
              ),
              children: <TracingTab />,
            },
            {
              key: 'harness-profiles',
              label: (
                <span>
                  <SettingOutlined /> {t('Policy Profiles')}
                </span>
              ),
              children: <HarnessProfilesTab />,
            },
            {
              key: 'approvals',
              label: (
                <span>
                  <AuditOutlined /> {t('Approvals')}
                </span>
              ),
              children: <ApprovalsTab />,
            },
            {
              key: 'agent-bindings',
              label: (
                <span>
                  <TeamOutlined /> {t('Agent Bindings')}
                </span>
              ),
              children: <AgentBindingsTab />,
            },
            {
              key: 'knowledge-access',
              label: (
                <span>
                  <ApiOutlined /> {t('Knowledge Access')}
                </span>
              ),
              children: <KnowledgeAccessTab />,
            },
            {
              key: 'retrieval-trace',
              label: (
                <span>
                  <NodeIndexOutlined /> {t('Retrieval Trace')}
                </span>
              ),
              children: <RetrievalTraceTab />,
            },
            {
              key: 'memory-inspector',
              label: (
                <span>
                  <DatabaseOutlined /> {t('Memory Inspector')}
                </span>
              ),
              children: <MemoryInspectorTab />,
            },
            {
              key: 'skill-definitions',
              label: (
                <span>
                  <CodeOutlined /> {t('Skill Hub Definitions')}
                </span>
              ),
              children: <SkillManager />,
            },
            {
              key: 'skill-executions',
              label: (
                <span>
                  <HistoryOutlined /> {t('Execution History')}
                </span>
              ),
              children: <ExecutionHistory />,
            },
            {
              key: 'skill-loop-settings',
              label: (
                <span>
                  <CheckCircleOutlined /> {t('Skill Review Settings')}
                </span>
              ),
              children: <LoopSettings />,
            },
            {
              key: 'skill-metrics',
              label: (
                <span>
                  <BarChartOutlined /> {t('Metrics')}
                </span>
              ),
              children: <SkillMetrics />,
            },
          ]}
        />
      </div>
    </AIEmployeesProvider>
  );
};

export { OrchestratorSettings };
