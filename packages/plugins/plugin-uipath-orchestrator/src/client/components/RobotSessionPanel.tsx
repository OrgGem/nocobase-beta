/**
 * Robot & Session Panel — robots list + sessions table
 */

import React from 'react';
import { Table, Tag, Card } from 'antd';
import { useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

export const RobotSessionPanel: React.FC = () => {
  const t = useT();
  const { data: robots, loading: rLoading } = useUiPathRequest('uipathRobots', 'list');
  const { data: sessions, loading: sLoading } = useUiPathRequest('uipathSessions', 'list');

  return (
    <div>
      <Card title={t('Robots')} size="small" style={{ marginBottom: 16 }}>
        <Table
          dataSource={robots || []}
          rowKey="Id"
          loading={rLoading}
          size="small"
          pagination={{ pageSize: 50 }}
          columns={[
            { title: t('Name'), dataIndex: 'Name', ellipsis: true },
            { title: t('Machine'), dataIndex: 'MachineName', ellipsis: true },
            { title: t('Type'), dataIndex: 'Type', width: 120 },
            { title: t('Username'), dataIndex: 'Username', ellipsis: true },
          ]}
        />
      </Card>
      <Card title={t('Sessions')} size="small">
        <Table
          dataSource={sessions || []}
          rowKey="Id"
          loading={sLoading}
          size="small"
          pagination={{ pageSize: 50 }}
          columns={[
            { title: t('Robot'), dataIndex: 'RobotName', ellipsis: true },
            { title: t('Machine'), dataIndex: 'HostMachineName', ellipsis: true },
            { title: t('State'), dataIndex: 'State', width: 120, render: (s: string) => <Tag color={s === 'Available' ? 'green' : s === 'Busy' ? 'blue' : 'red'}>{s}</Tag> },
            { title: t('Reporting Time'), dataIndex: 'ReportingTime', width: 180, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
          ]}
        />
      </Card>
    </div>
  );
};
