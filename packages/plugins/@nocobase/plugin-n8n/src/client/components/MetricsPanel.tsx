import React, { useEffect, useState } from 'react';
import { Card, Col, Row, Empty, Spin } from 'antd';
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
  queueWaiting: number;
  queueActive: number;
  queueCompleted: number;
  queueFailed: number;
  activeWorkflows: number;
}

const SimpleChart: React.FC<{ data: number[]; labels: string[]; title: string; color?: string; unit?: string }> = ({
  data,
  labels,
  title,
  color = '#1890ff',
  unit = '',
}) => {
  if (!data.length) return <Empty description="No data" />;
  const max = Math.max(...data, 1);
  const width = 100 / data.length;

  return (
    <div>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', height: 80, borderBottom: '1px solid #f0f0f0' }}>
        {data.map((v, i) => (
          <div
            key={i}
            title={`${labels[i]}: ${v.toFixed(2)}${unit}`}
            style={{
              width: `${width}%`,
              height: `${(v / max) * 100}%`,
              backgroundColor: color,
              opacity: 0.7,
              minHeight: 1,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#999', marginTop: 2 }}>
        <span>{labels[0] || ''}</span>
        <span>
          {data[data.length - 1]?.toFixed(2)}
          {unit}
        </span>
        <span>{labels[labels.length - 1] || ''}</span>
      </div>
    </div>
  );
};

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
      setHistory(res?.data?.data || []);
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

  if (loading && !history.length) return <Spin style={{ display: 'block', margin: '40px auto' }} />;
  if (!history.length)
    return <Empty description={t('No metrics data yet. Enable metrics on your n8n instance.')} />;

  const labels = history.map((s) => {
    const d = new Date(s.timestamp);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  });

  const mb = (bytes: number) => bytes / 1024 / 1024;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} md={12}>
        <Card size="small">
          <SimpleChart
            data={history.map((s) => s.cpu)}
            labels={labels}
            title={t('CPU (seconds total)')}
            color="#1890ff"
            unit="s"
          />
        </Card>
      </Col>
      <Col xs={24} md={12}>
        <Card size="small">
          <SimpleChart
            data={history.map((s) => mb(s.memoryRss))}
            labels={labels}
            title={t('Memory RSS (MB)')}
            color="#52c41a"
            unit="MB"
          />
        </Card>
      </Col>
      <Col xs={24} md={12}>
        <Card size="small">
          <SimpleChart
            data={history.map((s) => mb(s.heapUsed))}
            labels={labels}
            title={t('Heap Used (MB)')}
            color="#faad14"
            unit="MB"
          />
        </Card>
      </Col>
      <Col xs={24} md={12}>
        <Card size="small">
          <SimpleChart
            data={history.map((s) => s.eventLoopLag * 1000)}
            labels={labels}
            title={t('Event Loop Lag (ms)')}
            color="#f5222d"
            unit="ms"
          />
        </Card>
      </Col>
      <Col xs={24} md={12}>
        <Card size="small">
          <SimpleChart
            data={history.map((s) => s.queueWaiting)}
            labels={labels}
            title={t('Queue Waiting')}
            color="#722ed1"
          />
        </Card>
      </Col>
      <Col xs={24} md={12}>
        <Card size="small">
          <SimpleChart
            data={history.map((s) => s.queueActive)}
            labels={labels}
            title={t('Queue Active')}
            color="#13c2c2"
          />
        </Card>
      </Col>
    </Row>
  );
};
