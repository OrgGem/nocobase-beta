/**
 * Queue Manager — definitions + items table, retry/review actions
 */

import React, { useState } from 'react';
import { Table, Tag, Tabs, Space, Button, Select, Input, Drawer, Descriptions, Popconfirm, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useCurrentInstance } from '../context/InstanceContext';
import { useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

const statusColors: Record<string, string> = {
  New: 'blue', InProgress: 'processing', Failed: 'red',
  Successful: 'green', Abandoned: 'default', Retried: 'orange', Deleted: 'default',
};

export const QueueManager: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId, folderId, folderKey } = useCurrentInstance();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [selectedItem, setSelectedItem] = useState<any>(null);

  const { data: defs, loading: defsLoading } = useUiPathRequest('uipathQueues', 'definitions');
  const { data: items, loading: itemsLoading, refresh } = useUiPathRequest('uipathQueues', 'items', {
    filter: statusFilter ? `Status eq '${statusFilter}'` : undefined,
    top: 50, count: true,
  });

  const handleRetry = async (itemId: number) => {
    try {
      await api.request({
        url: 'uipathQueues:retry',
        params: { instanceId, folderId, folderKey, filterByTk: itemId },
      });
      message.success(t('Retry requested'));
      refresh();
    } catch (err: any) { message.error(err.message); }
  };

  const defColumns = [
    { title: t('Name'), dataIndex: 'Name' },
    { title: t('Description'), dataIndex: 'Description', ellipsis: true },
    { title: t('Max Retries'), dataIndex: 'MaxNumberOfRetries', width: 100 },
    { title: t('Auto Retry'), dataIndex: 'AcceptAutomaticallyRetry', width: 100, render: (v: boolean) => v ? 'Yes' : 'No' },
  ];

  const itemColumns = [
    { title: t('ID'), dataIndex: 'Id', width: 80 },
    { title: t('Status'), dataIndex: 'Status', width: 100, render: (s: string) => <Tag color={statusColors[s]}>{s}</Tag> },
    { title: t('Priority'), dataIndex: 'Priority', width: 80 },
    { title: t('Reference'), dataIndex: 'Reference', width: 160, ellipsis: true },
    { title: t('Queue'), dataIndex: 'QueueDefinitionId', width: 80 },
    { title: t('Created'), dataIndex: 'CreationTime', width: 180, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    { title: t('Retry'), dataIndex: 'RetryNumber', width: 60 },
    {
      title: t('Actions'), width: 140,
      render: (_: any, rec: any) => (
        <Space size="small">
          {rec.Status === 'Failed' && (
            <Popconfirm title={t('Retry this item?')} onConfirm={() => handleRetry(rec.Id)}>
              <Button size="small">{t('Retry')}</Button>
            </Popconfirm>
          )}
          <Button size="small" onClick={() => setSelectedItem(rec)}>{t('Detail')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Tabs items={[
        {
          key: 'definitions', label: t('Queue Definitions'),
          children: <Table dataSource={defs || []} columns={defColumns} rowKey="Id" loading={defsLoading} size="small" />,
        },
        {
          key: 'items', label: t('Queue Items'),
          children: (
            <>
              <Space style={{ marginBottom: 16 }}>
                <Select placeholder={t('Status')} allowClear style={{ width: 140 }} value={statusFilter} onChange={setStatusFilter}
                  options={['New', 'InProgress', 'Failed', 'Successful', 'Abandoned', 'Retried'].map((s) => ({ label: s, value: s }))} />
                <Button onClick={() => refresh()} icon={<ReloadOutlined />}>{t('Refresh')}</Button>
              </Space>
              <Table dataSource={items || []} columns={itemColumns} rowKey="Id" loading={itemsLoading} size="small" pagination={{ pageSize: 50 }} />
            </>
          ),
        },
      ]} />

      <Drawer title={t('Queue Item Detail')} open={!!selectedItem} onClose={() => setSelectedItem(null)} width={600}>
        {selectedItem && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="ID">{selectedItem.Id}</Descriptions.Item>
            <Descriptions.Item label="Status"><Tag color={statusColors[selectedItem.Status]}>{selectedItem.Status}</Tag></Descriptions.Item>
            <Descriptions.Item label="Reference">{selectedItem.Reference || '-'}</Descriptions.Item>
            <Descriptions.Item label="Priority">{selectedItem.Priority}</Descriptions.Item>
            <Descriptions.Item label="Retry">{selectedItem.RetryNumber}</Descriptions.Item>
            <Descriptions.Item label="Specific Content">
              <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(selectedItem.SpecificContent, null, 2)}</pre>
            </Descriptions.Item>
            {selectedItem.ProcessingException && (
              <Descriptions.Item label="Exception">
                <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, color: 'red' }}>{JSON.stringify(selectedItem.ProcessingException, null, 2)}</pre>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Drawer>
    </div>
  );
};
