import React, { useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Table,
  type TableColumnsType,
  Tag,
  Typography,
} from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSelectorRegistryPermissions } from '../permissions';
import { type NocoBaseListBody, type NocoBaseResponse, unwrapData, unwrapListMeta, unwrapRecords } from './api';
import VersionsDrawer from './VersionsDrawer';

export type SelectorEntry = {
  id: number;
  appId: number;
  elementKey: string;
  name: string | null;
  pageUrlPattern: string | null;
  currentSelector: string | null;
  selectorType: 'css' | 'xpath' | 'text' | 'aria';
  status: 'probation' | 'active' | 'degraded' | 'quarantined' | 'disabled';
  pinned: boolean;
  confidence: number;
  hitCount: number;
  successCount: number;
  failCount: number;
  failStreak: number;
  version: number;
  resolvedBy: string | null;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastResolvedAt: string | null;
  createdAt?: string;
  app?: { id: number; name: string; displayName?: string | null };
};

type SelectorAppOption = {
  id: number;
  name: string;
};

type RevalidateResult = {
  elementKey: string;
  selector: string | null;
  selectorType: string;
  confidence: number;
  source: string;
  version: number;
  status: string;
  healTriggered: boolean;
  dryRunCandidate?: { selector: string; selectorType: string; source: string };
};

const ENTRY_STATUSES = ['probation', 'active', 'degraded', 'quarantined', 'disabled'] as const;

const ENTRY_STATUS_LABELS: Record<string, string> = {
  probation: 'Probation',
  active: 'Active',
  degraded: 'Degraded',
  quarantined: 'Quarantined',
  disabled: 'Disabled',
};

const STATUS_COLORS: Record<string, string> = {
  probation: 'gold',
  active: 'green',
  degraded: 'orange',
  quarantined: 'red',
  disabled: 'default',
};

