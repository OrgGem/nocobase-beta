import React from 'react';
import { Tabs } from 'antd';
// removed PageHeader import
import { ServiceConfigTab } from './ServiceConfigTab';
import { EndpointsTab } from './EndpointsTab';
import { PipelinesTab } from './PipelinesTab';
import { JobsTab } from './JobsTab';

export const PluginSettings = () => {
  return (
    <div style={{ backgroundColor: 'var(--nb-box-bg)', minHeight: '100vh' }}>
      <div style={{ padding: '16px 24px', backgroundColor: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>Document Understanding - Pipeline Orchestrator</h2>
      </div>
      <div style={{ padding: '0 24px 24px' }}>
        <Tabs
          defaultActiveKey="config"
          items={[
            {
              key: 'config',
              label: 'Service Config',
              children: <ServiceConfigTab />,
            },
            {
              key: 'endpoints',
              label: 'Endpoints',
              children: <EndpointsTab />,
            },
            {
              key: 'pipelines',
              label: 'Pipelines',
              children: <PipelinesTab />,
            },
            {
              key: 'jobs',
              label: 'Jobs history',
              children: <JobsTab />,
            },
          ]}
        />
      </div>
    </div>
  );
};
