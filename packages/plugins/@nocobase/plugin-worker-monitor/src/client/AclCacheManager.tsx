import React, { useEffect, useState, useCallback } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Table,
  Tag,
  Button,
  Space,
  Popconfirm,
  message,
  Typography,
  Select,
} from 'antd';
import {
  ReloadOutlined,
  DeleteOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';

const { Text } = Typography;

interface AclStats {
  totalChecks: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  cachedKeys: number;
  ttlSeconds: number;
  startedAt: string;
  detailByRole: Record<string, { checks: number; hits: number; misses: number }>;
}

interface CachedKey {
  key: string;
  role: string;
  resource: string;
  action: string;
}

export function AclCacheManager() {
  const api = useAPIClient();
  const [stats, setStats] = useState<AclStats | null>(null);
  const [keys, setKeys] = useState<CachedKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState<number | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, keysRes] = await Promise.all([
        api.request({ url: 'workerMonitorAclCache:stats' }),
        api.request({ url: 'workerMonitorAclCache:listKeys' }),
      ]);
      const statsData = statsRes?.data?.data || statsRes?.data || {};
      setStats(statsData);
      const keysArray = Array.isArray(keysRes?.data?.data?.data) ? keysRes.data.data.data : Array.isArray(keysRes?.data?.data) ? keysRes.data.data : Array.isArray(keysRes?.data) ? keysRes.data : [];
      setKeys(keysArray);
    } catch {
      message.error('Failed to load ACL cache data');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchAll();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(fetchAll, autoRefresh * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchAll]);

  const handleClearAll = async () => {
    try {
      const res = await api.request({ url: 'workerMonitorAclCache:clear', method: 'post' });
      message.success(`Cleared ${res.data?.deletedCount || 0} cache entries`);
      fetchAll();
    } catch {
      message.error('Failed to clear cache');
    }
  };

  const handleResetStats = async () => {
    try {
      await api.request({ url: 'workerMonitorAclCache:resetStats', method: 'post' });
      message.success('Stats reset');
      fetchAll();
    } catch {
      message.error('Failed to reset stats');
    }
  };

  const handleClearRole = async (roleName: string) => {
    try {
      const res = await api.request({
        url: 'workerMonitorAclCache:clearRole',
        method: 'post',
        data: { roleName },
      });
      message.success(`Cleared ${res.data?.deletedCount || 0} entries for role "${roleName}"`);
      fetchAll();
    } catch {
      message.error('Failed to clear role cache');
    }
  };

  if (!stats) return null;

  const detailByRole = stats.detailByRole || {};
  const roleData = Object.entries(detailByRole).map(([role, data]) => ({
    role,
    ...data,
    hitRate: data.checks > 0 ? Math.round((data.hits / data.checks) * 10000) / 100 : 0,
  }));

  const keyColumns = [
    { title: 'Role', dataIndex: 'role', width: 120, filters: [...new Set(keys.map((k) => k.role))].map((r) => ({ text: r, value: r })), onFilter: (value: any, record: CachedKey) => record.role === value },
    { title: 'Resource', dataIndex: 'resource', width: 200 },
    { title: 'Action', dataIndex: 'action', width: 120 },
    {
      title: 'Cache Key',
      dataIndex: 'key',
      ellipsis: true,
      render: (val: string) => <Text code style={{ fontSize: 11 }}>{val}</Text>,
    },
  ];

  const roleColumns = [
    { title: 'Role', dataIndex: 'role', width: 150 },
    { title: 'Checks', dataIndex: 'checks', width: 100, sorter: (a: any, b: any) => a.checks - b.checks },
    {
      title: 'Hits',
      dataIndex: 'hits',
      width: 100,
      render: (val: number) => <Text type="success">{val}</Text>,
    },
    {
      title: 'Misses',
      dataIndex: 'misses',
      width: 100,
      render: (val: number) => <Text type="danger">{val}</Text>,
    },
    {
      title: 'Hit Rate',
      dataIndex: 'hitRate',
      width: 100,
      render: (val: number) => (
        <Tag color={val > 80 ? 'green' : val > 50 ? 'orange' : 'red'}>{val}%</Tag>
      ),
      sorter: (a: any, b: any) => a.hitRate - b.hitRate,
    },
    {
      title: 'Actions',
      width: 80,
      render: (_: any, record: any) => (
        <Popconfirm title={`Clear cache for role "${record.role}"?`} onConfirm={() => handleClearRole(record.role)}>
          <Button type="link" size="small" icon={<DeleteOutlined />} danger />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>
          Refresh
        </Button>
        <Select
          placeholder="Auto refresh"
          allowClear
          style={{ width: 160 }}
          value={autoRefresh}
          onChange={setAutoRefresh}
          options={[
            { value: 5, label: 'Every 5s' },
            { value: 10, label: 'Every 10s' },
            { value: 30, label: 'Every 30s' },
          ]}
        />
        <Popconfirm title="Clear all ACL cache entries?" onConfirm={handleClearAll}>
          <Button icon={<DeleteOutlined />} danger>
            Clear All Cache
          </Button>
        </Popconfirm>
        <Popconfirm title="Reset ACL stats counters?" onConfirm={handleResetStats}>
          <Button>Reset Stats</Button>
        </Popconfirm>
        <Tag>TTL: {stats.ttlSeconds}s</Tag>
        <Tag>Since: {new Date(stats.startedAt).toLocaleString()}</Tag>
      </Space>

      {/* Overview stats */}
      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Total ACL Checks"
              value={stats.totalChecks}
              prefix={<SafetyCertificateOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Cache Hits"
              value={stats.cacheHits}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Cache Misses"
              value={stats.cacheMisses}
              prefix={<CloseCircleOutlined />}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Hit Rate"
              value={stats.hitRate}
              suffix="%"
              prefix={<ThunderboltOutlined />}
              valueStyle={{
                color: stats.hitRate > 80 ? '#3f8600' : stats.hitRate > 50 ? '#faad14' : '#cf1322',
              }}
            />
            <Text type="secondary">Cached keys: {stats.cachedKeys}</Text>
          </Card>
        </Col>
      </Row>

      {/* Per-role breakdown */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title="Stats by Role" size="small">
            {roleData.length === 0 ? (
              <Text type="secondary">No ACL checks recorded yet</Text>
            ) : (
              <Table
                rowKey="role"
                size="small"
                pagination={false}
                dataSource={roleData}
                columns={roleColumns}
              />
            )}
          </Card>
        </Col>

        {/* Cached keys */}
        <Col span={12}>
          <Card title={`Cached Permission Keys (${keys.length})`} size="small">
            {keys.length === 0 ? (
              <Text type="secondary">No cached keys</Text>
            ) : (
              <Table
                rowKey="key"
                size="small"
                pagination={{ pageSize: 10, size: 'small' }}
                dataSource={keys}
                columns={keyColumns}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