export default function EntriesPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canManage } = useSelectorRegistryPermissions();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [appFilter, setAppFilter] = useState<number | undefined>(undefined);
  const [versionsEntry, setVersionsEntry] = useState<SelectorEntry | null>(null);
  const [revalidateEntry, setRevalidateEntry] = useState<SelectorEntry | null>(null);
  const [domSnippet, setDomSnippet] = useState('');
  const [revalidateResult, setRevalidateResult] = useState<RevalidateResult | null>(null);
  const [revalidating, setRevalidating] = useState(false);
  const [updatingEntryId, setUpdatingEntryId] = useState<number | null>(null);

  const appsRequest = useRequest(() =>
    ctx.api.request<NocoBaseListBody<SelectorAppOption>>({
      url: 'selectorApps:list',
      method: 'get',
      params: { sort: ['name'], pageSize: 200 },
    }),
  );
  const apps = unwrapRecords<SelectorAppOption>(appsRequest.data);

  const request = useRequest(
    () =>
      ctx.api.request<NocoBaseListBody<SelectorEntry>>({
        url: 'selectorEntries:list',
        method: 'get',
        params: {
          filter: {
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(appFilter != null ? { appId: appFilter } : {}),
          },
          sort: ['-updatedAt'],
          appends: ['app'],
          page,
          pageSize,
        },
      }),
    { refreshDeps: [page, pageSize, statusFilter, appFilter] },
  );
  const entries = unwrapRecords<SelectorEntry>(request.data);
  const meta = unwrapListMeta(request.data);

  const updateEntry = async (entry: SelectorEntry, values: Record<string, unknown>) => {
    if (!canManage || updatingEntryId) {
      return;
    }
    setUpdatingEntryId(entry.id);
    try {
      await ctx.api.request<NocoBaseResponse<SelectorEntry>>({
        url: 'selectorEntries:update',
        method: 'post',
        params: { filterByTk: entry.id },
        data: values,
      });
      ctx.message.success(t('Entry updated'));
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setUpdatingEntryId(null);
    }
  };

  const openRevalidate = (entry: SelectorEntry) => {
    setRevalidateEntry(entry);
    setDomSnippet('');
    setRevalidateResult(null);
  };

  const closeRevalidate = () => {
    setRevalidateEntry(null);
    setDomSnippet('');
    setRevalidateResult(null);
  };

  const runRevalidate = async () => {
    if (!revalidateEntry || !canManage || revalidating) {
      return;
    }
    setRevalidating(true);
    try {
      const response = await ctx.api.request<NocoBaseResponse<RevalidateResult>>({
        url: 'selectorRegistryAdmin:revalidate',
        method: 'post',
        data: { entryId: revalidateEntry.id, domSnippet: domSnippet.trim() || undefined },
      });
      setRevalidateResult(unwrapData<RevalidateResult>(response) ?? null);
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setRevalidating(false);
    }
  };

  const columns: TableColumnsType<SelectorEntry> = [
    {
      title: t('Element Key'),
      key: 'elementKey',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          {record.name ? <span>{record.name}</span> : null}
          <Typography.Text
            code
            ellipsis={{ tooltip: record.elementKey }}
            style={{ maxWidth: 240, display: 'inline-block', marginBottom: 0 }}
          >
            {record.elementKey}
          </Typography.Text>
        </Space>
      ),
    },
    { title: t('App'), key: 'app', render: (_, record) => record.app?.name ?? '—' },
    {
      title: t('Current Selector'),
      key: 'currentSelector',
      render: (_, record) => (
        <Typography.Text
          code
          ellipsis={{ tooltip: record.currentSelector ?? undefined }}
          style={{ maxWidth: 280, display: 'inline-block', marginBottom: 0 }}
        >
          {record.currentSelector || '—'}
        </Typography.Text>
      ),
    },
    {
      title: t('Selector Type'),
      key: 'selectorType',
      render: (_, record) => <Tag>{record.selectorType}</Tag>,
    },
    {
      title: t('Status'),
      key: 'status',
      render: (_, record) => (
        <Space size={4}>
          <Tag color={STATUS_COLORS[record.status] ?? 'default'}>
            {t(ENTRY_STATUS_LABELS[record.status] ?? record.status)}
          </Tag>
          {record.pinned ? <Tag color="blue">{t('Pinned')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('Confidence'),
      key: 'confidence',
      render: (_, record) => (
        <Progress percent={Math.round(record.confidence * 100)} size="small" style={{ width: 120, marginBottom: 0 }} />
      ),
    },
    { title: t('Version'), key: 'version', render: (_, record) => record.version },
    { title: t('Hit Count'), key: 'hitCount', render: (_, record) => record.hitCount },
    { title: t('Success Count'), key: 'successCount', render: (_, record) => record.successCount },
    { title: t('Fail Count'), key: 'failCount', render: (_, record) => record.failCount },
    { title: t('Last Used'), key: 'lastUsedAt', render: (_, record) => record.lastUsedAt || '—' },
  ];

  if (canManage) {
    columns.push({
      title: t('Actions'),
      key: 'actions',
      render: (_, record) => (
        <Space wrap>
          <Button size="small" onClick={() => openRevalidate(record)}>
            {t('Revalidate')}
          </Button>
          <Button
            size="small"
            loading={updatingEntryId === record.id}
            onClick={() => updateEntry(record, { pinned: !record.pinned })}
          >
            {t(record.pinned ? 'Unpin' : 'Pin')}
          </Button>
          <Button
            size="small"
            loading={updatingEntryId === record.id}
            onClick={() => updateEntry(record, { status: record.status === 'disabled' ? 'probation' : 'disabled' })}
          >
            {t(record.status === 'disabled' ? 'Enable' : 'Disable')}
          </Button>
          <Button size="small" onClick={() => setVersionsEntry(record)}>
            {t('Versions')}
          </Button>
        </Space>
      ),
    });
  }

  return (
    <Card
      title={t('Selector Entries')}
      extra={
        <Button onClick={() => request.refresh()} loading={request.loading}>
          {t('Refresh')}
        </Button>
      }
    >
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          aria-label={t('Status')}
          allowClear
          placeholder={t('All Statuses')}
          style={{ width: 180 }}
          value={statusFilter}
          onChange={(value: string | undefined) => {
            setStatusFilter(value);
            setPage(1);
          }}
          options={ENTRY_STATUSES.map((status) => ({ value: status, label: t(ENTRY_STATUS_LABELS[status]) }))}
        />
        <Select
          aria-label={t('App')}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={t('All Apps')}
          style={{ width: 220 }}
          value={appFilter}
          loading={appsRequest.loading}
          onChange={(value: number | undefined) => {
            setAppFilter(value);
            setPage(1);
          }}
          options={apps.map((app) => ({ value: app.id, label: app.name }))}
        />
      </Space>
      <Table
        aria-label={t('Selector Entries')}
        rowKey="id"
        loading={request.loading}
        dataSource={entries}
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
      <Modal
        title={t('Revalidate')}
        open={Boolean(revalidateEntry)}
        onCancel={closeRevalidate}
        width={720}
        footer={[
          <Button key="close" onClick={closeRevalidate}>
            {t('Close')}
          </Button>,
        ]}
      >
        {revalidateEntry ? (
          <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
            <Typography.Text code>{revalidateEntry.elementKey}</Typography.Text>
            <Space direction="vertical" size={4} style={{ display: 'flex' }}>
              <Typography.Text strong>{t('DOM snippet (optional)')}</Typography.Text>
              <Input.TextArea rows={6} value={domSnippet} onChange={(event) => setDomSnippet(event.target.value)} />
            </Space>
            <Button type="primary" loading={revalidating} onClick={runRevalidate}>
              {t('Revalidate')}
            </Button>
            {revalidateResult ? (
              <Card size="small" title={t('Preview')}>
                <Descriptions column={1} size="small">
                  <Descriptions.Item label={t('Selector')}>
                    <Typography.Text code copyable>
                      {revalidateResult.selector ?? '—'}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Selector Type')}>{revalidateResult.selectorType}</Descriptions.Item>
                  <Descriptions.Item label={t('Source')}>{revalidateResult.source}</Descriptions.Item>
                  <Descriptions.Item label={t('Confidence')}>
                    {Math.round(revalidateResult.confidence * 100)}%
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Status')}>{revalidateResult.status}</Descriptions.Item>
                  <Descriptions.Item label={t('Heal Triggered')}>
                    {t(revalidateResult.healTriggered ? 'Yes' : 'No')}
                  </Descriptions.Item>
                  {revalidateResult.dryRunCandidate ? (
                    <Descriptions.Item label={t('Dry Run Candidate')}>
                      <Typography.Text code>{revalidateResult.dryRunCandidate.selector}</Typography.Text> (
                      {revalidateResult.dryRunCandidate.source})
                    </Descriptions.Item>
                  ) : null}
                </Descriptions>
              </Card>
            ) : null}
          </Space>
        ) : null}
      </Modal>
      <VersionsDrawer
        entry={versionsEntry}
        onClose={() => setVersionsEntry(null)}
        onRolledBack={() => request.refresh()}
      />
    </Card>
  );
}
