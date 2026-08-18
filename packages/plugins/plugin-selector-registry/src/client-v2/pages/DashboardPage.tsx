import React from 'react';
import { Button, Card, Col, Row, Space, Statistic, Table, type TableColumnsType, Tag, Typography } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { type NocoBaseResponse, unwrapData } from './api';

type TopFailingEntry = {
  id: number;
  elementKey: string;
  name: string | null;
  status: string;
  failCount: number;
  confidence: number;
};

type StatsPayload = {
  entries: { total: number; byStatus: Record<string, number> };
  apps: { total: number };
  recentResolves: { sampled: number; byPath: Record<string, number>; cacheHitRate: number | null };
  recentFeedback: { sampled: number; byOutcome: Record<string, number> };
  topFailing: TopFailingEntry[];
};

const ENTRY_STATUS_ORDER = ['probation', 'active', 'degraded', 'quarantined', 'disabled'] as const;

export const ENTRY_STATUS_LABELS: Record<string, string> = {
  probation: 'Probation',
  active: 'Active',
  degraded: 'Degraded',
  quarantined: 'Quarantined',
  disabled: 'Disabled',
};

export const STATUS_COLORS: Record<string, string> = {
  probation: 'gold',
  active: 'green',
  degraded: 'orange',
  quarantined: 'red',
  disabled: 'default',
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

const OUTCOME_COLORS: Record<string, string> = {
  success: 'green',
  verified: 'green',
  fail: 'red',
  mismatch: 'red',
};

export default function DashboardPage() {
  const ctx = useFlowContext();
  const t = useT();
  const request = useRequest(() =>
    ctx.api.request<NocoBaseResponse<StatsPayload>>({ url: 'selectorRegistryAdmin:stats', method: 'get' }),
  );
  const stats = unwrapData<StatsPayload>(request.data);
  const cacheHitRate = stats?.recentResolves.cacheHitRate ?? null;

  const topFailingColumns: TableColumnsType<TopFailingEntry> = [
    {
      title: t('Element Key'),
      key: 'elementKey',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          {record.name ? <span>{record.name}</span> : null}
          <Typography.Text
            code
            ellipsis={{ tooltip: record.elementKey }}
            style={{ maxWidth: 320, display: 'inline-block', marginBottom: 0 }}
          >
            {record.elementKey}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Status'),
      key: 'status',
      render: (_, record) => (
        <Tag color={STATUS_COLORS[record.status] ?? 'default'}>
          {t(ENTRY_STATUS_LABELS[record.status] ?? record.status)}
        </Tag>
      ),
    },
    { title: t('Fail Count'), key: 'failCount', render: (_, record) => record.failCount },
    {
      title: t('Confidence'),
      key: 'confidence',
      render: (_, record) => `${Math.round(record.confidence * 100)}%`,
    },
  ];

  return (
    <Card
      title={t('Dashboard')}
      extra={
        <Button onClick={() => request.refresh()} loading={request.loading}>
          {t('Refresh')}
        </Button>
      }
    >
      <Space direction="vertical" size="large" style={{ display: 'flex' }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={8}>
            <Card>
              <Statistic title={t('Total Entries')} value={stats?.entries.total ?? 0} />
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card>
              <Statistic title={t('Total Apps')} value={stats?.apps.total ?? 0} />
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card>
              <Statistic
                title={t('Cache Hit Rate')}
                value={cacheHitRate == null ? '—' : Math.round(cacheHitRate * 10000) / 100}
                suffix={cacheHitRate == null ? undefined : '%'}
              />
            </Card>
          </Col>
        </Row>
        <Card title={t('Status')} size="small">
          <Space wrap>
            {ENTRY_STATUS_ORDER.map((status) => (
              <Tag key={status} color={STATUS_COLORS[status] ?? 'default'}>
                {t(ENTRY_STATUS_LABELS[status])}: {stats?.entries.byStatus[status] ?? 0}
              </Tag>
            ))}
          </Space>
        </Card>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Card title={t('Recent Resolves')} size="small">
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                {t('Sampled')}: {stats?.recentResolves.sampled ?? 0}
              </Typography.Paragraph>
              <Space wrap>
                {Object.entries(stats?.recentResolves.byPath ?? {}).map(([path, count]) => (
                  <Tag key={path} color={PATH_COLORS[path] ?? 'default'}>
                    {path}: {count}
                  </Tag>
                ))}
              </Space>
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card title={t('Recent Feedback')} size="small">
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                {t('Sampled')}: {stats?.recentFeedback.sampled ?? 0}
              </Typography.Paragraph>
              <Space wrap>
                {Object.entries(stats?.recentFeedback.byOutcome ?? {}).map(([outcome, count]) => (
                  <Tag key={outcome} color={OUTCOME_COLORS[outcome] ?? 'default'}>
                    {outcome}: {count}
                  </Tag>
                ))}
              </Space>
            </Card>
          </Col>
        </Row>
        <Card title={t('Top Failing')} size="small">
          <Table
            aria-label={t('Top Failing')}
            rowKey="id"
            size="small"
            loading={request.loading}
            dataSource={stats?.topFailing ?? []}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: t('No data') }}
            columns={topFailingColumns}
          />
        </Card>
      </Space>
    </Card>
  );
}
