import React, { useEffect, useState, useMemo } from 'react';
import { Card, Col, Row, Empty, Spin, Statistic, Tooltip } from 'antd';
import {
  DashboardOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  UnorderedListOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

interface MetricsSnapshot {
  timestamp: number;
  cpu: number;
  memoryRss: number;
  heapUsed: number;
  heapTotal: number;
  eventLoopLag: number;
  eventLoopP99: number;
  activeHandles: number;
  activeRequests: number;
  queueWaiting: number;
  queueActive: number;
  queueCompleted: number;
  queueFailed: number;
  activeWorkflows: number;
}

// SVG line chart component
const LineChart: React.FC<{
  data: Array<{ values: number[]; color: string; label: string; dashed?: boolean }>;
  labels: string[];
  title: string;
  unit?: string;
  height?: number;
  thresholds?: Array<{ value: number; color: string; label: string }>;
}> = ({ data, labels, title, unit = '', height = 120, thresholds }) => {
  const t = useT();
  if (!data.length || !data[0].values.length) return <Empty description="No data" />;

  const allValues = data.flatMap((d) => d.values).concat(thresholds?.map((th) => th.value) || []);
  const maxVal = Math.max(...allValues, 0.001);
  const minVal = Math.min(...allValues, 0);
  const range = maxVal - minVal || 1;

  const w = 400;
  const h = height;
  const padL = 0;
  const padR = 0;
  const chartW = w - padL - padR;

  const toX = (i: number) => padL + (i / (labels.length - 1 || 1)) * chartW;
  const toY = (v: number) => h - ((v - minVal) / range) * (h - 8) - 4;

  const latestValues = data.map((d) => d.values[d.values.length - 1]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: '#666', fontWeight: 500 }}>{title}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: data[0].color }}>
          {latestValues[0]?.toFixed(1)}{unit}
        </span>
      </div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
          <line
            key={pct}
            x1={padL} y1={toY(minVal + range * pct)}
            x2={w} y2={toY(minVal + range * pct)}
            stroke="#f0f0f0" strokeWidth={0.5}
          />
        ))}
        {/* Threshold lines */}
        {thresholds?.map((th, i) => (
          <line
            key={`th-${i}`}
            x1={padL} y1={toY(th.value)}
            x2={w} y2={toY(th.value)}
            stroke={th.color} strokeWidth={1} strokeDasharray="4,3" opacity={0.6}
          />
        ))}
        {/* Data lines */}
        {data.map((series, si) => {
          const points = series.values.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
          return (
            <g key={si}>
              {/* Area fill for primary series */}
              {si === 0 && (
                <polygon
                  points={`${toX(0)},${h} ${points} ${toX(series.values.length - 1)},${h}`}
                  fill={series.color}
                  opacity={0.08}
                />
              )}
              <polyline
                points={points}
                fill="none"
                stroke={series.color}
                strokeWidth={1.5}
                strokeDasharray={series.dashed ? '4,3' : undefined}
              />
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#bbb', marginTop: 2 }}>
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
      {data.length > 1 && (
        <div style={{ display: 'flex', gap: 12, fontSize: 10, color: '#888', marginTop: 4 }}>
          {data.map((d, i) => (
            <span key={i}>
              <span style={{
                display: 'inline-block', width: 12, height: 2,
                backgroundColor: d.color, marginRight: 4, verticalAlign: 'middle',
                borderBottom: d.dashed ? '1px dashed ' + d.color : undefined,
              }} />
              {d.label}: {latestValues[i]?.toFixed(1)}{unit}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

function kpiColor(value: number, warn: number, danger: number): string {
  if (value >= danger) return '#cf1322';
  if (value >= warn) return '#faad14';
  return '#3f8600';
}

export const MetricsPanel: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId } = useCurrentInstance();
  const [history, setHistory] = useState<MetricsSnapshot[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = async () => {
    if (!instanceId) return;
    setLoading(true);
    try {
      const res = await api.request({
        url: 'n8nMonitoring:metricsHistory',
        params: { instanceId },
      });
      const responseData = res?.data?.data ?? res?.data;
      setHistory(Array.isArray(responseData) ? responseData : []);
    } catch {
      // ignore
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 20000);
    return () => clearInterval(interval);
  }, [instanceId]);

  // Ensure history is strictly an array before useMemo to prevent map errors
  const safeHistory = Array.isArray(history) ? history : [];

  const labels = useMemo(
    () => safeHistory.map((s) => {
      const d = new Date(s.timestamp);
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    }),
    [history],
  );

  const latest = safeHistory.length > 0 ? safeHistory[safeHistory.length - 1] : null;

  if (loading && !safeHistory.length) return <Spin style={{ display: 'block', margin: '40px auto' }} />;
  if (!safeHistory.length)
    return <Empty description={t('No metrics data yet. Enable metrics on your n8n instance.')} />;

  const mb = (bytes: number) => bytes / 1024 / 1024;
  const heapPct = latest ? (latest.heapUsed / (latest.heapTotal || 1)) * 100 : 0;
  const lagMs = latest ? latest.eventLoopLag * 1000 : 0;

  return (
    <div>
      {/* KPI Summary Cards */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic
              title={t('Memory RSS')}
              value={latest ? mb(latest.memoryRss).toFixed(0) : '-'}
              suffix="MB"
              prefix={<CloudServerOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic
              title={t('Heap Usage')}
              value={heapPct.toFixed(0)}
              suffix="%"
              prefix={<DatabaseOutlined />}
              valueStyle={{ fontSize: 18, color: kpiColor(heapPct, 70, 85) }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic
              title={t('Event Loop Lag')}
              value={lagMs.toFixed(0)}
              suffix="ms"
              prefix={<FieldTimeOutlined />}
              valueStyle={{ fontSize: 18, color: kpiColor(lagMs, 50, 100) }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic
              title={t('Queue Waiting')}
              value={latest?.queueWaiting || 0}
              prefix={<UnorderedListOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic
              title={t('Queue Active')}
              value={latest?.queueActive || 0}
              prefix={<DashboardOutlined />}
              valueStyle={{ fontSize: 18, color: (latest?.queueActive || 0) > 0 ? '#1890ff' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic
              title={t('Active Workflows')}
              value={latest?.activeWorkflows || 0}
              prefix={<ThunderboltOutlined />}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
      </Row>

      {/* Line Charts */}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size="small">
            <LineChart
              data={[{ values: safeHistory.map((s) => s.cpu), color: '#1890ff', label: 'CPU' }]}
              labels={labels}
              title={t('CPU (seconds total)')}
              unit="s"
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small">
            <LineChart
              data={[{ values: safeHistory.map((s) => mb(s.memoryRss)), color: '#52c41a', label: 'RSS' }]}
              labels={labels}
              title={t('Memory RSS (MB)')}
              unit=" MB"
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small">
            <LineChart
              data={[
                { values: safeHistory.map((s) => mb(s.heapUsed)), color: '#faad14', label: t('Used') },
                { values: safeHistory.map((s) => mb(s.heapTotal)), color: '#faad14', label: t('Total'), dashed: true },
              ]}
              labels={labels}
              title={t('Heap Used (MB)')}
              unit=" MB"
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small">
            <LineChart
              data={[
                { values: safeHistory.map((s) => s.eventLoopLag * 1000), color: '#f5222d', label: 'Lag' },
                { values: safeHistory.map((s) => s.eventLoopP99 * 1000), color: '#ff7a45', label: 'P99', dashed: true },
              ]}
              labels={labels}
              title={t('Event Loop Lag (ms)')}
              unit=" ms"
              thresholds={[
                { value: 50, color: '#faad14', label: 'Warning' },
                { value: 100, color: '#ff4d4f', label: 'Danger' },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small">
            <LineChart
              data={[
                { values: safeHistory.map((s) => s.queueWaiting), color: '#722ed1', label: t('Waiting') },
                { values: safeHistory.map((s) => s.queueActive), color: '#13c2c2', label: t('Active') },
                { values: safeHistory.map((s) => s.queueCompleted), color: '#52c41a', label: t('Completed'), dashed: true },
                { values: safeHistory.map((s) => s.queueFailed), color: '#ff4d4f', label: t('Failed'), dashed: true },
              ]}
              labels={labels}
              title={t('Queue Jobs')}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small">
            <LineChart
              data={[
                { values: safeHistory.map((s) => s.activeHandles), color: '#1890ff', label: t('Handles') },
                { values: safeHistory.map((s) => s.activeRequests), color: '#eb2f96', label: t('Requests'), dashed: true },
              ]}
              labels={labels}
              title={t('Active Resources')}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
};
