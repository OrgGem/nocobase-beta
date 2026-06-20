import React from 'react';
import { Tabs } from 'antd';
import {
  BarChartOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  HistoryOutlined,
  MonitorOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { TracingTab } from '../client-v2/components/TracingTab';
import { AgentRunsTab } from './AgentRunsTab';
import { HarnessProfilesTab } from './HarnessProfilesTab';
import { AIEmployeesProvider } from '../client-v2/components/AIEmployeesContext';
import { useT } from './skill-hub/locale';
import { SkillManager, ExecutionHistory, SkillMetrics, LoopSettings } from './skill-hub';

const OrchestratorSettings: React.FC = () => {
  const t = useT();

  return (
    <AIEmployeesProvider>
      <div style={{ padding: '0 24px 24px' }}>
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
