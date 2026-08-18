import React, { useState } from 'react';
import { Button, Drawer, Table, type TableColumnsType, Tag, Typography } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSelectorRegistryPermissions } from '../permissions';
import { type NocoBaseListBody, type NocoBaseResponse, unwrapRecords } from './api';
import type { SelectorEntry } from './EntriesPage';

type SelectorVersion = {
  id: number;
  entryId: number;
  selector: string;
  selectorType: string;
  source: 'client' | 'heuristic' | 'llm' | 'manual' | 'rollback';
  confidence: number;
  reason: string | null;
  llmModel: string | null;
  status: 'active' | 'superseded' | 'failed' | 'rolled_back';
  successCount: number;
  failCount: number;
  rolledBackAt: string | null;
  createdAt?: string;
};

type RollbackResult = {
  entryId: number;
  versionId: number;
  selector: string;
  selectorType: string;
  version: number;
  status: string;
};

const SOURCE_COLORS: Record<string, string> = {
  client: 'blue',
  heuristic: 'cyan',
  llm: 'purple',
  manual: 'geekblue',
  rollback: 'orange',
};

const VERSION_STATUS_COLORS: Record<string, string> = {
  active: 'green',
  superseded: 'default',
  failed: 'red',
  rolled_back: 'orange',
};

type VersionsDrawerProps = {
  entry: SelectorEntry | null;
  onClose: () => void;
  onRolledBack?: () => void;
};

export default function VersionsDrawer({ entry, onClose, onRolledBack }: VersionsDrawerProps) {
  const ctx = useFlowContext();
  const t = useT();
  const { canManage } = useSelectorRegistryPermissions();
  const [rollingBackId, setRollingBackId] = useState<number | null>(null);
  const request = useRequest(
    () =>
      ctx.api.request<NocoBaseListBody<SelectorVersion>>({
        url: 'selectorVersions:list',
        method: 'get',
        params: { filter: { entryId: entry?.id }, sort: ['-createdAt'], pageSize: 100 },
      }),
    { ready: Boolean(entry), refreshDeps: [entry?.id] },
  );
  const versions = unwrapRecords<SelectorVersion>(request.data);

  const rollbackToVersion = async (version: SelectorVersion) => {
    if (!entry || !canManage || rollingBackId) {
      return;
    }
    setRollingBackId(version.id);
    try {
      await ctx.api.request<NocoBaseResponse<RollbackResult>>({
        url: 'selectorRegistryAdmin:rollbackVersion',
        method: 'post',
        data: { entryId: entry.id, versionId: version.id },
      });
      ctx.message.success(t('Version rolled back'));
      await request.refreshAsync();
      onRolledBack?.();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setRollingBackId(null);
    }
  };

  const columns: TableColumnsType<SelectorVersion> = [
    {
      title: t('Selector'),
      key: 'selector',
      render: (_, record) => (
        <Typography.Text
          code
          ellipsis={{ tooltip: record.selector }}
          style={{ maxWidth: 320, display: 'inline-block', marginBottom: 0 }}
        >
          {record.selector}
        </Typography.Text>
      ),
    },
    {
      title: t('Source'),
      key: 'source',
      render: (_, record) => <Tag color={SOURCE_COLORS[record.source] ?? 'default'}>{record.source}</Tag>,
    },
    {
      title: t('Status'),
      key: 'status',
      render: (_, record) => <Tag color={VERSION_STATUS_COLORS[record.status] ?? 'default'}>{record.status}</Tag>,
    },
    {
      title: t('Confidence'),
      key: 'confidence',
      render: (_, record) => `${Math.round(record.confidence * 100)}%`,
    },
    { title: t('Success Count'), key: 'successCount', render: (_, record) => record.successCount },
    { title: t('Fail Count'), key: 'failCount', render: (_, record) => record.failCount },
    { title: t('LLM Model'), key: 'llmModel', render: (_, record) => record.llmModel || '—' },
    { title: t('Created'), key: 'createdAt', render: (_, record) => record.createdAt || '—' },
  ];

  if (canManage) {
    columns.push({
      title: t('Actions'),
      key: 'actions',
      render: (_, record) =>
        record.status === 'active' ? null : (
          <Button size="small" loading={rollingBackId === record.id} onClick={() => rollbackToVersion(record)}>
            {t('Rollback to this version')}
          </Button>
        ),
    });
  }

  return (
    <Drawer
      title={entry ? `${t('Versions')}: ${entry.name || entry.elementKey}` : t('Versions')}
      open={Boolean(entry)}
      onClose={onClose}
      width={760}
    >
      <Table
        aria-label={t('Selector Versions')}
        rowKey="id"
        size="small"
        loading={request.loading}
        dataSource={versions}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
        columns={columns}
      />
    </Drawer>
  );
}
