import React, { useState } from 'react';
import { Button, Card, Table, type TableColumnsType, Tag, Typography } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { type NocoBaseListBody, unwrapListMeta, unwrapRecords } from './api';

type SelectorFeedback = {
  id: number;
  entryId: number | null;
  appId: number | null;
  elementKey: string;
  selectorUsed: string | null;
  outcome: 'success' | 'fail' | 'verified' | 'mismatch';
  failureType: string | null;
  signatureMatch: boolean | null;
  pageUrl: string | null;
  errorMessage: string | null;
  agentId: string | null;
  runId: string | null;
  createdAt?: string;
};

const OUTCOME_COLORS: Record<string, string> = {
  success: 'green',
  verified: 'green',
  fail: 'red',
  mismatch: 'red',
};

export default function FeedbacksPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const request = useRequest(
    () =>
      ctx.api.request<NocoBaseListBody<SelectorFeedback>>({
        url: 'selectorFeedbacks:list',
        method: 'get',
        params: { sort: ['-createdAt'], page, pageSize },
      }),
    { refreshDeps: [page, pageSize] },
  );
  const feedbacks = unwrapRecords<SelectorFeedback>(request.data);
  const meta = unwrapListMeta(request.data);

  const columns: TableColumnsType<SelectorFeedback> = [
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
      title: t('Outcome'),
      key: 'outcome',
      render: (_, record) => <Tag color={OUTCOME_COLORS[record.outcome] ?? 'default'}>{record.outcome}</Tag>,
    },
    { title: t('Failure Type'), key: 'failureType', render: (_, record) => record.failureType || '—' },
    {
      title: t('Signature Match'),
      key: 'signatureMatch',
      render: (_, record) => (record.signatureMatch == null ? '—' : record.signatureMatch ? t('Yes') : t('No')),
    },
    { title: t('Agent'), key: 'agentId', render: (_, record) => record.agentId || '—' },
    { title: t('Created'), key: 'createdAt', render: (_, record) => record.createdAt || '—' },
  ];

  return (
    <Card
      title={t('Feedbacks')}
      extra={
        <Button onClick={() => request.refresh()} loading={request.loading}>
          {t('Refresh')}
        </Button>
      }
    >
      <Table
        aria-label={t('Feedbacks')}
        rowKey="id"
        loading={request.loading}
        dataSource={feedbacks}
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
