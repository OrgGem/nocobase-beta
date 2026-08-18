import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Table, Tag, Button, Space, Popconfirm, message, Select, Dropdown } from 'antd';
import { ReloadOutlined, StopOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './utils';
import dayjs from 'dayjs';

const EXEC_STATUS: Record<string, { label: string; color: string }> = {
  null: { label: 'Queueing', color: 'default' },
  '0': { label: 'Started', color: 'processing' },
  '1': { label: 'Resolved', color: 'success' },
  '-1': { label: 'Failed', color: 'error' },
  '-2': { label: 'Error', color: 'error' },
  '-3': { label: 'Aborted', color: 'warning' },
  '-4': { label: 'Canceled', color: 'warning' },
  '-5': { label: 'Rejected', color: 'warning' },
  '-6': { label: 'Retry Needed', color: 'orange' },
};

const JOB_STATUS: Record<string, { label: string; color: string }> = {
  '0': { label: 'Pending', color: 'default' },
  '1': { label: 'Resolved', color: 'success' },
  '-1': { label: 'Failed', color: 'error' },
  '-2': { label: 'Error', color: 'error' },
  '-3': { label: 'Aborted', color: 'warning' },
  '-4': { label: 'Canceled', color: 'warning' },
};

export function WorkflowExecutions() {
  const api = useApp().apiClient;
  const t = useT();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [expandedJobs, setExpandedJobs] = useState<Record<string, any[]>>({});
  const [loadingJobs, setLoadingJobs] = useState<Record<string, boolean>>({});
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
          url: 'clusterManagerWorkflow:list',
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
      } catch {
        message.error(t('Failed to load executions'));
      } finally {
        setLoading(false);
      }
    },
    [api, statusFilter, t],
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const fetchJobs = async (executionId: string) => {
    if (expandedJobs[executionId]) return;
    setLoadingJobs((prev) => ({ ...prev, [executionId]: true }));
    try {
      const res = await api.request({
        url: 'clusterManagerWorkflow:getJobs',
        params: { filterByTk: executionId },
      });
      const jobs = Array.isArray(res?.data?.data?.data)
        ? res.data.data.data
        : Array.isArray(res?.data?.data)
          ? res.data.data
          : Array.isArray(res?.data)
            ? res.data
            : [];
      setExpandedJobs((prev) => ({ ...prev, [executionId]: jobs }));
    } catch {
      message.error(t('Failed to load jobs'));
    } finally {
      setLoadingJobs((prev) => ({ ...prev, [executionId]: false }));
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await api.request({ url: 'clusterManagerWorkflow:cancel', params: { filterByTk: id } });
      message.success(t('Execution canceled'));
      fetchData();
    } catch {
      message.error(t('Failed to cancel execution'));
    }
  };

  const handlePurge = async (days: number) => {
    try {
      const res = await api.request({ url: `clusterManagerWorkflow:purge`, method: 'post', data: { days } });
      message.success(t('Purged {count} executions').replace('{count}', String(res?.data?.deletedCount || 0)));
      fetchData();
    } catch {
      message.error(t('Failed to purge executions'));
    }
  };

  const purgeItems = [
    { key: '7', label: t('Older than 7 days'), onClick: () => handlePurge(7) },
    { key: '30', label: t('Older than 30 days'), onClick: () => handlePurge(30) },
    { key: '0', label: t('All completed/failed'), danger: true, onClick: () => handlePurge(0) },
  ];

  const jobColumns = [
    { title: t('Job ID'), dataIndex: 'id', width: 100 },
    {
      title: t('Node'),
      key: 'node',
      width: 200,
      render: (_: any, r: any) => r.node?.title || r.nodeKey || '-',
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      width: 100,
      render: (val: number) => {
        const s = JOB_STATUS[String(val)] || { label: String(val), color: 'default' };
        return <Tag color={s.color}>{t(s.label)}</Tag>;
      },
    },
    {
      title: t('Result'),
      dataIndex: 'result',
      ellipsis: true,
      render: (val: any) => (val ? JSON.stringify(val).slice(0, 120) : '-'),
    },
  ];

  const columns = [
    { title: t('ID'), dataIndex: 'id', width: 100 },
    {
      title: t('Workflow'),
      key: 'workflow',
      width: 200,
      render: (_: any, r: any) => r.workflow?.title || '-',
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      width: 120,
      render: (val: number | null) => {
        const s = EXEC_STATUS[String(val)] || { label: String(val), color: 'default' };
        return <Tag color={s.color}>{t(s.label)}</Tag>;
      },
    },
    {
      title: t('Executing Node'),
      dataIndex: 'workerNode',
      width: 150,
      render: (val: string) => (val && val !== '-' ? <Tag color="blue">{val}</Tag> : <Tag>{val || '-'}</Tag>),
    },
    {
      title: t('Manual'),
      dataIndex: 'manually',
      width: 80,
      render: (val: boolean) => (val ? <Tag color="blue">{t('Yes')}</Tag> : '-'),
    },
    {
      title: t('Triggered At'),
      dataIndex: 'createdAt',
      width: 160,
      render: (val: string) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 120,
      render: (_: any, record: any) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<UnorderedListOutlined />}
            onClick={() => fetchJobs(record.id)}
            loading={loadingJobs[record.id]}
          >
            {t('Jobs')}
          </Button>
          {(record.status === 0 || record.status === null) && (
            <Popconfirm title={t('Cancel execution?')} onConfirm={() => handleCancel(record.id)}>
              <Button type="link" size="small" icon={<StopOutlined />} danger />
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
          options={Object.entries(EXEC_STATUS).map(([k, v]) => ({ value: k, label: t(v.label) }))}
        />
        <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>
          {t('Refresh')}
        </Button>
        <Dropdown menu={{ items: purgeItems }} trigger={['click']}>
          <Button danger>{t('Clear History')}</Button>
        </Dropdown>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        size="small"
        scroll={{ x: 'max-content' }}
        expandable={{
          expandedRowRender: (record) => {
            const jobs = expandedJobs[record.id];
            if (!jobs) return <div style={{ padding: 8 }}>{t('Click "Jobs" to load')}</div>;
            return <Table rowKey="id" columns={jobColumns} dataSource={jobs} size="small" pagination={false} />;
          },
        }}
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
