import React, { useState } from 'react';
import { Button, Card, Space, Table, type TableColumnsType, Tag, Typography } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { type NocoBaseListBody, unwrapListMeta, unwrapRecords } from './api';

type ResolveLog = {
  id: number;
  entryId: number | null;
  appId: number | null;
  elementKey: string;
  path: 'cache_hit' | 'registry' | 'heuristic' | 'llm' | 'miss' | 'skipped' | 'error';
  failureType: string | null;
  idempotencyKey: string | null;
  selectorBefore: string | null;
  selectorAfter: string | null;
  durationMs: number | null;
  agentId: string | null;
  createdAt?: string;
};

const PATH_COLORS: Record<string, string> = {
  cache_hit: 'green',
  registry: 'blue',
  heuristic: 'cyan',
  llm: 'purple',
  miss: 'default',
  skipped: 'default',
  error: 'red',
};

export default function ResolveLogsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const request = useRequest(
    () =>
      ctx.api.request<NocoBaseListBody<ResolveLog>>({
        url: 'selectorResolveLogs:list',
        method: 'get',
        params: { sort: ['-createdAt'], page, pageSize },
      }),
    { refreshDeps: [page, pageSize] },
  );
  const logs = unwrapRecords<ResolveLog>(request.data);
  const meta = unwrapListMeta(request.data);

  const columns: TableColumnsType<ResolveLog> = [
    {
      title: t('Element Key'),
      key: 'elementKey',
      render: (_, record) => (
        <Typography.Text
          code
          ellipsis={{ tooltip: record.elementKey }}
          style={{ maxWidth: 240, display: 'inline-block', marginBottom: 0 }}
        >
          {record.elementKey}
        </Typography.Text>
      ),
    },
    {
      title: t('Path'),
      key: 'path',
      render: (_, record) => <Tag color={PATH_COLORS[record.path] ?? 'default'}>{record.path}</Tag>,
    },
    { title: t('Failure Type'), key: 'failureType', render: (_, record) => record.failureType || '—' },
    {
      title: `${t('Selector Before')} → ${t('Selector After')}`,
      key: 'selectors',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text
            code
            ellipsis={{ tooltip: record.selectorBefore ?? undefined }}
            style={{ maxWidth: 320, display: 'inline-block', marginBottom: 0 }}
          >
            {record.selectorBefore || '—'}
          </Typography.Text>
          <Typography.Text
            code
            ellipsis={{ tooltip: record.selectorAfter ?? undefined }}
            style={{ maxWidth: 320, display: 'inline-block', marginBottom: 0 }}
          >
            {record.selectorAfter || '—'}
          </Typography.Text>
        </Space>
      ),
    },
    { title: t('Duration (ms)'), key: 'durationMs', render: (_, record) => record.durationMs ?? '—' },
    { title: t('Agent'), key: 'agentId', render: (_, record) => record.agentId || '—' },
    { title: t('Created'), key: 'createdAt', render: (_, record) => record.createdAt || '—' },
  ];

  return (
    <Card
      title={t('Resolve Logs')}
      extra={
        <Button onClick={() => request.refresh()} loading={request.loading}>
          {t('Refresh')}
        </Button>
      }
    >
      <Table
        aria-label={t('Resolve Logs')}
        rowKey="id"
        loading={request.loading}
        dataSource={logs}
        pagination={{
          current: meta?.page ?? page,
          pageSize: meta?.pageSize ?? pageSize,
          total: meta?.count ?? 0,
          showSizeChanger: true,
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          },
        }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
        columns={columns}
      />
    </Card>
  );
}
