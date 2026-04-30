import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Button, Typography, Space, Tooltip, Popconfirm, message } from 'antd';
import { ReloadOutlined, DownloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAPIClient, Upload } from '@nocobase/client';
import { useT } from '../locale';
import { parseJsonText } from '../utils/jsonFields';

const STATUS_COLORS: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  succeeded: 'success',
  failed: 'error',
  canceled: 'warning',
  timeout: 'error',
};

export const ExecutionHistory: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [executions, setExecutions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  const fetchExecutions = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({
        url: 'skillExecutions:list',
        params: {
          page,
          pageSize,
          sort: ['-createdAt'],
          appends: ['skill', 'triggeredBy'],
        },
      });
      const rawData = data?.data?.data ?? data?.data ?? [];
      setExecutions(Array.isArray(rawData) ? rawData : []);
      setTotal(data?.meta?.count || 0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [api, page]);

  useEffect(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  const handleDelete = async (id: number) => {
    try {
      await api.request({
        url: `skillExecutions:destroy`,
        method: 'POST',
        params: {
          filterByTk: id
        }
      });
      message.success(t('Deleted successfully'));
      fetchExecutions();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || t('Delete failed'));
    }
  };

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 80,
    },
    {
      title: t('Skill'),
      dataIndex: ['skill', 'title'],
      key: 'skill',
      width: 180,
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string) => (
        <Tag color={STATUS_COLORS[status] || 'default'}>{status}</Tag>
      ),
    },
    {
      title: t('Duration'),
      dataIndex: 'durationMs',
      key: 'duration',
      width: 100,
      render: (ms: number) => (ms ? `${(ms / 1000).toFixed(1)}s` : '-'),
    },
    {
      title: t('Files'),
      dataIndex: 'outputFiles',
      key: 'files',
      width: 250,
      render: (files: any[], record: any) => {
        files = parseJsonText(files, []);
        if (!Array.isArray(files) || !files.length) return '-';
        const formattedFiles = files.map((f, i) => ({
          id: `${record.id}-${f.name}-${i}`,
          title: f.name,
          filename: f.name,
          extname: f.name.includes('.') ? `.${f.name.split('.').pop()}` : '',
          url: `/api/skillHub:download?execId=${record.id}&filename=${encodeURIComponent(f.name)}`,
          status: 'done'
        }));
        return <Upload.ReadPretty value={formattedFiles} multiple={true} showFileName={true} />;
      },
    },
    {
      title: t('Triggered By'),
      dataIndex: ['triggeredBy', 'nickname'],
      key: 'triggeredBy',
      width: 120,
      render: (v: string) => v || '-',
    },
    {
      title: t('Created At'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : '-'),
    },
    {
      title: t('Output'),
      key: 'output',
      width: 200,
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          {record.stdout && (
            <Tooltip title={record.stdout}>
              <Typography.Text style={{ fontSize: 12, maxWidth: 200 }} ellipsis>
                {record.stdout}
              </Typography.Text>
            </Tooltip>
          )}
          {record.stderr && (
            <Tooltip title={record.stderr}>
              <Typography.Text type="danger" style={{ fontSize: 12, maxWidth: 200 }} ellipsis>
                {record.stderr}
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 80,
      fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Space size="middle">
          <Popconfirm
            title={t('Are you sure to delete this execution history and its files?')}
            onConfirm={() => handleDelete(record.id)}
            okText={t('Yes')}
            cancelText={t('No')}
          >
            <Button type="text" danger icon={<DeleteOutlined />} size="small" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('Execution History')}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchExecutions} loading={loading}>
            {t('Refresh')}
          </Button>
        </Space>
      }
    >
      <Table
        dataSource={executions}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="middle"
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: setPage,
          showTotal: (t) => `Total: ${t}`,
        }}
        scroll={{ x: 1200 }}
      />
    </Card>
  );
};
