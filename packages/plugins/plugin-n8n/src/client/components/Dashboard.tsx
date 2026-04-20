import React, { useMemo, useState, useEffect } from 'react';
import { Card, Col, Row, Statistic, Table, Tag, Spin, Tooltip, Space, Select, Button } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
  HeartOutlined,
  ClockCircleOutlined,
  PauseCircleOutlined,
  DashboardOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useT } from '../locale';

// Simple SVG bar chart for 24h execution history
const HourlyChart: React.FC<{
  data: Array<{ hour: string; success: number; error: number; running: number }>;
}> = ({ data }) => {
  const t = useT();
  if (!data?.length) return null;

  const maxVal = Math.max(...data.map((d) => d.success + d.error + d.running), 1);
  const barW = 100 / data.length;
  const chartH = 140;

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('Execution History (24h)')}</div>
      <svg width="100%" height={chartH + 24} viewBox={`0 0 ${data.length * 30} ${chartH + 24}`} preserveAspectRatio="none">
        {data.map((d, i) => {
          const total = d.success + d.error + d.running;
          const totalH = (total / maxVal) * chartH;
          const successH = (d.success / maxVal) * chartH;
          const errorH = (d.error / maxVal) * chartH;
          const runningH = (d.running / maxVal) * chartH;
          const x = i * 30 + 2;
          const w = 26;
          let y = chartH - totalH;

          return (
            <g key={i}>
              <title>{`${d.hour}\n${t('Success')}: ${d.success}\n${t('Error')}: ${d.error}\n${t('Running')}: ${d.running}`}</title>
              {/* Success bar */}
              {d.success > 0 && (
                <rect x={x} y={y} width={w} height={successH} fill="#52c41a" rx={2} opacity={0.85} />
              )}
              {/* Error bar */}
              {d.error > 0 && (
                <rect x={x} y={y + successH} width={w} height={errorH} fill="#ff4d4f" rx={2} opacity={0.85} />
              )}
              {/* Running bar */}
              {d.running > 0 && (
                <rect x={x} y={y + successH + errorH} width={w} height={runningH} fill="#1890ff" rx={2} opacity={0.85} />
              )}
              {/* Hour label */}
              {i % 3 === 0 && (
                <text x={x + w / 2} y={chartH + 16} textAnchor="middle" fontSize={9} fill="#999">
                  {d.hour}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#666', marginTop: 4 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, backgroundColor: '#52c41a', borderRadius: 2, marginRight: 4 }} />{t('Success')}</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, backgroundColor: '#ff4d4f', borderRadius: 2, marginRight: 4 }} />{t('Error')}</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, backgroundColor: '#1890ff', borderRadius: 2, marginRight: 4 }} />{t('Running')}</span>
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
          <text x={cx} y={cy - 4} textAnchor="middle" fontSize={18} fontWeight={700} fill="#333">{total}</text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize={10} fill="#999">total</text>
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

export const Dashboard: React.FC = () => {
  const t = useT();
  const [refreshInterval, setRefreshInterval] = useState<number>(0);
  const { data, loading, refresh } = useN8nRequest('n8nMonitoring', 'dashboard');

  useEffect(() => {
    if (refreshInterval > 0) {
      const timer = setInterval(() => {
        refresh();
      }, refreshInterval * 1000);
      return () => clearInterval(timer);
    }
  }, [refreshInterval, refresh]);

  if (loading && !data) return <Spin size="large" style={{ display: 'block', margin: '60px auto' }} />;
  if (!data) return null;

  const { health, workflows, executions, hourlyHistory, recentFailures } = data;

  const failureColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 100 },
    {
      title: t('Workflow'),
      key: 'workflow',
      render: (_: any, r: any) => r.workflowData?.name || `#${r.workflowId}`,
    },
    {
      title: t('Started'),
      dataIndex: 'startedAt',
      key: 'startedAt',
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
  ];

  const successRate = executions?.successRate || 0;
  const rateColor = successRate >= 80 ? '#3f8600' : successRate >= 50 ? '#faad14' : '#cf1322';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{t('Dashboard')}</div>
        <Space>
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
          <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
            {t('Refresh')}
          </Button>
        </Space>
      </div>
      {/* KPI Cards */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Health')}
              value={health?.status === 'healthy' ? t('Healthy') : t('Unhealthy')}
              valueStyle={{ color: health?.status === 'healthy' ? '#3f8600' : '#cf1322', fontSize: 18 }}
              prefix={<HeartOutlined />}
              suffix={<span style={{ fontSize: 12, color: '#999' }}>{health?.latencyMs ? `${health.latencyMs}ms` : ''}</span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={4}>
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
        <Col xs={24} sm={12} lg={4}>
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
        <Col xs={24} sm={12} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Total Executions')}
              value={executions?.total || 0}
              prefix={<DashboardOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Errors')}
              value={executions?.error || 0}
              prefix={<CloseCircleOutlined />}
              valueStyle={{ color: (executions?.error || 0) > 0 ? '#cf1322' : '#999', fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Avg Duration')}
              value={executions?.avgDuration ? formatDuration(executions.avgDuration) : '-'}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
      </Row>

      {/* Charts */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={16}>
          <Card size="small">
            <HourlyChart data={hourlyHistory || []} />
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

      {/* Recent Failures */}
      {recentFailures?.length > 0 && (
        <Card title={t('Recent Failures')} size="small" style={{ marginTop: 16 }}>
          <Table columns={failureColumns} dataSource={recentFailures} rowKey="id" pagination={false} size="small" />
        </Card>
      )}
    </div>
  );
};
