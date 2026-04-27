import React from 'react';
import { Tabs } from 'antd';
import { ApartmentOutlined, MonitorOutlined } from '@ant-design/icons';
import { RulesTab } from './RulesTab';
import { TracingTab } from './TracingTab';
import { AIEmployeesProvider } from './AIEmployeesContext';

export const OrchestratorSettings: React.FC = () => {
  return (
    <AIEmployeesProvider>
      <div style={{ padding: '0 24px 24px' }}>
        <Tabs 
          defaultActiveKey="rules"
          items={[
            {
              key: 'rules',
              label: <span><ApartmentOutlined /> Orchestration Rules</span>,
              children: <RulesTab />,
            },
            {
              key: 'tracing',
              label: <span><MonitorOutlined /> Swarm Tracing</span>,
              children: <TracingTab />,
            },
          ]}
        />
      </div>
    </AIEmployeesProvider>
  );
};
