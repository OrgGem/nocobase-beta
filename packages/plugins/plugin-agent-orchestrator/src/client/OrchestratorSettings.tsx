import React from 'react';
import { Tabs } from 'antd';
import { ApartmentOutlined, BarChartOutlined, CodeOutlined, HistoryOutlined, MonitorOutlined } from '@ant-design/icons';
import { RulesTab } from './RulesTab';
import { TracingTab } from './TracingTab';
import { AIEmployeesProvider } from './AIEmployeesContext';
import { SkillManager, ExecutionHistory, SkillMetrics } from './skill-hub';

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
