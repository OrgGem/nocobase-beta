import React, { useState } from 'react';
import { Button, Card, Table, type TableColumnsType, Tag } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import { type NocoBaseListBody, type NocoBaseResponse, unwrapRecords } from './api';

type SyncRun = {
  id: string;
  status: string;
  triggerType: string;
  discoveredCount: number;
  changedCount: number;
  conflictCount: number;
  blockedCount: number;
  errorCount: number;
  createdAt?: string;
};

export default function SyncRunsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canSync } = useSkillRegistryPermissions();
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const request = useRequest(() =>
    ctx.api.request<NocoBaseListBody<SyncRun>>({
      url: 'skillRegistrySyncRuns:list',
      method: 'get',
      params: { sort: ['-createdAt'], pageSize: 50 },
    }),
  );
  const runs = unwrapRecords<SyncRun>(request.data);

  const retryRun = async (syncRunId: string) => {
    if (!canSync || retryingRunId) {
      return;
    }

    setRetryingRunId(syncRunId);
    try {
      await ctx.api.request<NocoBaseResponse<{ runId: string; status: string }>>({
        url: 'skillRegistryAdmin:retry',
        method: 'post',
        data: { syncRunId },
      });
      ctx.message.success(t('Sync retry completed'));
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setRetryingRunId(null);
    }
  };

  const columns: TableColumnsType<SyncRun> = [
    { title: t('Status'), key: 'status', render: (_, record) => <Tag>{record.status}</Tag> },
    { title: t('Trigger'), key: 'triggerType', render: (_, record) => record.triggerType },
    { title: t('Discovered'), key: 'discoveredCount', render: (_, record) => record.discoveredCount },
    { title: t('Changed'), key: 'changedCount', render: (_, record) => record.changedCount },
    { title: t('Conflicts'), key: 'conflictCount', render: (_, record) => record.conflictCount },
    { title: t('Blocked'), key: 'blockedCount', render: (_, record) => record.blockedCount },
    { title: t('Errors'), key: 'errorCount', render: (_, record) => record.errorCount },
    { title: t('Updated'), key: 'createdAt', render: (_, record) => record.createdAt || '\u2014' },
  ];

  if (canSync) {
    columns.push({
      title: t('Run'),
      key: 'actions',
      render: (_, record) => (
        <Button
          disabled={Boolean(retryingRunId) || !['failed', 'partial'].includes(record.status)}
          loading={retryingRunId === record.id}
          onClick={() => retryRun(record.id)}
        >
          {t('Retry')}
        </Button>
      ),
    });
  }

  return (
    <Card
      title={t('Sync runs')}
      extra={
        <Button onClick={() => request.refresh()} loading={request.loading}>
          {t('Refresh')}
        </Button>
      }
    >
      <Table
        aria-label={t('Sync runs')}
        rowKey="id"
        loading={request.loading}
        dataSource={runs}
        pagination={{ pageSize: 50 }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
        columns={columns}
      />
    </Card>
  );
}
