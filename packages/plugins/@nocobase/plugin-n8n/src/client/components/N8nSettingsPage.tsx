import React from 'react';
import { Tabs, Select, Space, Typography } from 'antd';
import { InstanceProvider, useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';
import { InstanceManager } from './InstanceManager';
import { WorkflowList } from './WorkflowList';
import { ExecutionList } from './ExecutionList';
import { VariableManager } from './VariableManager';
import { CredentialManager } from './CredentialManager';
import { Dashboard } from './Dashboard';
import { MetricsPanel } from './MetricsPanel';
import { WorkerStatus } from './WorkerStatus';
import { AlertManager } from './AlertManager';

const InstanceSelector: React.FC = () => {
  const { instanceId, setInstanceId, instances, loading } = useCurrentInstance();
  const t = useT();

  if (instances.length <= 1) return null;
  return (
    <Space style={{ marginBottom: 16 }}>
      <Typography.Text strong>{t('Instance')}:</Typography.Text>
      <Select
        value={instanceId}
        onChange={setInstanceId}
        loading={loading}
        style={{ minWidth: 200 }}
        options={instances.map((i: any) => ({
          label: `${i.name} (${i.environment})`,
          value: i.id,
        }))}
      />
    </Space>
  );
};

const N8nSettingsContent: React.FC = () => {
  const t = useT();

  const items = [
    { key: 'dashboard', label: t('Dashboard'), children: <Dashboard /> },
    { key: 'workflows', label: t('Workflows'), children: <WorkflowList /> },
    { key: 'executions', label: t('Executions'), children: <ExecutionList /> },
    { key: 'variables', label: t('Variables'), children: <VariableManager /> },
    { key: 'credentials', label: t('Credentials'), children: <CredentialManager /> },
    {
      key: 'monitoring',
      label: t('Metrics & Workers'),
      children: (
        <>
          <MetricsPanel />
          <WorkerStatus />
        </>
      ),
    },
    { key: 'alerts', label: t('Alerts'), children: <AlertManager /> },
    { key: 'instances', label: t('Instances'), children: <InstanceManager /> },
  ];

  return (
    <div>
      <InstanceSelector />
      <Tabs items={items} />
    </div>
  );
};

export const N8nSettingsPage: React.FC = () => {
  return (
    <InstanceProvider>
      <N8nSettingsContent />
    </InstanceProvider>
  );
};
