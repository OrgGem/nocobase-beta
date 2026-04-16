import React from 'react';
import { Tabs } from 'antd';
import { useApp } from '@nocobase/client';
import { TaskManager } from './TaskManager';
import { WorkflowExecutions } from './WorkflowExecutions';
import { RedisMonitor } from './RedisMonitor';
import { AclCacheManager } from './AclCacheManager';

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
        defaultActiveKey="tasks"
        items={[
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
            key: 'redis',
            label: t('Redis Monitor'),
            children: <RedisMonitor />,
          },
          {
            key: 'acl-cache',
            label: t('ACL Cache'),
            children: <AclCacheManager />,
          },
        ]}
      />
    </div>
  );
}
