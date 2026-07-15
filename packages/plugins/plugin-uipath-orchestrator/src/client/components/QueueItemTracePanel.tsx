import React, { useEffect, useState } from 'react';
import { Spin, Table, Tag, Alert, Descriptions, Empty, Space } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';
import { getActionResponseBody } from '../utils/apiResponse';

export const QueueItemTracePanel: React.FC<{ itemId: number }> = ({ itemId }) => {
  const t = useT();
  const api = useApp().apiClient;
  const { instanceId, folderId, folderKey, folderPath, folderReady } = useCurrentInstance();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    if (!itemId || !instanceId || !folderReady) return;

    let active = true;
    setLoading(true);
    setError(null);
    api
      .request({
        url: 'uipathCorrelations:fromQueueItem',
        params: {
          instanceId,
          folderId,
          folderKey,
          folderPath,
          queueItemId: itemId,
        },
      })
      .then((res) => {
        if (active) {
          setData(getActionResponseBody(res));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err);
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [itemId, instanceId, folderId, folderKey, folderPath, folderReady, api]);

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (error) {
    return <Alert type="error" showIcon message={t('Failed to load trace')} description={error.message} />;
  }
  if (!data) {
    return <Empty />;
  }

  const { job, logs } = data;

  const logColumns = [
    {
      title: t('Time'),
      dataIndex: 'TimeStamp',
      width: 140,
      render: (v: string) => (v ? new Date(v).toLocaleTimeString() : '-'),
    },
    {
      title: t('Level'),
      dataIndex: 'Level',
      width: 80,
      render: (v: string) => {
        const colors: Record<string, string> = {
          Info: 'blue',
          Warn: 'orange',
          Error: 'red',
          Fatal: 'magenta',
        };
        return <Tag color={colors[v] || 'default'}>{v}</Tag>;
      },
    },
    {
      title: t('Message'),
      dataIndex: 'Message',
      ellipsis: true,
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Descriptions title={t('Correlated Job')} column={1} bordered size="small">
        {job ? (
          <>
            <Descriptions.Item label={t('Process')}>{job.ReleaseName}</Descriptions.Item>
            <Descriptions.Item label={t('State')}>
              <Tag color={job.State === 'Successful' ? 'green' : job.State === 'Faulted' ? 'red' : 'blue'}>
                {job.State}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('Time Window')}>
              {new Date(job.StartTime).toLocaleString()} ~{' '}
              {job.EndTime ? new Date(job.EndTime).toLocaleString() : t('Running')}
            </Descriptions.Item>
          </>
        ) : (
          <Descriptions.Item label={t('Status')}>{t('No overlapping job found')}</Descriptions.Item>
        )}
      </Descriptions>

      <div style={{ marginTop: 16 }}>
        <h4 style={{ marginBottom: 12 }}>{t('Transaction Execution Logs')}</h4>
        {logs.length > 0 ? (
          <Table
            dataSource={logs}
            columns={logColumns}
            rowKey="Id"
            size="small"
            pagination={{ pageSize: 20 }}
            scroll={{ y: 300 }}
          />
        ) : (
          <Empty description={t('No logs found for this transaction window')} />
        )}
      </div>
    </Space>
  );
};
