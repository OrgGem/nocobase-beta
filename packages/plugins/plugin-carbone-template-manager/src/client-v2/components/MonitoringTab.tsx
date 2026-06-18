import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Drawer, Row, Select, Space, Statistic, Table, Tag } from 'antd';
import { ReloadOutlined, EyeOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '../adapters';
import { useCarboneTranslation } from '../locale';
import { COLLECTION } from '../../shared/constants';

interface LogRow {
  id: number;
  action: 'renderById' | 'renderDirect' | 'test';
  templateId?: number | null;
  carboneTemplateId?: string | null;
  format?: string | null;
  filename?: string | null;
  userId?: number | null;
  roleName?: string | null;
  ip?: string | null;
  cacheHit?: boolean | null;
  inputBytes?: number | null;
  outputBytes?: number | null;
  durationMs?: number | null;
  status: 'success' | 'error' | 'rate_limited';
  errorMessage?: string | null;
  inputData?: unknown;
  createdAt: string;
}

interface Summary {
  windowHours: number;
  total: number;
  success: number;
  errors: number;
  rateLimited: number;
  cacheHitRatio: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  hourly: { t: string; count: number; errors: number; hits: number }[];
}

const STATUS_COLORS: Record<LogRow['status'], string> = {
  success: 'green',
  error: 'red',
  rate_limited: 'orange',
};

/**
 * P5 monitoring dashboard. Top row: KPI cards. Middle: hourly traffic
 * sparkline (rendered as a tiny inline SVG to avoid pulling chart deps).
 * Bottom: logs table with status filter and a drawer to inspect input data.
 */
export const MonitoringTab: React.FC = () => {
  const api = useAPIClient();
  const { t } = useCarboneTranslation();
  const [hours, setHours] = useState(24);
  const [statusFilter, setStatusFilter] = useState<'all' | LogRow['status']>('all');
  const [inspecting, setInspecting] = useState<LogRow | null>(null);
  const [templateNames, setTemplateNames] = useState<Record<number, string>>({});

  const summaryReq = useRequest<{ data: Summary }>(
    () =>
      api
        .resource(COLLECTION.renderLogs)
        .summary({ values: { hours } })
        .then((r: any) => r.data),
    { refreshDeps: [hours] },
  );

  const logsReq = useRequest<{ data: LogRow[] }>(
    () =>
      api
        .resource(COLLECTION.renderLogs)
        .list({
          pageSize: 100,
          sort: ['-createdAt'],
          filter: {
            createdAt: { $gte: new Date(Date.now() - hours * 3_600_000).toISOString() },
            ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
          },
        })
        .then((r: any) => r.data),
    { refreshDeps: [hours, statusFilter] },
  );

  useEffect(() => {
    api
      .resource(COLLECTION.templates)
      .list({ pageSize: 200, fields: ['id', 'name'] })
      .then((r: any) => {
        const map: Record<number, string> = {};
        for (const row of r?.data?.data || []) map[row.id] = row.name;
        setTemplateNames(map);
      })
      .catch(() => undefined);
  }, [api]);

  const refresh = () => {
    summaryReq.refresh();
    logsReq.refresh();
  };

  const summary = summaryReq.data?.data;

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          value={hours}
          onChange={setHours}
          options={[
            { value: 1, label: t('Last hour') },
            { value: 24, label: t('Last 24 hours') },
            { value: 24 * 7, label: t('Last 7 days') },
            { value: 24 * 30, label: t('Last 30 days') },
          ]}
          style={{ width: 180 }}
        />
        <Select
          value={statusFilter}
          onChange={setStatusFilter as any}
          options={[
            { value: 'all', label: t('All statuses') },
            { value: 'success', label: t('Success') },
            { value: 'error', label: t('Error') },
            { value: 'rate_limited', label: t('Rate limited') },
          ]}
          style={{ width: 160 }}
        />
        <Button icon={<ReloadOutlined />} onClick={refresh}>
          {t('Refresh')}
        </Button>
      </Space>

      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title={t('Total renders')} value={summary?.total ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={t('Cache hit ratio')}
              value={summary ? Math.round(summary.cacheHitRatio * 1000) / 10 : 0}
              suffix="%"
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={t('Latency p95 (ms)')}
              value={summary?.latencyP95 ?? 0}
              valueStyle={{ color: (summary?.latencyP95 ?? 0) > 5000 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={t('Errors')}
              value={summary?.errors ?? 0}
              suffix={summary?.rateLimited ? ` (+${summary.rateLimited} ${t('rate limited')})` : undefined}
              valueStyle={{ color: (summary?.errors ?? 0) > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small" title={t('Hourly traffic')} style={{ marginTop: 16 }}>
        <Sparkline buckets={summary?.hourly} />
      </Card>

      <Card size="small" title={t('Render logs')} style={{ marginTop: 16 }}>
        <Table<LogRow>
          rowKey="id"
          loading={logsReq.loading}
          dataSource={logsReq.data?.data || []}
          pagination={{ pageSize: 20 }}
          size="small"
          columns={[
            {
              title: t('When'),
              dataIndex: 'createdAt',
              width: 160,
              render: (v) => new Date(v).toLocaleString(),
            },
            {
              title: t('Action'),
              dataIndex: 'action',
              width: 110,
              render: (a) => <Tag>{a}</Tag>,
            },
            {
              title: t('Template'),
              dataIndex: 'templateId',
              width: 200,
              render: (id, row) =>
                id ? (
                  templateNames[id] || `#${id}`
                ) : row.carboneTemplateId ? (
                  <code style={{ fontSize: 11 }}>{row.carboneTemplateId.slice(0, 12)}…</code>
                ) : (
                  <span style={{ color: '#aaa' }}>—</span>
                ),
            },
            {
              title: t('Output format'),
              dataIndex: 'format',
              width: 90,
              render: (f) => (f ? <Tag>{f.toUpperCase()}</Tag> : '—'),
            },
            {
              title: t('Cache'),
              dataIndex: 'cacheHit',
              width: 80,
              render: (h, row) =>
                row.action === 'test' ? (
                  <Tag color="orange">BYPASS</Tag>
                ) : h ? (
                  <Tag color="green">HIT</Tag>
                ) : (
                  <Tag color="gold">MISS</Tag>
                ),
            },
            {
              title: t('Render duration (ms)'),
              dataIndex: 'durationMs',
              width: 130,
            },
            {
              title: t('Size'),
              dataIndex: 'outputBytes',
              width: 100,
              render: (v) => (v ? `${(v / 1024).toFixed(1)} KB` : '—'),
            },
            {
              title: t('User'),
              dataIndex: 'userId',
              width: 110,
              render: (id, row) => (
                <span>
                  {id ? `#${id}` : <span style={{ color: '#aaa' }}>anon</span>}
                  {row.roleName ? <Tag style={{ marginLeft: 4 }}>{row.roleName}</Tag> : null}
                </span>
              ),
            },
            {
              title: t('Status'),
              dataIndex: 'status',
              width: 130,
              render: (s, row) => (
                <span>
                  <Tag color={STATUS_COLORS[s]}>{s}</Tag>
                  {row.errorMessage ? <span style={{ fontSize: 11, color: '#cf1322' }}>{row.errorMessage}</span> : null}
                </span>
              ),
            },
            {
              title: t('Actions'),
              key: 'actions',
              width: 120,
              render: (_, row) => (
                <Space>
                  <Button size="small" icon={<EyeOutlined />} onClick={() => setInspecting(row)}>
                    {t('Inspect')}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        open={!!inspecting}
        title={inspecting ? `Log #${inspecting.id} — ${inspecting.action}` : ''}
        width={640}
        onClose={() => setInspecting(null)}
        destroyOnClose
      >
        {inspecting && (
          <div>
            <p>
              <strong>{t('When')}:</strong> {new Date(inspecting.createdAt).toLocaleString()}
            </p>
            <p>
              <strong>{t('User')}:</strong> #{inspecting.userId ?? 'anon'}
              {inspecting.roleName ? ` (${inspecting.roleName})` : ''} · {inspecting.ip}
            </p>
            <p>
              <strong>{t('Template')}:</strong>{' '}
              {inspecting.templateId ? templateNames[inspecting.templateId] || `#${inspecting.templateId}` : '—'} ·{' '}
              {inspecting.format?.toUpperCase()}
            </p>
            {inspecting.errorMessage && (
              <p style={{ color: '#cf1322' }}>
                <strong>{t('Error')}:</strong> {inspecting.errorMessage}
              </p>
            )}
            <h4 style={{ marginTop: 16 }}>{t('Render input data (JSON)')}</h4>
            {inspecting.inputData ? (
              <pre
                style={{
                  background: '#fafafa',
                  border: '1px solid #f0f0f0',
                  padding: 8,
                  fontSize: 12,
                  maxHeight: 420,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(inspecting.inputData, null, 2)}
              </pre>
            ) : (
              <span style={{ color: '#aaa' }}>{t('Input data was not retained for this log')}</span>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
};

const Sparkline: React.FC<{ buckets?: { t: string; count: number; errors: number }[] }> = ({ buckets }) => {
  const data = useMemo(() => buckets || [], [buckets]);
  const max = useMemo(() => Math.max(1, ...data.map((d) => d.count)), [data]);
  if (!data.length) {
    return <span style={{ color: '#aaa' }}>—</span>;
  }
  const W = 800;
  const H = 80;
  const barW = Math.max(2, Math.floor(W / data.length) - 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }}>
      {data.map((d, i) => {
        const x = i * (barW + 2);
        const h = Math.round((d.count / max) * (H - 4));
        const eh = Math.round((d.errors / max) * (H - 4));
        return (
          <g key={d.t}>
            <rect x={x} y={H - h} width={barW} height={h} fill="#1677ff" />
            {eh > 0 && <rect x={x} y={H - eh} width={barW} height={eh} fill="#cf1322" />}
          </g>
        );
      })}
    </svg>
  );
};

export default MonitoringTab;
