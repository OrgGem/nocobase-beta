import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Button, Space, Row, Col, Statistic, Select, Spin, Popconfirm, message } from 'antd';
import {
  ReloadOutlined,
  LockOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './utils';

export function LockMonitor() {
  const t = useT();
  const api = useApp().apiClient;
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const [locks, setLocks] = useState<any[]>([]);
  const [autoRefresh, setAutoRefresh] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [infoRes, listRes] = await Promise.all([
        api.request({ url: 'clusterManagerLock:info' }),
        api.request({ url: 'clusterManagerLock:list' }),
      ]);
      setInfo(infoRes?.data?.data);
      setLocks(listRes?.data?.data?.data || []);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(fetchData, autoRefresh * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchData]);

  const handleRelease = async (key: string) => {
    try {
      await api.request({
        url: 'clusterManagerLock:release',
        method: 'post',
        data: { key },
      });
      message.success(t('Lock released'));
      fetchData();
    } catch {
      message.error(t('Failed to release lock'));
    }
  };

  const columns = [
    {
      title: t('Lock Key'),
      dataIndex: 'key',
      key: 'key',
      render: (key: string) => <code style={{ fontSize: 12 }}>{key}</code>,
    },
    {
      title: t('Adapter'),
      dataIndex: 'adapter',
      key: 'adapter',
      width: 100,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: t('TTL'),
      dataIndex: 'ttl',
      key: 'ttl',
      width: 120,
      render: (v: number | null) => (v ? `${v}ms` : '-'),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 120,
      render: (_: any, record: any) => (
        <Popconfirm
          title={t('Force release this lock?')}
          description={t('This may cause data inconsistency. Use with caution.')}
          onConfirm={() => handleRelease(record.key)}
          okText={t('Release')}
          cancelText={t('Cancel')}
        >
          <Button size="small" danger icon={<UnlockOutlined />}>
            {t('Release')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchData}>{t('Refresh')}</Button>
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
        </Space>

        <Row gutter={16}>
          <Col span={8}>
            <Card size="small">
              <Statistic
                title={t('Adapter Type')}
                value={info?.adapter || '-'}
                prefix={<LockOutlined />}
                valueStyle={{ fontSize: 16 }}
              />
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small">
              <Statistic
                title={t('Active Locks')}
                value={info?.activeLocks ?? 0}
                prefix={<LockOutlined />}
                valueStyle={{ color: (info?.activeLocks || 0) > 0 ? '#cf1322' : '#3f8600' }}
              />
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small">
              <Statistic
                title={t('Total Listed')}
                value={locks.length}
              />
            </Card>
          </Col>
        </Row>

        <Card title={t('Active Locks')} size="small">
          {locks.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 24, color: '#999' }}>
              {t('No active locks')}
            </div>
          ) : (
            <Table
              dataSource={locks}
              columns={columns}
              rowKey="key"
              size="small"
              pagination={{ pageSize: 20 }}
            />
          )}
        </Card>
      </Space>
    </Spin>
  );
}
