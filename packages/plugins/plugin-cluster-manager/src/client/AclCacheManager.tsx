import React, { useEffect, useState, useCallback } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Button, Space, Popconfirm, message, Typography, Select } from 'antd';
import {
  ReloadOutlined,
  DeleteOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './utils';

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
  const api = useApp().apiClient;
  const t = useT();
  const [stats, setStats] = useState<AclStats | null>(null);
  const [keys, setKeys] = useState<CachedKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState<number | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, keysRes] = await Promise.all([
        api.request({ url: 'clusterManagerAclCache:stats' }),
        api.request({ url: 'clusterManagerAclCache:listKeys' }),
      ]);
      const statsData = statsRes?.data?.data || statsRes?.data || {};
      setStats(statsData);
      const keysArray = Array.isArray(keysRes?.data?.data?.data)
        ? keysRes.data.data.data
        : Array.isArray(keysRes?.data?.data)
          ? keysRes.data.data
          : Array.isArray(keysRes?.data)
            ? keysRes.data
            : [];
      setKeys(keysArray);
    } catch {
      message.error(t('Failed to load ACL cache data'));
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

  const handleClearAll = async () => {
    try {
      const res = await api.request({ url: 'clusterManagerAclCache:clear', method: 'post' });
      message.success(t('Cleared {count} cache entries').replace('{count}', String(res.data?.deletedCount || 0)));
      fetchAll();
    } catch {
      message.error(t('Failed to clear cache'));
    }
  };

  const handleResetStats = async () => {
    try {
      await api.request({ url: 'clusterManagerAclCache:resetStats', method: 'post' });
      message.success(t('Stats reset'));
      fetchAll();
    } catch {
      message.error(t('Failed to reset stats'));
    }
  };

  const handleClearRole = async (roleName: string) => {
    try {
      const res = await api.request({
        url: 'clusterManagerAclCache:clearRole',
        method: 'post',
        data: { roleName },
      });
      message.success(
        t('Cleared {count} entries for role "{role}"')
          .replace('{count}', String(res.data?.deletedCount || 0))
          .replace('{role}', roleName),
      );
      fetchAll();
    } catch {
      message.error(t('Failed to clear role cache'));
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
    {
      title: t('Role'),
      dataIndex: 'role',
      width: 120,
      filters: [...new Set(keys.map((k) => k.role))].map((r) => ({ text: r, value: r })),
      onFilter: (value: any, record: CachedKey) => record.role === value,
    },
    { title: t('Resource'), dataIndex: 'resource', width: 200 },
    { title: t('Action'), dataIndex: 'action', width: 120 },
    {
      title: t('Cache Key'),
      dataIndex: 'key',
      ellipsis: true,
      render: (val: string) => (
        <Text code style={{ fontSize: 11 }}>
          {val}
        </Text>
      ),
    },
  ];

  const roleColumns = [
    { title: t('Role'), dataIndex: 'role', width: 150 },
    { title: t('Checks'), dataIndex: 'checks', width: 100, sorter: (a: any, b: any) => a.checks - b.checks },
    {
      title: t('Hits'),
      dataIndex: 'hits',
      width: 100,
      render: (val: number) => <Text type="success">{val}</Text>,
    },
    {
      title: t('Misses'),
      dataIndex: 'misses',
      width: 100,
      render: (val: number) => <Text type="danger">{val}</Text>,
    },
    {
      title: t('Hit Rate'),
      dataIndex: 'hitRate',
      width: 100,
      render: (val: number) => <Tag color={val > 80 ? 'green' : val > 50 ? 'orange' : 'red'}>{val}%</Tag>,
      sorter: (a: any, b: any) => a.hitRate - b.hitRate,
    },
    {
      title: t('Actions'),
      width: 80,
      render: (_: any, record: any) => (
        <Popconfirm
          title={`${t('Clear cache for role')} "${record.role}"?`}
          onConfirm={() => handleClearRole(record.role)}
        >
          <Button type="link" size="small" icon={<DeleteOutlined />} danger />
        </Popconfirm>
      ),
    },
  ];

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
        <Popconfirm title={t('Clear all ACL cache entries?')} onConfirm={handleClearAll}>
          <Button icon={<DeleteOutlined />} danger>
            {t('Clear All Cache')}
          </Button>
        </Popconfirm>
        <Popconfirm title={t('Reset ACL stats counters?')} onConfirm={handleResetStats}>
          <Button>{t('Reset Stats')}</Button>
        </Popconfirm>
        <Tag>TTL: {stats.ttlSeconds}s</Tag>
        <Tag>
          {t('Since')}: {new Date(stats.startedAt).toLocaleString()}
        </Tag>
      </Space>

      {/* Overview stats */}
      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Card size="small">
            <Statistic title={t('Total ACL Checks')} value={stats.totalChecks} prefix={<SafetyCertificateOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Cache Hits')}
              value={stats.cacheHits}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Cache Misses')}
              value={stats.cacheMisses}
              prefix={<CloseCircleOutlined />}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Hit Rate')}
              value={stats.hitRate}
              suffix="%"
              prefix={<ThunderboltOutlined />}
              valueStyle={{
                color: stats.hitRate > 80 ? '#3f8600' : stats.hitRate > 50 ? '#faad14' : '#cf1322',
              }}
            />
            <Text type="secondary">
              {t('Cached keys')}: {stats.cachedKeys}
            </Text>
          </Card>
        </Col>
      </Row>

      {/* Per-role breakdown */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title={t('Stats by Role')} size="small">
            {roleData.length === 0 ? (
              <Text type="secondary">{t('No ACL checks recorded yet')}</Text>
            ) : (
              <Table
                rowKey="role"
                size="small"
                pagination={false}
                dataSource={roleData}
                columns={roleColumns}
                scroll={{ x: 'max-content' }}
              />
            )}
          </Card>
        </Col>

        {/* Cached keys */}
        <Col span={12}>
          <Card title={`${t('Cached Permission Keys')} (${keys.length})`} size="small">
            {keys.length === 0 ? (
              <Text type="secondary">{t('No cached keys')}</Text>
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
