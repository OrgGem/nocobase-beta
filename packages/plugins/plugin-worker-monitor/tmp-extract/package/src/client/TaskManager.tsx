import React, { useEffect, useState, useCallback } from 'react';
import { Table, Tag, Button, Progress, Space, Popconfirm, message, Select } from 'antd';
import { ReloadOutlined, StopOutlined, RedoOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import dayjs from 'dayjs';

const STATUS_MAP: Record<number | string, { label: string; color: string }> = {
  null: { label: 'Pending', color: 'default' },
  0: { label: 'Running', color: 'processing' },
  1: { label: 'Succeeded', color: 'success' },
  '-1': { label: 'Failed', color: 'error' },
  '-2': { label: 'Canceled', color: 'warning' },
};

export function TaskManager() {
  const api = useAPIClient();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);

  const fetchData = useCallback(
    async (page = pagination.current, pageSize = pagination.pageSize) => {
      setLoading(true);
      try {
        const res = await api.request({
          url: 'workerMonitor:list',
          params: { page, pageSize, statusFilter: statusFilter === undefined ? '' : statusFilter },
        });
        const body = res.data;
        setData(body.data || []);
        setPagination((prev) => ({
          ...prev,
          current: body.meta?.page || page,
          total: body.meta?.count || 0,
        }));
      } catch (err) {
        message.error('Failed to load tasks');
      } finally {
        setLoading(false);
      }
    },
    [api, pagination.current, pagination.pageSize, statusFilter],
  );

  useEffect(() => {
    fetchData();
  }, [statusFilter]);

  const handleCancel = async (id: string) => {
    await api.request({ url: `workerMonitor:cancel`, params: { filterByTk: id } });
    message.success('Task canceled');
    fetchData();
  };

  const handleRetry = async (id: string) => {
    await api.request({ url: `workerMonitor:retry`, params: { filterByTk: id } });
    message.success('Task re-queued');
    fetchData();
  };

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      width: 200,
      ellipsis: true,
    },
    {
      title: 'Type',
      dataIndex: 'type',
      width: 120,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (val: number | null) => {
        const s = STATUS_MAP[String(val)] || { label: String(val), color: 'default' };
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: 'Progress',
      key: 'progress',
      width: 150,
      render: (_: any, record: any) => {
        if (record.status !== 0 || !record.progressTotal) return '-';
        const pct = Math.round((record.progressCurrent / record.progressTotal) * 100);
        return <Progress percent={pct} size="small" />;
      },
    },
    {
      title: 'User',
      key: 'user',
      width: 120,
      render: (_: any, record: any) => record.createdBy?.nickname || '-',
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      width: 160,
      render: (val: string) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: 'Duration',
      key: 'duration',
      width: 100,
      render: (_: any, record: any) => {
        if (!record.startedAt) return '-';
        const end = record.doneAt || new Date().toISOString();
        const sec = dayjs(end).diff(dayjs(record.startedAt), 'second');
        return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_: any, record: any) => (
        <Space>
          {(record.status === 0 || record.status === null) && (
            <Popconfirm title="Cancel this task?" onConfirm={() => handleCancel(record.id)}>
              <Button type="link" size="small" icon={<StopOutlined />} danger />
            </Popconfirm>
          )}
          {(record.status === -1 || record.status === -2) && (
            <Popconfirm title="Retry this task?" onConfirm={() => handleRetry(record.id)}>
              <Button type="link" size="small" icon={<RedoOutlined />} />
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
          placeholder="Filter by status"
          allowClear
          style={{ width: 160 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={Object.entries(STATUS_MAP).map(([k, v]) => ({ value: k, label: v.label }))}
        />
        <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>
          Refresh
        </Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        size="small"
        pagination={{
          ...pagination,
          showSizeChanger: true,
          showTotal: (total) => `Total ${total}`,
          onChange: (page, pageSize) => fetchData(page, pageSize),
        }}
      />
    </div>
  );
}
