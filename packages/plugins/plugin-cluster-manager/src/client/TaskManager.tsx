import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Table, Tag, Button, Progress, Space, Popconfirm, message, Select, Dropdown } from 'antd';
import { ReloadOutlined, StopOutlined, RedoOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './utils';
import dayjs from 'dayjs';

const STATUS_MAP: Record<number | string, { label: string; color: string }> = {
  null: { label: 'Pending', color: 'default' },
  0: { label: 'Running', color: 'processing' },
  1: { label: 'Succeeded', color: 'success' },
  '-1': { label: 'Failed', color: 'error' },
  '-2': { label: 'Canceled', color: 'warning' },
};

export function TaskManager() {
  const api = useApp().apiClient;
  const t = useT();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const paginationRef = useRef(pagination);

  useEffect(() => {
    paginationRef.current = pagination;
  }, [pagination]);

  const fetchData = useCallback(
    async (page?: number, pageSize?: number) => {
      const currentPage = page ?? paginationRef.current.current;
      const currentPageSize = pageSize ?? paginationRef.current.pageSize;
      setLoading(true);
      try {
        const res = await api.request({
          url: 'clusterManager:list',
          params: {
            page: currentPage,
            pageSize: currentPageSize,
            statusFilter: statusFilter === undefined ? '' : statusFilter,
          },
        });
        const body = res.data;
        const rows = Array.isArray(body?.data?.data)
          ? body.data.data
          : Array.isArray(body?.data)
            ? body.data
            : Array.isArray(body)
              ? body
              : [];
        setData(rows);
        setPagination((prev) => ({
          ...prev,
          current: body.meta?.page || currentPage,
          total: body.meta?.count || 0,
        }));
      } catch (err) {
        message.error(t('Failed to load tasks'));
      } finally {
        setLoading(false);
      }
    },
    [api, statusFilter, t],
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCancel = async (id: string) => {
    try {
      await api.request({ url: `clusterManager:cancel`, params: { filterByTk: id } });
      message.success(t('Task canceled'));
      fetchData();
    } catch {
      message.error(t('Failed to cancel task'));
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await api.request({ url: `clusterManager:retry`, params: { filterByTk: id } });
      message.success(t('Task re-queued'));
      fetchData();
    } catch {
      message.error(t('Failed to retry task'));
    }
  };

  const handlePurge = async (days: number) => {
    try {
      const res = await api.request({ url: `clusterManager:purge`, method: 'post', data: { days } });
      message.success(t('Purged {count} tasks').replace('{count}', String(res?.data?.deletedCount || 0)));
      fetchData();
    } catch {
      message.error(t('Failed to purge tasks'));
    }
  };

  const purgeItems = [
    { key: '7', label: t('Older than 7 days'), onClick: () => handlePurge(7) },
    { key: '30', label: t('Older than 30 days'), onClick: () => handlePurge(30) },
    { key: '0', label: t('All completed/failed'), danger: true, onClick: () => handlePurge(0) },
  ];

  const columns = [
    {
      title: t('Title'),
      dataIndex: 'title',
      width: 200,
      ellipsis: true,
    },
    {
      title: t('Type'),
      dataIndex: 'type',
      width: 120,
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      width: 100,
      render: (val: number | null) => {
        const s = STATUS_MAP[String(val)] || { label: String(val), color: 'default' };
        return <Tag color={s.color}>{t(s.label)}</Tag>;
      },
    },
    {
      title: t('Progress'),
      key: 'progress',
      width: 150,
      render: (_: any, record: any) => {
        if (record.status !== 0 || !record.progressTotal) return '-';
        const pct = Math.round((record.progressCurrent / record.progressTotal) * 100);
        return <Progress percent={pct} size="small" />;
      },
    },
    {
      title: t('User'),
      key: 'user',
      width: 120,
      render: (_: any, record: any) => record.createdBy?.nickname || '-',
    },
    {
      title: t('Created'),
      dataIndex: 'createdAt',
      width: 160,
      render: (val: string) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: t('Duration'),
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
      title: t('Actions'),
      key: 'actions',
      width: 120,
      render: (_: any, record: any) => (
        <Space>
          {(record.status === 0 || record.status === null) && (
            <Popconfirm title={t('Cancel this task?')} onConfirm={() => handleCancel(record.id)}>
              <Button type="link" size="small" icon={<StopOutlined />} danger />
            </Popconfirm>
          )}
          {(record.status === -1 || record.status === -2) && (
            <Popconfirm title={t('Retry this task?')} onConfirm={() => handleRetry(record.id)}>
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
          placeholder={t('Filter by status')}
          allowClear
          style={{ width: 160 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={Object.entries(STATUS_MAP).map(([k, v]) => ({ value: k, label: t(v.label) }))}
        />
        <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>
          {t('Refresh')}
        </Button>
        <Dropdown menu={{ items: purgeItems }} trigger={['click']}>
          <Button danger>{t('Purge Tasks')}</Button>
        </Dropdown>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        size="small"
        scroll={{ x: 'max-content' }}
        pagination={{
          ...pagination,
          showSizeChanger: true,
          showTotal: (total) => t('Total {total}').replace('{total}', String(total)),
          onChange: (page, pageSize) => fetchData(page, pageSize),
        }}
      />
    </div>
  );
}
