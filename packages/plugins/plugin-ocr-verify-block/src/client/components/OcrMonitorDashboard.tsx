import React, { useEffect, useState, useCallback } from 'react';
import { Table, Tag, Button, Space, Card, Typography, Alert, message, Input, Tooltip } from 'antd';
import {
  SyncOutlined,
  RedoOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';

const { Text } = Typography;

function formatBytes(bytes?: number) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export const OcrMonitorDashboard = () => {
  const api = useAPIClient();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [refreshingId, setRefreshingId] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.resource('attachmentOcrResults').list({
        appends: ['attachment'],
        sort: '-createdAt',
        paginate: false,
      });
      setData(res?.data?.data || res?.data || []);
    } catch (err: any) {
      message.error(err?.message || 'Failed to load OCR monitor data');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRetry = async (record: any) => {
    setRefreshingId(record.id);
    try {
      await api.resource('filePreviewAuth').runOcr({
        values: { attachmentId: record.attachmentId },
      });
      message.success(`OCR job enqueued for ${record.attachment?.filename || 'attachment'}`);
      await loadData();
    } catch (err: any) {
      message.error(err?.message || 'Failed to trigger OCR');
    } finally {
      setRefreshingId(null);
    }
  };

  const filteredData = data.filter((item) => {
    const filename = String(item.attachment?.filename || '').toLowerCase();
    const query = search.toLowerCase();
    return filename.includes(query) || String(item.status).toLowerCase().includes(query);
  });

  const columns = [
    {
      title: 'Attachment Name',
      key: 'filename',
      render: (record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.attachment?.filename || `Attachment #${record.attachmentId}`}</Text>
          <Text type="secondary" style={{ fontSize: '12px' }}>
            ID: {record.attachmentId}
          </Text>
        </Space>
      ),
    },
    {
      title: 'File Size',
      key: 'size',
      render: (record: any) => <Text>{formatBytes(record.attachment?.size)}</Text>,
    },
    {
      title: 'MIME Type',
      key: 'mimetype',
      render: (record: any) => <Tag color="blue">{record.attachment?.mimetype || 'unknown'}</Tag>,
    },
    {
      title: 'OCR Status',
      key: 'status',
      render: (record: any) => {
        const status = record.status;
        if (status === 'pending-ocr') {
          return (
            <Tag icon={<SyncOutlined spin />} color="processing">
              Pending OCR
            </Tag>
          );
        }
        if (status === 'waiting-verify' || status === 'success') {
          return (
            <Tag icon={<CheckCircleOutlined />} color="success">
              Waiting Verify
            </Tag>
          );
        }
        if (status === 'failed') {
          return (
            <Tooltip title={record.error || 'Unknown error'}>
              <Tag icon={<ExclamationCircleOutlined />} color="error" style={{ cursor: 'pointer' }}>
                Failed
              </Tag>
            </Tooltip>
          );
        }
        return (
          <Tag icon={<ClockCircleOutlined />} color="default">
            No OCR
          </Tag>
        );
      },
    },
    {
      title: 'Last Error Message',
      dataIndex: 'error',
      key: 'error',
      render: (error: string) =>
        error ? (
          <Text type="danger" ellipsis={{ tooltip: error }} style={{ maxWidth: 200 }}>
            {error}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'Created At',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (val: string) => {
        if (!val) return '—';
        return new Date(val).toLocaleString();
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (record: any) => {
        const isRetrying = refreshingId === record.id;
        const canRetry = record.status === 'failed' || record.status === 'no-ocr';
        return (
          <Button
            type="link"
            icon={<RedoOutlined spin={isRetrying} />}
            disabled={!canRetry || isRetrying}
            onClick={() => handleRetry(record)}
          >
            Retry OCR
          </Button>
        );
      },
    },
  ];

  return (
    <Card
      style={{
        boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
        borderRadius: '8px',
        border: '1px solid #f0f0f0',
      }}
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Document OCR Monitoring Panel</span>
          <Space>
            <Input
              placeholder="Search by filename or status..."
              prefix={<SearchOutlined />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 260 }}
              allowClear
            />
            <Button type="primary" icon={<SyncOutlined spin={loading} />} onClick={loadData}>
              Refresh Panel
            </Button>
          </Space>
        </div>
      }
    >
      <Alert
        type="info"
        showIcon
        message="System OCR Status Board"
        description="Here you can review all system documents uploaded and monitor their Tesseract OCR processing queues, retry failed extraction pipelines, and diagnose execution faults."
        style={{ marginBottom: 16 }}
      />
      <Table
        dataSource={filteredData}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        locale={{ emptyText: 'No document OCR processing history found' }}
        style={{
          transition: 'all 0.3s ease',
        }}
      />
    </Card>
  );
};
