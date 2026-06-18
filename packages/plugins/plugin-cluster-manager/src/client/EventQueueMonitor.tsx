import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Button, Space, Row, Col, Statistic, Select, Spin } from 'antd';
import {
  ReloadOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
  UnorderedListOutlined,
  ApiOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './utils';

export function EventQueueMonitor() {
  const t = useT();
  const api = useApp().apiClient;
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [autoRefresh, setAutoRefresh] = useState<number | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedRedisQueue, setSelectedRedisQueue] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [messagesMeta, setMessagesMeta] = useState<any>({});
  const [redisMessages, setRedisMessages] = useState<any[]>([]);
  const [redisMessagesMeta, setRedisMessagesMeta] = useState<any>({});

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'clusterManagerQueue:stats' });
      setStats(res?.data?.data);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [api]);

  const fetchMessages = useCallback(
    async (channel: string) => {
      try {
        const res = await api.request({ url: 'clusterManagerQueue:messages', params: { channel } });
        setMessages(res?.data?.data?.data || []);
        setMessagesMeta(res?.data?.data?.meta || {});
      } catch {
        // Ignore
      }
    },
    [api],
  );

  const fetchRedisMessages = useCallback(
    async (queue: any) => {
      if (!queue?.key) return;
      try {
        const res = await api.request({
          url: 'clusterManagerQueue:messages',
          params: { source: 'redis', key: queue.key },
        });
        setRedisMessages(res?.data?.data?.data || []);
        setRedisMessagesMeta(res?.data?.data?.meta || {});
      } catch {
        // Ignore
      }
    },
    [api],
  );

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
      render: (v: number | null) => (v === null ? <Tag>N/A</Tag> : <Tag color={v > 0 ? 'orange' : 'green'}>{v}</Tag>),
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

  const redisQueueColumns = [
    { title: t('Queue'), dataIndex: 'channel', key: 'channel', width: 240 },
    { title: t('Redis Key'), dataIndex: 'key', key: 'key', ellipsis: true },
    { title: t('App'), dataIndex: 'appName', key: 'appName', width: 120 },
    {
      title: t('Pending'),
      dataIndex: 'pending',
      key: 'pending',
      width: 100,
      render: (v: number) => <Tag color={v > 0 ? 'orange' : 'green'}>{v}</Tag>,
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
            setSelectedRedisQueue(record);
            fetchRedisMessages(record);
          }}
        >
          {t('Items')}
        </Button>
      ),
    },
  ];

  const redisMessageColumns = [
    { title: '#', dataIndex: 'index', key: 'index', width: 80 },
    {
      title: t('Content'),
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (v: any) => <code style={{ fontSize: 11 }}>{JSON.stringify(v)}</code>,
    },
    {
      title: t('Queued At'),
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
          <Button icon={<ReloadOutlined />} onClick={fetchStats}>
            {t('Refresh')}
          </Button>
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
                <Statistic title={t('Total Channels')} value={stats.totalChannels} prefix={<UnorderedListOutlined />} />
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

        {stats?.redisQueues && (
          <Row gutter={16}>
            <Col span={8}>
              <Card size="small">
                <Statistic
                  title={t('Redis Queue Pending')}
                  value={stats.redisQueues.totalPending || 0}
                  prefix={<DatabaseOutlined />}
                  valueStyle={{ color: (stats.redisQueues.totalPending || 0) > 0 ? '#cf1322' : '#3f8600' }}
                />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic
                  title={t('Redis Queues')}
                  value={stats.redisQueues.queues?.length || 0}
                  prefix={<UnorderedListOutlined />}
                />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic
                  title={t('Redis Connected')}
                  value={stats.redisQueues.connected ? 'Yes' : 'No'}
                  prefix={<ThunderboltOutlined />}
                  valueStyle={{ color: stats.redisQueues.connected ? '#3f8600' : '#cf1322' }}
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

        <Card title={t('Redis Queues')} size="small">
          {stats?.redisQueues?.note && <Tag style={{ marginBottom: 8 }}>{stats.redisQueues.note}</Tag>}
          <Table
            dataSource={stats?.redisQueues?.queues || []}
            columns={redisQueueColumns}
            rowKey="key"
            size="small"
            pagination={false}
          />
        </Card>

        {selectedChannel && (
          <Card
            title={`${t('Messages')}: ${selectedChannel}`}
            size="small"
            extra={
              <Button size="small" onClick={() => setSelectedChannel(null)}>
                Close
              </Button>
            }
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

        {selectedRedisQueue && (
          <Card
            title={`${t('Redis Queue Items')}: ${selectedRedisQueue.channel}`}
            size="small"
            extra={
              <Space>
                <Button size="small" onClick={() => fetchRedisMessages(selectedRedisQueue)}>
                  {t('Refresh')}
                </Button>
                <Button size="small" onClick={() => setSelectedRedisQueue(null)}>
                  {t('Close')}
                </Button>
              </Space>
            }
          >
            <Tag style={{ marginBottom: 8 }}>{selectedRedisQueue.key}</Tag>
            {redisMessagesMeta.note && <Tag style={{ marginBottom: 8 }}>{redisMessagesMeta.note}</Tag>}
            <Table
              dataSource={redisMessages}
              columns={redisMessageColumns}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10, total: redisMessagesMeta.count }}
            />
          </Card>
        )}
      </Space>
    </Spin>
  );
}
