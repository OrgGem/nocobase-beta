import React from 'react';
import { Tabs } from 'antd';
import { TaskManager } from './TaskManager';
import { WorkflowExecutions } from './WorkflowExecutions';
import { ClusterNodes } from './ClusterNodes';
import { CacheMonitor } from './CacheMonitor';
import { ContainerOrchestrator } from './ContainerOrchestrator';
import { PackageInstaller } from './PackageInstaller';
import { useT } from './utils';

export function ClusterManagerLayout() {
  const t = useT();
  return (
    <div style={{ padding: 24 }}>
      <Tabs
        defaultActiveKey="cluster"
        items={[
          {
            key: 'cluster',
            label: t('Cluster Nodes'),
            children: <ClusterNodes />,
          },
          {
            key: 'tasks',
            label: t('Async Tasks'),
            children: <TaskManager />,
          },
          {
            key: 'executions',
            label: t('Workflow Executions'),
            children: <WorkflowExecutions />,
          },
          {
            key: 'cache',
            label: t('Cache Monitor'),
            children: <CacheMonitor />,
          },
          {
            key: 'orchestrator',
            label: t('Container Orchestrator'),
            children: <ContainerOrchestrator />,
          },
          {
            key: 'packages',
            label: t('Packages'),
            children: <PackageInstaller />,
          },
        ]}
      />
    </div>
  );
}
