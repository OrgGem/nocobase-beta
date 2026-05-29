import React from 'react';
import { Tabs } from 'antd';
import {
  ApartmentOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  HistoryOutlined,
  MonitorOutlined,
  ProfileOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { RulesTab } from './RulesTab';
import { TracingTab } from './TracingTab';
import { AgentRunsTab } from './AgentRunsTab';
import { HarnessProfilesTab } from './HarnessProfilesTab';
import { AIEmployeesProvider } from './AIEmployeesContext';
import { SkillManager, ExecutionHistory, SkillMetrics, LoopSettings } from './skill-hub';

const OrchestratorSettings: React.FC = () => {
  return (
    <AIEmployeesProvider>
      <div style={{ padding: '0 24px 24px' }}>
        <Tabs
          defaultActiveKey="rules"
          items={[
            {
              key: 'rules',
              label: (
                <span>
                  <ApartmentOutlined /> Orchestration Rules
                </span>
              ),
              children: <RulesTab />,
            },
            {
              key: 'tracing',
              label: (
                <span>
                  <MonitorOutlined /> Execution Tracing
                </span>
              ),
              children: <TracingTab />,
            },
            {
              key: 'agent-runs',
              label: (
                <span>
                  <ProfileOutlined /> Agent Runs
                </span>
              ),
              children: <AgentRunsTab />,
            },
            {
              key: 'harness-profiles',
              label: (
                <span>
                  <SettingOutlined /> Harness Profiles
                </span>
              ),
              children: <HarnessProfilesTab />,
            },
            {
              key: 'skill-definitions',
              label: (
                <span>
                  <CodeOutlined /> Skill Hub Definitions
                </span>
              ),
              children: <SkillManager />,
            },
            {
              key: 'skill-executions',
              label: (
                <span>
                  <HistoryOutlined /> Execution History
                </span>
              ),
              children: <ExecutionHistory />,
            },
            {
              key: 'skill-loop-settings',
              label: (
                <span>
                  <CheckCircleOutlined /> Skill Review Settings
                </span>
              ),
              children: <LoopSettings />,
            },
            {
              key: 'skill-metrics',
              label: (
                <span>
                  <BarChartOutlined /> Metrics
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
