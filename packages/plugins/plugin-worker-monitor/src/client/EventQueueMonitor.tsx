import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Button, Space, Row, Col, Statistic, Select, Spin } from 'antd';
import {
  ReloadOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
  UnorderedListOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import { useAPIClient, useApp } from '@nocobase/client';

const namespace = 'worker-monitor';

function useT() {
  const app = useApp();
  return (key: string) => app.i18n.t(key, { ns: namespace });
}

export function EventQueueMonitor() {
  const t = useT();
  const api = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [autoRefresh, setAutoRefresh] = useState<number | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [messagesMeta, setMessagesMeta] = useState<any>({});

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'workerMonitorQueue:stats' });
      setStats(res?.data?.data);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [api]);

  const fetchMessages = useCallback(async (channel: string) => {
    try {
      const res = await api.request({ url: 'workerMonitorQueue:messages', params: { channel } });
      setMessages(res?.data?.data?.data || []);
      setMessagesMeta(res?.data?.data?.meta || {});
    } catch {
      // Ignore
    }
  }, [api]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(fetchStats, autoRefresh * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchStats]);

  const channelColumns = [
    { title: t('Channel'), dataIndex: 'channel', key: 'channel' },
    {
      title: t('Pending'),
      dataIndex: 'pending',
      key: 'pending',
      width: 100,
      render: (v: number | null) =>
        v === null ? <Tag>N/A</Tag> : <Tag color={v > 0 ? 'orange' : 'green'}>{v}</Tag>,
    },
    { title: t('Concurrency'), dataIndex: 'concurrency', key: 'concurrency', width: 120 },
    {
      title: t('Interval'),
      dataIndex: 'interval',
      key: 'interval',
      width: 100,
      render: (v: number) => `${v}ms`,
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 100,
      render: (_: any, record: any) => (
        <Button
          size="small"
          type="link"
          onClick={() => {
            setSelectedChannel(record.channel);
            fetchMessages(record.channel);
          }}
        >
          {t('Messages')}
        </Button>
      ),
    },
  ];

  const messageColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 280, ellipsis: true },
    {
      title: t('Content'),
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (v: any) => <code style={{ fontSize: 11 }}>{JSON.stringify(v)}</code>,
    },
    { title: t('Retried'), dataIndex: 'retried', key: 'retried', width: 80 },
    {
      title: t('Timestamp'),
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 180,
      render: (v: number) => (v ? new Date(v).toLocaleString() : '-'),
    },
  ];

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchStats}>{t('Refresh')}</Button>
          <Select
            placeholder={t('Auto Refresh')}
            allowClear
            value={autoRefresh}
            onChange={setAutoRefresh}
            style={{ width: 140 }}
            options={[
              { value: 5, label: '5s' },
              { value: 10, label: '10s' },
              { value: 30, label: '30s' },
            ]}
          />
          {stats && <Tag color={stats.connected ? 'green' : 'red'}>{stats.adapter}</Tag>}
        </Space>

        {stats && (
          <Row gutter={16}>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title={t('Adapter')}
                  value={stats.adapter}
                  prefix={<ApiOutlined />}
                  valueStyle={{ fontSize: 16 }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title={t('Total Channels')}
                  value={stats.totalChannels}
                  prefix={<UnorderedListOutlined />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title={t('Total Pending')}
                  value={stats.totalPending}
                  prefix={<ClockCircleOutlined />}
                  valueStyle={{ color: stats.totalPending > 0 ? '#cf1322' : '#3f8600' }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title={t('Connected')}
                  value={stats.connected ? 'Yes' : 'No'}
                  prefix={<ThunderboltOutlined />}
                  valueStyle={{ color: stats.connected ? '#3f8600' : '#cf1322' }}
                />
              </Card>
            </Col>
          </Row>
        )}

        <Card title={t('Event Channels')} size="small">
          <Table
            dataSource={stats?.channels || []}
            columns={channelColumns}
            rowKey="channel"
            size="small"
            pagination={false}
          />
        </Card>

        {selectedChannel && (
          <Card title={`${t('Messages')}: ${selectedChannel}`} size="small"
            extra={<Button size="small" onClick={() => setSelectedChannel(null)}>Close</Button>}
          >
            {messagesMeta.note && <Tag style={{ marginBottom: 8 }}>{messagesMeta.note}</Tag>}
            <Table
              dataSource={messages}
              columns={messageColumns}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10, total: messagesMeta.count }}
            />
          </Card>
        )}
      </Space>
    </Spin>
  );
}
