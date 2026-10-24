import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  RedoOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Card, Input, Space, Table, Tag, Tooltip, Typography } from 'antd';
import React, { useState } from 'react';
import { useT } from '../locale';
import type { OcrMonitorRow } from '../types';

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const index = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Number((bytes / Math.pow(1024, index)).toFixed(2))} ${['B', 'KB', 'MB', 'GB'][index]}`;
}

export default function OcrMonitorDashboard() {
  const api = useApp().apiClient;
  const t = useT();
  const { message } = App.useApp();
  const [search, setSearch] = useState('');
  const list = useRequest(async () => {
    const response = await api.request<{ data: OcrMonitorRow[] }>({
      url: 'attachmentOcrResults:list',
      method: 'get',
      params: { appends: ['attachment'], sort: ['-createdAt'], paginate: false },
    });
    return response.data.data || [];
  });
  const retry = useRequest(
    async (row: OcrMonitorRow) => {
      await api.request({ url: 'filePreviewAuth:runOcr', method: 'post', data: { attachmentId: row.attachmentId } });
      message.success(
        t('OCR job enqueued for {{filename}}', { filename: row.attachment?.filename || t('attachment') }),
      );
      await list.refreshAsync();
    },
    { manual: true, onError: () => message.error(t('Failed to trigger OCR')) },
  );
  const query = search.toLowerCase();
  const rows = list.data?.filter(
    (row) =>
      (row.attachment?.filename || '').toLowerCase().includes(query) ||
      (row.status || '').toLowerCase().includes(query),
  );
  return (
    <Card
      title={t('Document OCR monitoring panel')}
      extra={
        <Space wrap>
          <Input
            aria-label={t('Search by filename or status...')}
            placeholder={t('Search by filename or status...')}
            prefix={<SearchOutlined />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            allowClear
          />
          <Button icon={<SyncOutlined spin={list.loading} />} onClick={list.refresh}>
            {t('Refresh panel')}
          </Button>
        </Space>
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
      {list.error && (
        <Alert type="error" showIcon message={t('Failed to load OCR monitor data')} style={{ marginBottom: 16 }} />
      )}
      <Table<OcrMonitorRow>
        rowKey="id"
        dataSource={rows || []}
        loading={list.loading}
        pagination={{ defaultPageSize: 10, showSizeChanger: true }}
        locale={{ emptyText: t('No document OCR processing history found') }}
        columns={[
          {
            title: t('Attachment name'),
            render: (_: unknown, row) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>
                  {row.attachment?.filename || t('Attachment #{{id}}', { id: row.attachmentId })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t('ID')}: {row.attachmentId}
                </Typography.Text>
              </Space>
            ),
          },
          { title: t('File size'), render: (_: unknown, row) => formatBytes(row.attachment?.size) },
          { title: t('MIME type'), render: (_: unknown, row) => <Tag>{row.attachment?.mimetype || t('unknown')}</Tag> },
          {
            title: t('OCR status'),
            render: (_: unknown, row) => {
              if (row.status === 'pending-ocr')
                return (
                  <Tag icon={<SyncOutlined spin />} color="processing">
                    {t('Pending OCR')}
                  </Tag>
                );
              if (row.status === 'waiting-verify' || row.status === 'success')
                return (
                  <Tag icon={<CheckCircleOutlined />} color="success">
                    {t('Waiting verify')}
                  </Tag>
                );
              if (row.status === 'failed')
                return (
                  <Tooltip title={row.error || t('Unknown error')}>
                    <Tag icon={<ExclamationCircleOutlined />} color="error">
                      {t('Failed')}
                    </Tag>
                  </Tooltip>
                );
              return <Tag icon={<ClockCircleOutlined />}>{t('No OCR')}</Tag>;
            },
          },
          {
            title: t('Last error message'),
            dataIndex: 'error',
            render: (error?: string) => (
              <Typography.Text type="danger" ellipsis={{ tooltip: error }}>
                {error || '-'}
              </Typography.Text>
            ),
          },
          {
            title: t('Created at'),
            dataIndex: 'createdAt',
            render: (date?: string) => (date ? new Date(date).toLocaleString() : '-'),
          },
          {
            title: t('Actions'),
            render: (_: unknown, row) => (
              <Button
                type="link"
                icon={<RedoOutlined />}
                loading={retry.loading && retry.params[0]?.id === row.id}
                disabled={retry.loading || !['failed', 'no-ocr'].includes(row.status || '')}
                onClick={() => retry.run(row)}
              >
                {t('Retry OCR')}
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
