import React, { useState } from 'react';
import { Table, Select, Button, Badge, Drawer, Space, message, Popconfirm } from 'antd';
import { ReloadOutlined, EyeOutlined, RedoOutlined, StopOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

const statusColors: Record<string, string> = {
  success: 'green',
  error: 'red',
  running: 'blue',
  waiting: 'gold',
  new: 'cyan',
};

export const ExecutionList: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId } = useCurrentInstance();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [workflowFilter, setWorkflowFilter] = useState<string | undefined>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);

  const filter: any = {};
  if (statusFilter) filter.status = statusFilter;
  if (workflowFilter) filter.workflowId = workflowFilter;

  const { data, loading, refresh } = useN8nRequest('n8nExecutions', 'list', { filter });
  const { data: workflowsData } = useN8nRequest('n8nWorkflows', 'list');

  const executions = data?.data || data || [];
  const workflows = workflowsData?.data || workflowsData || [];

  const handleRetry = async (id: string) => {
    try {
      await api.request({ url: 'n8nExecutions:retry', params: { instanceId, filterByTk: id } });
      message.success(t('Retry initiated'));
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const handleStop = async (id: string) => {
    try {
      await api.request({ url: 'n8nExecutions:stop', params: { instanceId, filterByTk: id } });
      message.success(t('Execution stopped'));
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const handleViewDetail = async (id: string) => {
    try {
      const res = await api.request({ url: 'n8nExecutions:get', params: { instanceId, filterByTk: id } });
      setDetail(res?.data);
      setDetailOpen(true);
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 100 },
    {
      title: t('Workflow'),
      dataIndex: 'workflowId',
      key: 'workflowId',
      render: (wfId: string, record: any) => record.workflowData?.name || `#${wfId}`,
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => <Badge color={statusColors[status] || 'default'} text={status} />,
    },
    {
      title: t('Started'),
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
    {
      title: t('Duration'),
      key: 'duration',
      width: 100,
      render: (_: any, record: any) => {
        if (!record.startedAt || !record.stoppedAt) return '-';
        const ms = new Date(record.stoppedAt).getTime() - new Date(record.startedAt).getTime();
        return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
      },
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 150,
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(record.id)} />
          {record.status === 'error' && (
            <Popconfirm title={t('Retry this execution?')} onConfirm={() => handleRetry(record.id)}>
              <Button type="link" size="small" icon={<RedoOutlined />} />
            </Popconfirm>
          )}
          {record.status === 'running' && (
            <Popconfirm title={t('Stop this execution?')} onConfirm={() => handleStop(record.id)}>
              <Button type="link" size="small" danger icon={<StopOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder={t('Status')}
          allowClear
          onChange={setStatusFilter}
          style={{ width: 150 }}
          options={[
            { label: t('Success'), value: 'success' },
            { label: t('Error'), value: 'error' },
            { label: t('Running'), value: 'running' },
            { label: t('Waiting'), value: 'waiting' },
          ]}
        />
        <Select
          placeholder={t('Workflow')}
          allowClear
          showSearch
          optionFilterProp="label"
          onChange={setWorkflowFilter}
          style={{ width: 250 }}
          options={workflows.map((w: any) => ({ label: w.name, value: String(w.id) }))}
        />
        <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table columns={columns} dataSource={executions} rowKey="id" loading={loading} pagination={{ pageSize: 20 }} />
      <Drawer
        title={`${t('Execution')} #${detail?.id || ''}`}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={720}
      >
        {detail && <pre style={{ fontSize: 12, overflow: 'auto' }}>{JSON.stringify(detail, null, 2)}</pre>}
      </Drawer>
    </div>
  );
};
