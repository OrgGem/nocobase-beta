import React from 'react';
import { Table, Tag, Card, Empty } from 'antd';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useT } from '../locale';

export const WorkerStatus: React.FC = () => {
  const t = useT();
  const { data, loading } = useN8nRequest('n8nMonitoring', 'workers');

  const workersData = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  // Ensure workersData is definitely an array to avoid map errors
  const workers = Array.isArray(workersData) ? workersData : [];

  if (!loading && workers.length === 0) {
    return (
      <Card title={t('Workers')} style={{ marginTop: 16 }}>
        <Empty description={t('No workers found (queue mode may not be enabled)')} />
      </Card>
    );
  }

  const columns = [
    { title: t('Worker ID'), dataIndex: 'workerId', key: 'workerId', ellipsis: true },
    { title: t('Hostname'), dataIndex: 'hostname', key: 'hostname' },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'ready' || status === 'online' ? 'green' : 'orange'}>{status}</Tag>
      ),
    },
    { title: t('Running Jobs'), dataIndex: 'runningJobsSummary', key: 'running', render: (v: any) => (Array.isArray(v) ? v.length : 0) },
    {
      title: t('Last Seen'),
      dataIndex: 'lastSeen',
      key: 'lastSeen',
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
  ];

  return (
    <Card title={t('Workers')} style={{ marginTop: 16 }}>
      <Table columns={columns} dataSource={workers} rowKey="workerId" loading={loading} pagination={false} size="small" />
    </Card>
  );
};
