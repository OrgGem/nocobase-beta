import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Button, Space, Row, Col, Statistic, Tabs, Spin, Popconfirm, message } from 'antd';
import {
  ReloadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { AclCacheManager } from './AclCacheManager';
import { RedisMonitor } from './RedisMonitor';
import { LockMonitor } from './LockMonitor';
import { EventQueueMonitor } from './EventQueueMonitor';
import { useT } from './utils';

export function CacheMonitor() {
  const t = useT();
  const api = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [stores, setStores] = useState<any[]>([]);
  const [caches, setCaches] = useState<any[]>([]);
  const [redisMemory, setRedisMemory] = useState<any>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [storesRes, cachesRes, memRes] = await Promise.all([
        api.request({ url: 'clusterManagerCacheMgr:stores' }),
        api.request({ url: 'clusterManagerCacheMgr:caches' }),
        api.request({ url: 'clusterManagerCacheMgr:redisMemory' }),
      ]);
      setStores(storesRes?.data?.data?.data || []);
      setCaches(cachesRes?.data?.data?.data || []);
      setRedisMemory(memRes?.data?.data);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleFlushAll = async () => {
    try {
      await api.request({ url: 'clusterManagerCacheMgr:flushAll', method: 'post' });
      message.success(t('All caches flushed'));
      fetchData();
    } catch {
      message.error(t('Failed to flush caches'));
    }
  };

  const storeColumns = [
    { title: t('Store Name'), dataIndex: 'name', key: 'name' },
    {
      title: t('Type'),
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (v: string) => <Tag color={v === 'redis' ? 'blue' : 'default'}>{v}</Tag>,
    },
    {
      title: t('Default'),
      dataIndex: 'isDefault',
      key: 'isDefault',
      width: 100,
      render: (v: boolean) => (v ? <Tag color="green">Yes</Tag> : '-'),
    },
  ];

  const cacheColumns = [
    { title: t('Cache Name'), dataIndex: 'name', key: 'name' },
    {
      title: t('Prefix'),
      dataIndex: 'prefix',
      key: 'prefix',
      render: (v: string | null) => (v ? <code style={{ fontSize: 11 }}>{v}</code> : '-'),
    },
  ];

  return (
    <Tabs
      defaultActiveKey="overview"
      items={[
        {
          key: 'overview',
          label: t('Cache Stores'),
          children: (
            <Spin spinning={loading}>
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={fetchData}>{t('Refresh')}</Button>
                  <Popconfirm
                    title={t('Flush all caches?')}
                    description={t('This will clear all cached data across all stores.')}
                    onConfirm={handleFlushAll}
                  >
                    <Button danger icon={<DeleteOutlined />}>{t('Flush All')}</Button>
                  </Popconfirm>
                </Space>

                <Row gutter={16}>
                  <Col span={8}>
                    <Card size="small">
                      <Statistic
                        title={t('Cache Stores')}
                        value={stores.length}
                        prefix={<DatabaseOutlined />}
                      />
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card size="small">
                      <Statistic
                        title={t('Named Caches')}
                        value={caches.length}
                      />
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card size="small">
                      <Statistic
                        title={t('Redis Keys')}
                        value={redisMemory?.available ? redisMemory.totalKeys : '-'}
                        suffix={redisMemory?.available ? `(${redisMemory.usedMemory})` : ''}
                      />
                    </Card>
                  </Col>
                </Row>

                <Card title={t('Registered Stores')} size="small">
                  <Table
                    dataSource={stores}
                    columns={storeColumns}
                    rowKey="name"
                    size="small"
                    pagination={false}
                  />
                </Card>

                <Card title={t('Named Caches')} size="small">
                  <Table
                    dataSource={caches}
                    columns={cacheColumns}
                    rowKey="name"
                    size="small"
                    pagination={false}
                  />
                </Card>
              </Space>
            </Spin>
          ),
        },
        {
          key: 'acl',
          label: t('ACL Cache'),
          children: <AclCacheManager />,
        },
        {
          key: 'redis',
          label: t('Redis Monitor'),
          children: <RedisMonitor />,
        },
        {
          key: 'locks',
          label: t('Locks'),
          children: <LockMonitor />,
        },
        {
          key: 'queue',
          label: t('Event Queue'),
          children: <EventQueueMonitor />,
        },
      ]}
    />
  );
}
