import React, { useEffect, useState, useCallback } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Button, Space, Select, message, Typography } from 'antd';
import {
  ReloadOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  ThunderboltOutlined,
  FieldTimeOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { formatBytes, formatUptime, useT } from './utils';

const { Text } = Typography;

interface RedisInfo {
  server: { version: string; uptime_seconds: number; uptime_days: number };
  memory: {
    used: string;
    used_bytes: number;
    peak: string;
    peak_bytes: number;
    fragmentation_ratio: number;
    max_memory: string;
    max_memory_policy: string;
  };
  clients: { connected: number; blocked: number; max_clients: number };
  stats: {
    ops_per_sec: number;
    total_commands: number;
    total_connections: number;
    keyspace_hits: number;
    keyspace_misses: number;
    hit_rate: number;
    expired_keys: number;
    evicted_keys: number;
  };
  keyspace: Record<string, Record<string, string>>;
}



export function RedisMonitor() {
  const api = useApp().apiClient;
  const t = useT();
  const [info, setInfo] = useState<RedisInfo | null>(null);
  const [channels, setChannels] = useState<Record<string, number>>({});
  const [totalChannels, setTotalChannels] = useState(0);
  const [clients, setClients] = useState<any[]>([]);
  const [slowlog, setSlowlog] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [infoRes, pubsubRes, clientsRes, slowlogRes] = await Promise.all([
        api.request({ url: 'clusterManagerRedis:info' }),
        api.request({ url: 'clusterManagerRedis:pubsub' }),
        api.request({ url: 'clusterManagerRedis:clients' }),
        api.request({ url: 'clusterManagerRedis:slowlog', params: { count: 10 } }),
      ]);
      const infoData = infoRes?.data?.data || infoRes?.data || {};
      setInfo(infoData);
      
      const pubsubData = pubsubRes?.data?.data || pubsubRes?.data || {};
      setChannels(pubsubData.channels || {});
      setTotalChannels(pubsubData.total_channels || 0);
      
      const clients = Array.isArray(clientsRes?.data?.data?.data) ? clientsRes.data.data.data : Array.isArray(clientsRes?.data?.data) ? clientsRes.data.data : Array.isArray(clientsRes?.data) ? clientsRes.data : [];
      setClients(clients);
      
      const slowlogs = Array.isArray(slowlogRes?.data?.data?.data) ? slowlogRes.data.data.data : Array.isArray(slowlogRes?.data?.data) ? slowlogRes.data.data : Array.isArray(slowlogRes?.data) ? slowlogRes.data : [];
      setSlowlog(slowlogs);
    } catch (err: any) {
      setError(err?.response?.data?.errors?.[0]?.message || t('Failed to connect to Redis'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(fetchAll, autoRefresh * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchAll]);

  if (error) {
    return (
      <Card>
        <Text type="danger">{error}</Text>
        <br />
        <Button style={{ marginTop: 8 }} onClick={fetchAll}>
          {t('Retry')}
        </Button>
      </Card>
    );
  }

  if (!info) return null;

  const memUsagePct =
    info.memory.max_memory !== 'unlimited' && info.memory.peak_bytes > 0
      ? Math.round((info.memory.used_bytes / info.memory.peak_bytes) * 100)
      : null;

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>
          {t('Refresh')}
        </Button>
        <Select
          placeholder={t('Auto Refresh')}
          allowClear
          style={{ width: 160 }}
          value={autoRefresh}
          onChange={setAutoRefresh}
          options={[
            { value: 5, label: t('Every 5s') },
            { value: 10, label: t('Every 10s') },
            { value: 30, label: t('Every 30s') },
          ]}
        />
        <Tag color="blue">Redis {info.server.version}</Tag>
        <Tag>
          {t('Uptime')}: {formatUptime(info.server.uptime_seconds)}
        </Tag>
      </Space>

      {/* Server stats */}
      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Memory Used')}
              value={info.memory.used}
              prefix={<DatabaseOutlined />}
              suffix={memUsagePct !== null ? `(${memUsagePct}%)` : undefined}
            />
            <Text type="secondary">
              {t('Peak')}: {info.memory.peak}
            </Text>
            <br />
            <Text type="secondary">
              {t('Max')}: {info.memory.max_memory}
            </Text>
            <br />
            <Text type="secondary">
              {t('Policy')}: {info.memory.max_memory_policy}
            </Text>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Ops/sec')}
              value={info.stats.ops_per_sec}
              prefix={<ThunderboltOutlined />}
            />
            <Text type="secondary">
              {t('Total commands')}: {info.stats.total_commands.toLocaleString()}
            </Text>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Connected Clients')}
              value={info.clients.connected}
              prefix={<CloudServerOutlined />}
            />
            <Text type="secondary">
              {t('Blocked')}: {info.clients.blocked}
            </Text>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Cache Hit Rate')}
              value={info.stats.hit_rate}
              suffix="%"
              prefix={<FieldTimeOutlined />}
              valueStyle={{ color: info.stats.hit_rate > 90 ? '#3f8600' : info.stats.hit_rate > 50 ? '#faad14' : '#cf1322' }}
            />
            <Text type="secondary">
              {t('Hits')}: {info.stats.keyspace_hits.toLocaleString()} / {t('Misses')}:{' '}
              {info.stats.keyspace_misses.toLocaleString()}
            </Text>
            <br />
            <Text type="secondary">
              {t('Expired')}: {info.stats.expired_keys.toLocaleString()} / {t('Evicted')}:{' '}
              {info.stats.evicted_keys.toLocaleString()}
            </Text>
          </Card>
        </Col>
      </Row>

      {/* Keyspace */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title={t('Keyspace')} size="small">
            {Object.keys(info.keyspace).length === 0 ? (
              <Text type="secondary">{t('No databases in use')}</Text>
            ) : (
              <Table
                rowKey={(_, i) => String(i)}
                size="small"
                pagination={false}
                dataSource={Object.entries(info.keyspace).map(([db, vals]) => ({
                  db,
                  keys: vals.keys,
                  expires: vals.expires,
                  avg_ttl: vals.avg_ttl,
                }))}
                columns={[
                  { title: t('Database'), dataIndex: 'db', width: 80 },
                  { title: t('Keys'), dataIndex: 'keys', width: 80 },
                  { title: t('Expires'), dataIndex: 'expires', width: 80 },
                  {
                    title: t('Avg TTL'),
                    dataIndex: 'avg_ttl',
                    render: (v: string) => (v ? `${(Number(v) / 1000).toFixed(1)}s` : '-'),
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        {/* Pub/Sub channels */}
        <Col span={12}>
          <Card title={`${t('Pub/Sub Channels')} (${totalChannels})`} size="small">
            {totalChannels === 0 ? (
              <Text type="secondary">{t('No active channels')}</Text>
            ) : (
              <Table
                rowKey={(_, i) => String(i)}
                size="small"
                pagination={false}
                dataSource={Object.entries(channels).map(([name, subs]) => ({ name, subs }))}
                columns={[
                  { title: t('Channel'), dataIndex: 'name', ellipsis: true },
                  { title: t('Subscribers'), dataIndex: 'subs', width: 100 },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* Slow log */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title={t('Slow Log (recent)')} size="small">
            {slowlog.length === 0 ? (
              <Text type="secondary">{t('No slow queries')}</Text>
            ) : (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={slowlog}
                columns={[
                  { title: t('ID'), dataIndex: 'id', width: 60 },
                  {
                    title: t('Duration'),
                    dataIndex: 'duration_us',
                    width: 100,
                    render: (v: number) => `${(v / 1000).toFixed(1)}ms`,
                  },
                  { title: t('Command'), dataIndex: 'command', ellipsis: true },
                ]}
              />
            )}
          </Card>
        </Col>

        {/* Connected clients */}
        <Col span={12}>
          <Card title={`${t('Connected Clients')} (${clients.length})`} size="small">
            <Table
              rowKey={(_, i) => String(i)}
              size="small"
              pagination={{ pageSize: 5, size: 'small' }}
              dataSource={clients}
              columns={[
                { title: t('Addr'), dataIndex: 'addr', width: 140 },
                { title: t('Age'), dataIndex: 'age', width: 60, render: (v: string) => `${v}s` },
                { title: t('Idle'), dataIndex: 'idle', width: 60, render: (v: string) => `${v}s` },
                { title: t('DB'), dataIndex: 'db', width: 40 },
                { title: t('Cmd'), dataIndex: 'cmd', width: 80 },
                {
                  title: t('Flags'),
                  dataIndex: 'flags',
                  width: 60,
                  render: (v: string) => <Tag>{v}</Tag>,
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      {/* Sync Messages */}
      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={24}>
          <SyncMessagesSection />
        </Col>
      </Row>
    </div>
  );
}

function SyncMessagesSection() {
  const api = useApp().apiClient;
  const t = useT();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api.request({ url: 'clusterManagerRedis:syncMessages' })
      .then((res: any) => setData(res?.data?.data))
      .catch(() => {});
  }, [api]);

  if (!data) return null;

  return (
    <Card
      title={`${t('Sync Messages')} (PubSub ${data.pubSubConnected ? t('Connected') : t('Disconnected')})`}
      size="small"
    >
      <Table
        rowKey="channel"
        size="small"
        pagination={false}
        dataSource={data.channels || []}
        columns={[
          { title: t('Channel'), dataIndex: 'channel', key: 'channel' },
        ]}
      />
    </Card>
  );
}
