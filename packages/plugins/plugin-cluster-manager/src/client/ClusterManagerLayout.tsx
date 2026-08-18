import React from 'react';
import { Tabs } from 'antd';
import { TaskManager } from './TaskManager';
import { WorkflowExecutions } from './WorkflowExecutions';
import { ClusterNodes } from './ClusterNodes';
import { CacheMonitor } from './CacheMonitor';
import { ContainerOrchestrator } from './ContainerOrchestrator';
import { PackageInstaller } from './PackageInstaller';
import { PluginOperations } from './PluginOperations';
import { Doctor } from './Doctor';
import { QueueAssignment } from './QueueAssignment';
import WorkerTemplateVariables from './WorkerTemplateVariables';
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
          {
            key: 'plugins',
            label: t('Plugins'),
            children: <PluginOperations />,
          },
          {
            key: 'doctor',
            label: t('Doctor'),
            children: <Doctor />,
          },
          {
            key: 'queues',
            label: t('Queue Assignment'),
            children: <QueueAssignment />,
          },
          {
            key: 'worker-template',
            label: t('Worker template'),
            children: <WorkerTemplateVariables />,
          },
        ]}
      />
    </div>
  );
}
