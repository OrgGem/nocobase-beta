/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo, useState } from 'react';
import { Alert, Button, Card, DatePicker, Form, Input, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import { useRequest } from '../hooks/useApiRequest';
import { useT } from '../skill-hub/locale';
import { AIEmployeeSelect } from './AIEmployeeSelect';

const { Text } = Typography;

type UsageFilterValues = {
  dates?: [Dayjs, Dayjs];
  provider?: string;
  llmService?: string;
  model?: string;
  employeeUsername?: string;
  userId?: string;
  departmentId?: string;
  includeInferredDepartment?: boolean;
};

type UsageAmounts = {
  calls?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  actualCalls?: number;
  estimatedCalls?: number;
  missingCalls?: number;
  unpricedCalls?: number;
};

type UsageSummary = UsageAmounts & {
  costByCurrency?: Array<{ currency: string; knownCost: number | string | null }>;
  coverage?: {
    departmentAttribution?: string;
    source?: string;
    snapshotCalls?: number;
    inferredCalls?: number;
    unattributedCalls?: number;
    unidentifiedCalls?: number;
  };
};

type UsageGroup = UsageAmounts & {
  key?: string | number | null;
  knownCost?: number | string | null;
  currency?: string | null;
  departmentAttribution?: string | null;
};

type UsageCall = UsageAmounts & {
  id: string | number;
  usageOccurredAt?: string | null;
  startedAt?: string | null;
  createdAt?: string | null;
  model?: string | null;
  provider?: string | null;
  llmService?: string | null;
  employeeUsername?: string | null;
  userId?: string | number | null;
  departmentId?: string | number | null;
  departmentAttribution?: string | null;
  usageSource?: string | null;
  pricingStatus?: string | null;
  cost?: number | string | null;
  priceCurrency?: string | null;
  priceVersion?: string | null;
  usageSessionId?: string | null;
};

type ListResult<T> = { data?: T[]; meta?: { count?: number | null; hasMore?: boolean } };
type ValueResult<T> = { data?: T };

function numberText(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  const valueAsNumber = Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—';
}

function dateText(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

const defaultDates: [Dayjs, Dayjs] = [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')];

export const UsageGovernanceTab: React.FC = () => {
  const t = useT();
  const [form] = Form.useForm<UsageFilterValues>();
  const [filters, setFilters] = useState<Record<string, unknown>>({
    from: defaultDates[0].toISOString(),
    to: defaultDates[1].add(1, 'millisecond').toISOString(),
  });
  const [groupBy, setGroupBy] = useState('model');
  const [groupPage, setGroupPage] = useState(1);
  const [callPage, setCallPage] = useState(1);
  const [selectedCall, setSelectedCall] = useState<UsageCall | null>(null);

  const groupParams = useMemo(
    () => ({ ...filters, groupBy, page: groupPage, pageSize: 20 }),
    [filters, groupBy, groupPage],
  );
  const callParams = useMemo(() => ({ ...filters, page: callPage, pageSize: 20 }), [filters, callPage]);
  const summaryRequest = useRequest<ValueResult<UsageSummary>>(
    { url: 'agentUsage:summary', params: filters },
    { refreshDeps: [filters] },
  );
  const groupRequest = useRequest<ListResult<UsageGroup>>(
    { url: 'agentUsage:breakdown', params: groupParams },
    { refreshDeps: [groupParams] },
  );
  const callRequest = useRequest<ListResult<UsageCall>>(
    { url: 'agentUsage:calls', params: callParams },
    { refreshDeps: [callParams] },
  );
  const summary = summaryRequest.data?.data;

  const applyFilters = (values: UsageFilterValues) => {
    const [start, end] = values.dates || defaultDates;
    const next: Record<string, unknown> = {
      from: start.startOf('day').toISOString(),
      to: end.add(1, 'day').startOf('day').toISOString(),
    };
    for (const name of ['provider', 'llmService', 'model', 'employeeUsername', 'userId', 'departmentId'] as const) {
      const value = values[name]?.trim();
      if (value) next[name] = value;
    }
    if (values.includeInferredDepartment) next.includeInferredDepartment = true;
    setGroupPage(1);
    setCallPage(1);
    setSelectedCall(null);
    setFilters(next);
  };

  const groupColumns: ColumnsType<UsageGroup> = [
    { title: t('Group'), dataIndex: 'key', render: (value: UsageGroup['key']) => value ?? t('Unknown') },
    {
      title: t('Department attribution'),
      dataIndex: 'departmentAttribution',
      render: (value: string | null) => (value ? t(`Usage attribution: ${value}`) : '—'),
    },
    { title: t('Model calls'), dataIndex: 'calls', render: numberText },
    { title: t('Input tokens'), dataIndex: 'inputTokens', render: numberText },
    { title: t('Output tokens'), dataIndex: 'outputTokens', render: numberText },
    {
      title: t('Priced subtotal'),
      key: 'cost',
      render: (_, row) => `${numberText(row.knownCost)} ${row.currency || ''}`,
    },
    { title: t('Missing usage calls'), dataIndex: 'missingCalls', render: numberText },
    { title: t('Unpriced calls'), dataIndex: 'unpricedCalls', render: numberText },
  ];
  const callColumns: ColumnsType<UsageCall> = [
    {
      title: t('Time'),
      key: 'time',
      render: (_, row) => dateText(row.usageOccurredAt || row.startedAt || row.createdAt),
    },
    { title: t('Model'), dataIndex: 'model', render: (value: string | null) => value || '—' },
    { title: t('Employee'), dataIndex: 'employeeUsername', render: (value: string | null) => value || '—' },
    { title: t('User ID'), dataIndex: 'userId', render: (value: string | number | null) => value ?? '—' },
    { title: t('Department ID'), dataIndex: 'departmentId', render: (value: string | number | null) => value ?? '—' },
    { title: t('Input tokens'), dataIndex: 'inputTokens', render: numberText },
    { title: t('Output tokens'), dataIndex: 'outputTokens', render: numberText },
    { title: t('Cost'), key: 'cost', render: (_, row) => `${numberText(row.cost)} ${row.priceCurrency || ''}` },
    {
      title: t('Usage source'),
      dataIndex: 'usageSource',
      render: (value: string | null) => (value ? t(value) : t('Unknown')),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_, row) => <Button onClick={() => setSelectedCall(row)}>{t('Details')}</Button>,
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={t('Usage ledger coverage')}
        description={t('Usage ledger coverage description')}
      />
      <Card title={t('Usage filters')}>
        <Form form={form} layout="vertical" initialValues={{ dates: defaultDates }} onFinish={applyFilters}>
          <Space wrap align="start">
            <Form.Item
              name="dates"
              label={t('Date range')}
              rules={[{ required: true, message: t('Select a date range') }]}
            >
              <DatePicker.RangePicker allowClear={false} />
            </Form.Item>
            <Form.Item name="employeeUsername" label={t('Employee')}>
              <AIEmployeeSelect placeholder={t('All employees')} />
            </Form.Item>
            <Form.Item name="provider" label={t('Provider')}>
              <Input allowClear />
            </Form.Item>
            <Form.Item name="llmService" label={t('LLM service')}>
              <Input allowClear />
            </Form.Item>
            <Form.Item name="model" label={t('Model')}>
              <Input allowClear />
            </Form.Item>
            <Form.Item name="userId" label={t('User ID')}>
              <Input allowClear inputMode="numeric" />
            </Form.Item>
            <Form.Item name="departmentId" label={t('Department ID')}>
              <Input allowClear inputMode="numeric" />
            </Form.Item>
          </Space>
          <Form.Item name="includeInferredDepartment" valuePropName="checked" label={t('Include inferred departments')}>
            <Switch aria-label={t('Include inferred departments')} />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            {t('Apply filters')}
          </Button>
        </Form>
      </Card>
      {Boolean(summaryRequest.error || groupRequest.error || callRequest.error) && (
        <Alert type="error" showIcon message={t('Unable to load usage data')} />
      )}
      <Card title={t('Usage summary')} loading={summaryRequest.loading}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Tag>
              {t('Model calls')}: {numberText(summary?.calls)}
            </Tag>
            <Tag>
              {t('Input tokens')}: {numberText(summary?.inputTokens)}
            </Tag>
            <Tag>
              {t('Output tokens')}: {numberText(summary?.outputTokens)}
            </Tag>
            <Tag>
              {t('Cached input tokens')}: {numberText(summary?.cachedTokens)}
            </Tag>
            <Tag>
              {t('Reasoning tokens')}: {numberText(summary?.reasoningTokens)}
            </Tag>
            <Tag>
              {t('Actual usage calls')}: {numberText(summary?.actualCalls)}
            </Tag>
            <Tag color="gold">
              {t('Estimated calls')}: {numberText(summary?.estimatedCalls)}
            </Tag>
            <Tag color="gold">
              {t('Missing usage calls')}: {numberText(summary?.missingCalls)}
            </Tag>
            <Tag color="gold">
              {t('Unpriced calls')}: {numberText(summary?.unpricedCalls)}
            </Tag>
          </Space>
          <Space wrap>
            <Tag>
              {t('Department snapshot calls')}: {numberText(summary?.coverage?.snapshotCalls)}
            </Tag>
            <Tag>
              {t('Department inferred calls')}: {numberText(summary?.coverage?.inferredCalls)}
            </Tag>
            <Tag color="gold">
              {t('Department unattributed calls')}: {numberText(summary?.coverage?.unattributedCalls)}
            </Tag>
            <Tag color="gold">
              {t('Calls without usage identity')}: {numberText(summary?.coverage?.unidentifiedCalls)}
            </Tag>
          </Space>
          <Text>
            {t('Priced subtotal')}:{' '}
            {summary?.costByCurrency?.length
              ? summary.costByCurrency.map((item) => `${numberText(item.knownCost)} ${item.currency}`).join(', ')
              : '—'}
          </Text>
          <Text type="secondary">{t('Inferred departments are current membership only')}</Text>
        </Space>
      </Card>
      <Card
        title={t('Usage breakdown')}
        extra={
          <Select
            aria-label={t('Group by')}
            value={groupBy}
            style={{ width: 180 }}
            onChange={(value) => {
              setGroupPage(1);
              setGroupBy(value);
            }}
            options={[
              { value: 'model', label: t('Model') },
              { value: 'provider', label: t('Provider') },
              { value: 'llmService', label: t('LLM service') },
              { value: 'employeeUsername', label: t('Employee') },
              { value: 'userId', label: t('User') },
              { value: 'departmentId', label: t('Department') },
            ]}
          />
        }
      >
        <Table<UsageGroup>
          rowKey={(row) => `${row.key ?? 'unknown'}:${row.currency ?? ''}:${row.departmentAttribution ?? ''}`}
          columns={groupColumns}
          dataSource={groupRequest.data?.data || []}
          loading={groupRequest.loading}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: groupPage,
            pageSize: 20,
            total:
              (groupPage - 1) * 20 +
              (groupRequest.data?.data?.length || 0) +
              (groupRequest.data?.meta?.hasMore ? 1 : 0),
            showSizeChanger: false,
            onChange: setGroupPage,
          }}
        />
      </Card>
      <Card title={t('Model calls')}>
        <Table<UsageCall>
          rowKey="id"
          columns={callColumns}
          dataSource={callRequest.data?.data || []}
          loading={callRequest.loading}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: callPage,
            pageSize: 20,
            total: callRequest.data?.meta?.count || 0,
            onChange: setCallPage,
          }}
        />
      </Card>
      {selectedCall && (
        <Card
          title={t('Model call details')}
          extra={<Button onClick={() => setSelectedCall(null)}>{t('Close')}</Button>}
        >
          <Space direction="vertical">
            <Text>
              {t('Provider')}: {selectedCall.provider || '—'}
            </Text>
            <Text>
              {t('LLM service')}: {selectedCall.llmService || '—'}
            </Text>
            <Text>
              {t('Cached input tokens')}: {numberText(selectedCall.cachedTokens)}
            </Text>
            <Text>
              {t('Reasoning tokens')}: {numberText(selectedCall.reasoningTokens)}
            </Text>
            <Text>
              {t('Department attribution')}:{' '}
              {selectedCall.departmentAttribution
                ? t(`Usage attribution: ${selectedCall.departmentAttribution}`)
                : t('Unknown')}
            </Text>
            <Text>
              {t('Pricing status')}: {selectedCall.pricingStatus || '—'}
            </Text>
            <Text>
              {t('Price version')}: {selectedCall.priceVersion || '—'}
            </Text>
            <Text>
              {t('Session')}: {selectedCall.usageSessionId || '—'}
            </Text>
          </Space>
        </Card>
      )}
    </Space>
  );
};
