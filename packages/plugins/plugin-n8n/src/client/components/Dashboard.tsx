import React, { useState, useEffect } from 'react';
import { Card, Col, Row, Statistic, Table, Tag, Spin, Tooltip, Space, Select, Button, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ThunderboltOutlined,
  HeartOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  ReloadOutlined,
  CloudSyncOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

type RangeKey = '24h' | '7d' | '30d';

interface HistoryBucket {
  label: string;
  success: number;
  error: number;
  running: number;
}

// Simple SVG stacked bar chart for execution history (hourly or daily buckets)
const HistoryChart: React.FC<{
  data: HistoryBucket[];
  bucket: 'hour' | 'day';
}> = ({ data, bucket }) => {
  const t = useT();
  if (!data?.length) return null;

  const maxVal = Math.max(...data.map((d) => d.success + d.error + d.running), 1);
  const chartH = 140;
  const labelEvery = bucket === 'hour' ? 3 : Math.max(1, Math.floor(data.length / 10));

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        {bucket === 'hour' ? t('Execution History (24h)') : t('Execution History')}
      </div>
      <svg
        width="100%"
        height={chartH + 24}
        viewBox={`0 0 ${data.length * 30} ${chartH + 24}`}
        preserveAspectRatio="none"
      >
        {data.map((d, i) => {
          const total = d.success + d.error + d.running;
          const totalH = (total / maxVal) * chartH;
          const successH = (d.success / maxVal) * chartH;
          const errorH = (d.error / maxVal) * chartH;
          const runningH = (d.running / maxVal) * chartH;
          const x = i * 30 + 2;
          const w = 26;
          const y = chartH - totalH;

          return (
            <g key={i}>
              <title>{`${d.label}\n${t('Success')}: ${d.success}\n${t('Error')}: ${d.error}\n${t('Running')}: ${
                d.running
              }`}</title>
              {d.success > 0 && <rect x={x} y={y} width={w} height={successH} fill="#52c41a" rx={2} opacity={0.85} />}
              {d.error > 0 && (
                <rect x={x} y={y + successH} width={w} height={errorH} fill="#ff4d4f" rx={2} opacity={0.85} />
              )}
              {d.running > 0 && (
                <rect
                  x={x}
                  y={y + successH + errorH}
                  width={w}
                  height={runningH}
                  fill="#1890ff"
                  rx={2}
                  opacity={0.85}
                />
              )}
              {i % labelEvery === 0 && (
                <text x={x + w / 2} y={chartH + 16} textAnchor="middle" fontSize={9} fill="#999">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#666', marginTop: 4 }}>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              backgroundColor: '#52c41a',
              borderRadius: 2,
              marginRight: 4,
            }}
          />
          {t('Success')}
        </span>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              backgroundColor: '#ff4d4f',
              borderRadius: 2,
              marginRight: 4,
            }}
          />
          {t('Error')}
        </span>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              backgroundColor: '#1890ff',
              borderRadius: 2,
              marginRight: 4,
            }}
          />
          {t('Running')}
        </span>
      </div>
    </div>
  );
};

// Simple SVG doughnut chart for status breakdown
const StatusDoughnut: React.FC<{
  success: number;
  error: number;
  running: number;
  waiting: number;
}> = ({ success, error, running, waiting }) => {
  const t = useT();
  const total = success + error + running + waiting;
  if (total === 0) return <div style={{ color: '#999', textAlign: 'center', padding: 20 }}>No data</div>;

  const segments = [
    { value: success, color: '#52c41a', label: t('Success') },
    { value: error, color: '#ff4d4f', label: t('Error') },
    { value: running, color: '#1890ff', label: t('Running') },
    { value: waiting, color: '#faad14', label: t('Waiting') },
  ].filter((s) => s.value > 0);

  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const r = 55;
  const innerR = 35;

  let startAngle = -90;
  const paths = segments.map((seg) => {
    const angle = (seg.value / total) * 360;
    const endAngle = startAngle + angle;
    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const largeArc = angle > 180 ? 1 : 0;

    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const ix1 = cx + innerR * Math.cos(endRad);
    const iy1 = cy + innerR * Math.sin(endRad);
    const ix2 = cx + innerR * Math.cos(startRad);
    const iy2 = cy + innerR * Math.sin(startRad);

    const d = `M${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} L${ix1},${iy1} A${innerR},${innerR} 0 ${largeArc} 0 ${ix2},${iy2} Z`;
    startAngle = endAngle;
    return { d, color: seg.color, label: seg.label, value: seg.value, pct: Math.round((seg.value / total) * 100) };
  });

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('Status Breakdown')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {paths.map((p, i) => (
            <Tooltip key={i} title={`${p.label}: ${p.value} (${p.pct}%)`}>
              <path d={p.d} fill={p.color} stroke="#fff" strokeWidth={1.5} style={{ cursor: 'pointer' }} />
            </Tooltip>
          ))}
          <text x={cx} y={cy - 4} textAnchor="middle" fontSize={18} fontWeight={700} fill="#333">
            {total}
          </text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize={10} fill="#999">
            total
          </text>
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
          {paths.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: p.color, flexShrink: 0 }} />
              <span style={{ color: '#666' }}>{p.label}</span>
              <span style={{ fontWeight: 600 }}>{p.value}</span>
              <span style={{ color: '#999' }}>({p.pct}%)</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

