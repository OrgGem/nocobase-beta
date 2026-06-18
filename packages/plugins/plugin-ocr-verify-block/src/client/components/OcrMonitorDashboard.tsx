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
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';

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
  const t = useT();
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
      message.error(err?.message || t('Failed to load OCR monitor data'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRetry = async (record: any) => {
    setRefreshingId(record.id);
    try {
      await api.resource('filePreviewAuth').runOcr({
        values: { attachmentId: record.attachmentId },
      });
      message.success(
        t('OCR job enqueued for {{filename}}', { filename: record.attachment?.filename || t('attachment') }),
      );
      await loadData();
    } catch (err: any) {
      message.error(err?.message || t('Failed to trigger OCR'));
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
      title: t('Attachment name'),
      key: 'filename',
      render: (record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.attachment?.filename || t('Attachment #{{id}}', { id: record.attachmentId })}</Text>
          <Text type="secondary" style={{ fontSize: '12px' }}>
            {t('ID')}: {record.attachmentId}
          </Text>
        </Space>
      ),
    },
    {
      title: t('File size'),
      key: 'size',
      render: (record: any) => <Text>{formatBytes(record.attachment?.size)}</Text>,
    },
    {
      title: t('MIME type'),
      key: 'mimetype',
      render: (record: any) => <Tag color="blue">{record.attachment?.mimetype || t('unknown')}</Tag>,
    },
    {
      title: t('OCR status'),
      key: 'status',
      render: (record: any) => {
        const status = record.status;
        if (status === 'pending-ocr') {
          return (
            <Tag icon={<SyncOutlined spin />} color="processing">
              {t('Pending OCR')}
            </Tag>
          );
        }
        if (status === 'waiting-verify' || status === 'success') {
          return (
            <Tag icon={<CheckCircleOutlined />} color="success">
              {t('Waiting verify')}
            </Tag>
          );
        }
        if (status === 'failed') {
          return (
            <Tooltip title={record.error || t('Unknown error')}>
              <Tag icon={<ExclamationCircleOutlined />} color="error" style={{ cursor: 'pointer' }}>
                {t('Failed')}
              </Tag>
            </Tooltip>
          );
        }
        return (
          <Tag icon={<ClockCircleOutlined />} color="default">
            {t('No OCR')}
          </Tag>
        );
      },
    },
    {
      title: t('Last error message'),
      dataIndex: 'error',
      key: 'error',
      render: (error: string) =>
        error ? (
          <Text type="danger" ellipsis={{ tooltip: error }} style={{ maxWidth: 200 }}>
            {error}
          </Text>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: t('Created at'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (val: string) => {
        if (!val) return '-';
        return new Date(val).toLocaleString();
      },
    },
    {
      title: t('Actions'),
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
            {t('Retry OCR')}
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
          <span>{t('Document OCR monitoring panel')}</span>
          <Space>
            <Input
              placeholder={t('Search by filename or status...')}
              prefix={<SearchOutlined />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 260 }}
              allowClear
            />
            <Button type="primary" icon={<SyncOutlined spin={loading} />} onClick={loadData}>
              {t('Refresh panel')}
            </Button>
          </Space>
        </div>
      }
    >
      <Alert
        type="info"
        showIcon
        message={t('System OCR status board')}
        description={t(
          'Review uploaded documents, monitor Tesseract OCR processing queues, retry failed extraction, and diagnose execution faults.',
        )}
        style={{ marginBottom: 16 }}
      />
      <Table
        dataSource={filteredData}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        locale={{ emptyText: t('No document OCR processing history found') }}
        style={{
          transition: 'all 0.3s ease',
        }}
      />
    </Card>
  );
};
