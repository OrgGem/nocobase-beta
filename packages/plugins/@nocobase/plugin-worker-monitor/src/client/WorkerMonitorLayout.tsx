import React from 'react';
import { Tabs } from 'antd';
import { useApp } from '@nocobase/client';
import { TaskManager } from './TaskManager';
import { WorkflowExecutions } from './WorkflowExecutions';
import { RedisMonitor } from './RedisMonitor';
import { ClusterNodes } from './ClusterNodes';
import { EventQueueMonitor } from './EventQueueMonitor';
import { LockMonitor } from './LockMonitor';
import { CacheMonitor } from './CacheMonitor';

const namespace = 'worker-monitor';

function useT() {
  const app = useApp();
  return (key: string) => app.i18n.t(key, { ns: namespace });
}

export function WorkerMonitorLayout() {
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
            key: 'queue',
            label: t('Event Queue'),
            children: <EventQueueMonitor />,
          },
          {
            key: 'redis',
            label: t('Redis Monitor'),
            children: <RedisMonitor />,
          },
          {
            key: 'locks',
            label: t('Locks'),
            children: <LockMonitor />,
          },
          {
            key: 'cache',
            label: t('Cache Monitor'),
            children: <CacheMonitor />,
          },
        ]}
      />
    </div>
  );
}