const STATUS_COLORS: Record<string, string> = {
  success: 'green',
  error: 'red',
  running: 'blue',
  waiting: 'orange',
};

export const Dashboard: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { instanceId } = useCurrentInstance();
  const [range, setRange] = useState<RangeKey>('24h');
  const [refreshInterval, setRefreshInterval] = useState<number>(0);
  const [collecting, setCollecting] = useState(false);
  const { data, loading, refresh } = useN8nRequest('n8nMonitoring', 'dashboard', { range });

  useEffect(() => {
    if (refreshInterval > 0) {
      const timer = setInterval(() => {
        refresh();
      }, refreshInterval * 1000);
      return () => clearInterval(timer);
    }
  }, [refreshInterval, refresh]);

  // Force a collector cycle, then reload dashboard data from DB
  const collectAndRefresh = async () => {
    setCollecting(true);
    try {
      await api.request({ url: 'n8nMonitoring:collectNow', params: { instanceId } });
    } catch {
      // collector may be locked by a concurrent cycle — data refresh below still works
    }
    await refresh();
    setCollecting(false);
  };

  if (loading && !data) return <Spin size="large" style={{ display: 'block', margin: '60px auto' }} />;
  if (!data) return null;

  const { health, collector, workflows, executions, uptimePct, queue, bucket, history, recentFailures, workflowStats } =
    data;

  const failureColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 100 },
    {
      title: t('Workflow'),
      key: 'workflow',
      render: (_: unknown, r: any) => r.workflowName || `#${r.workflowId}`,
    },
    {
      title: t('Started'),
      dataIndex: 'startedAt',
      key: 'startedAt',
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
    {
      title: t('Duration'),
      dataIndex: 'durationMs',
      key: 'durationMs',
      render: (v: number) => (v ? formatDuration(v) : '-'),
    },
  ];

  const workflowColumns = [
    {
      title: t('Name'),
      key: 'name',
      ellipsis: true,
      render: (_: unknown, r: any) => (
        <Space size={4}>
          <span>{r.name || `#${r.workflowId}`}</span>
          {r.active ? <Tag color="green">{t('Active')}</Tag> : <Tag>{t('Inactive')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('Last Run'),
      key: 'lastRun',
      width: 190,
      render: (_: unknown, r: any) =>
        r.lastRunAt ? (
          <Space size={4}>
            <Tag color={STATUS_COLORS[r.lastStatus] || 'default'}>{r.lastStatus}</Tag>
            <span style={{ color: '#999', fontSize: 12 }}>{new Date(r.lastRunAt).toLocaleString()}</span>
          </Space>
        ) : (
          <span style={{ color: '#bbb' }}>{t('Never run')}</span>
        ),
    },
    {
      title: t('Runs'),
      dataIndex: 'totalRuns',
      key: 'totalRuns',
      width: 80,
      sorter: (a: any, b: any) => a.totalRuns - b.totalRuns,
    },
    {
      title: t('Success Rate'),
      key: 'successRate',
      width: 120,
      sorter: (a: any, b: any) => (a.successRate ?? -1) - (b.successRate ?? -1),
      render: (_: unknown, r: any) =>
        r.successRate === null ? (
          <span style={{ color: '#bbb' }}>-</span>
        ) : (
          <span
            style={{
              color: r.successRate >= 80 ? '#3f8600' : r.successRate >= 50 ? '#faad14' : '#cf1322',
              fontWeight: 600,
            }}
          >
            {r.successRate}%
          </span>
        ),
    },
    {
      title: t('Errors'),
      dataIndex: 'errorCount',
      key: 'errorCount',
      width: 80,
      sorter: (a: any, b: any) => a.errorCount - b.errorCount,
      render: (v: number) => <span style={{ color: v > 0 ? '#cf1322' : undefined }}>{v}</span>,
    },
    {
      title: t('Avg Duration'),
      key: 'avgDuration',
      width: 110,
      sorter: (a: any, b: any) => (a.avgDuration ?? 0) - (b.avgDuration ?? 0),
      render: (_: unknown, r: any) => (r.avgDuration ? formatDuration(r.avgDuration) : '-'),
    },
  ];

  const successRate = executions?.successRate || 0;
  const rateColor = successRate >= 80 ? '#3f8600' : successRate >= 50 ? '#faad14' : '#cf1322';
  const lastCollected = collector?.lastCollectedAt ? new Date(collector.lastCollectedAt).toLocaleTimeString() : null;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <Space size={12}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{t('Dashboard')}</span>
          {lastCollected && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <CloudSyncOutlined style={{ marginRight: 4 }} />
              {t('Last Collected')}: {lastCollected}
            </Typography.Text>
          )}
        </Space>
        <Space>
          <Select
            value={range}
            onChange={(v) => setRange(v as RangeKey)}
            options={[
              { value: '24h', label: t('Last 24 Hours') },
              { value: '7d', label: t('Last 7 Days') },
              { value: '30d', label: t('Last 30 Days') },
            ]}
            style={{ width: 140 }}
          />
          <span>{t('Auto Refresh')}:</span>
          <Select
            value={refreshInterval}
            onChange={setRefreshInterval}
            options={[
              { value: 0, label: t('Off') },
              { value: 10, label: '10s' },
              { value: 30, label: '30s' },
              { value: 60, label: '1m' },
              { value: 300, label: '5m' },
            ]}
            style={{ width: 100 }}
          />
          <Button icon={<ReloadOutlined />} loading={collecting} onClick={collectAndRefresh}>
            {t('Refresh')}
          </Button>
        </Space>
      </div>
      {/* KPI Cards */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Health')}
              value={health?.status === 'healthy' ? t('Healthy') : t('Unhealthy')}
              valueStyle={{ color: health?.status === 'healthy' ? '#3f8600' : '#cf1322', fontSize: 18 }}
              prefix={<HeartOutlined />}
              suffix={
                <span style={{ fontSize: 12, color: '#999' }}>{health?.latencyMs ? `${health.latencyMs}ms` : ''}</span>
              }
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Uptime')}
              value={uptimePct === null || uptimePct === undefined ? '-' : uptimePct}
              suffix={uptimePct === null || uptimePct === undefined ? '' : '%'}
              valueStyle={{ fontSize: 18, color: uptimePct !== null && uptimePct < 95 ? '#cf1322' : '#3f8600' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Active Workflows')}
              value={workflows?.active || 0}
              suffix={<span style={{ fontSize: 14, color: '#999' }}>/ {workflows?.total || 0}</span>}
              prefix={<ThunderboltOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Success Rate')}
              value={successRate}
              suffix="%"
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: rateColor, fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Total Executions')}
              value={executions?.total || 0}
              prefix={<DashboardOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Errors')}
              value={executions?.error || 0}
              prefix={<CloseCircleOutlined />}
              valueStyle={{ color: (executions?.error || 0) > 0 ? '#cf1322' : '#999', fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Avg Duration')}
              value={executions?.avgDuration ? formatDuration(executions.avgDuration) : '-'}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Queue Throughput')}
              value={queue ? queue.throughput.toFixed(2) : '-'}
              suffix={queue ? '/s' : ''}
              valueStyle={{ fontSize: 18 }}
              prefix={<DashboardOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* Charts */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={16}>
          <Card size="small">
            <HistoryChart data={history || []} bucket={bucket || 'hour'} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small">
            <StatusDoughnut
              success={executions?.success || 0}
              error={executions?.error || 0}
              running={executions?.running || 0}
              waiting={executions?.waiting || 0}
            />
          </Card>
        </Col>
      </Row>

      {/* Per-workflow Stats */}
      {workflowStats?.length > 0 && (
        <Card title={t('Workflow Stats')} size="small" style={{ marginTop: 16 }}>
          <Table
            columns={workflowColumns}
            dataSource={workflowStats}
            rowKey="workflowId"
            pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
            size="small"
          />
        </Card>
      )}

      {/* Recent Failures */}
      {recentFailures?.length > 0 && (
        <Card title={t('Recent Failures')} size="small" style={{ marginTop: 16 }}>
          <Table columns={failureColumns} dataSource={recentFailures} rowKey="id" pagination={false} size="small" />
        </Card>
      )}
    </div>
  );
};
