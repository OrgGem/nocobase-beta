import React, { useEffect, useState, useCallback } from 'react';
import { Table, Tag, Button, Space, Popconfirm, message, Select } from 'antd';
import { ReloadOutlined, StopOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
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
  const api = useAPIClient();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [expandedJobs, setExpandedJobs] = useState<Record<string, any[]>>({});
  const [loadingJobs, setLoadingJobs] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(
    async (page = pagination.current, pageSize = pagination.pageSize) => {
      setLoading(true);
      try {
        const res = await api.request({
          url: 'workerMonitorWorkflow:list',
          params: { page, pageSize, statusFilter: statusFilter === undefined ? '' : statusFilter },
        });
        const body = res.data;
        setData(body.data || []);
        setPagination((prev) => ({
          ...prev,
          current: body.meta?.page || page,
          total: body.meta?.count || 0,
        }));
      } catch {
        message.error('Failed to load executions');
      } finally {
        setLoading(false);
      }
    },
    [api, pagination.current, pagination.pageSize, statusFilter],
  );

  useEffect(() => {
    fetchData();
  }, [statusFilter]);

  const fetchJobs = async (executionId: string) => {
    if (expandedJobs[executionId]) return;
    setLoadingJobs((prev) => ({ ...prev, [executionId]: true }));
    try {
      const res = await api.request({
        url: 'workerMonitorWorkflow:getJobs',
        params: { filterByTk: executionId },
      });
      setExpandedJobs((prev) => ({ ...prev, [executionId]: res.data?.data || [] }));
    } catch {
      message.error('Failed to load jobs');
    } finally {
      setLoadingJobs((prev) => ({ ...prev, [executionId]: false }));
    }
  };

  const handleCancel = async (id: string) => {
    await api.request({ url: 'workerMonitorWorkflow:cancel', params: { filterByTk: id } });
    message.success('Execution canceled');
    fetchData();
  };

  const jobColumns = [
    { title: 'Job ID', dataIndex: 'id', width: 100 },
    {
      title: 'Node',
      key: 'node',
      width: 200,
      render: (_: any, r: any) => r.node?.title || r.nodeKey || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (val: number) => {
        const s = JOB_STATUS[String(val)] || { label: String(val), color: 'default' };
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: 'Result',
      dataIndex: 'result',
      ellipsis: true,
      render: (val: any) => (val ? JSON.stringify(val).slice(0, 120) : '-'),
    },
  ];

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 100 },
    {
      title: 'Workflow',
      key: 'workflow',
      width: 200,
      render: (_: any, r: any) => r.workflow?.title || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 120,
      render: (val: number | null) => {
        const s = EXEC_STATUS[String(val)] || { label: String(val), color: 'default' };
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: 'Manual',
      dataIndex: 'manually',
      width: 80,
      render: (val: boolean) => (val ? <Tag color="blue">Yes</Tag> : '-'),
    },
    {
      title: 'Triggered At',
      dataIndex: 'createdAt',
      width: 160,
      render: (val: string) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: 'Actions',
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
            Jobs
          </Button>
          {(record.status === 0 || record.status === null) && (
            <Popconfirm title="Cancel execution?" onConfirm={() => handleCancel(record.id)}>
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
          placeholder="Filter by status"
          allowClear
          style={{ width: 160 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={Object.entries(EXEC_STATUS).map(([k, v]) => ({ value: k, label: v.label }))}
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
        expandable={{
          expandedRowRender: (record) => {
            const jobs = expandedJobs[record.id];
            if (!jobs) return <div style={{ padding: 8 }}>Click "Jobs" to load</div>;
            return (
              <Table
                rowKey="id"
                columns={jobColumns}
                dataSource={jobs}
                size="small"
                pagination={false}
              />
            );
          },
        }}
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
