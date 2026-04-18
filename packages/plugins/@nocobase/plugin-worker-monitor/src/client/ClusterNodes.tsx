import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Button, Space, Row, Col, Statistic, Descriptions, Select, Spin, Alert, Popconfirm, message } from 'antd';
import {
  ReloadOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
  ClusterOutlined,
  CloudServerOutlined,
} from '@ant-design/icons';
import { useAPIClient, useApp } from '@nocobase/client';

const namespace = 'worker-monitor';

function useT() {
  const app = useApp();
  return (key: string) => app.i18n.t(key, { ns: namespace });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

const statusColors: Record<string, string> = {
  ok: 'green',
  connected: 'green',
  online: 'green',
  warning: 'orange',
  disconnected: 'red',
  offline: 'red',
  error: 'red',
  not_configured: 'default',
};

export function ClusterNodes() {
  const t = useT();
  const api = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [currentNode, setCurrentNode] = useState<any>(null);
  const [environments, setEnvironments] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [autoRefresh, setAutoRefresh] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [currentRes, listRes, healthRes] = await Promise.all([
        api.request({ url: 'workerMonitorCluster:current' }),
        api.request({ url: 'workerMonitorCluster:list' }),
        api.request({ url: 'workerMonitorCluster:health' }),
      ]);
      setCurrentNode(currentRes?.data?.data);
      setEnvironments(listRes?.data?.data?.data || []);
      setHealth(healthRes?.data?.data);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [api]);

  const handleRestartNode = async (hostname: string, mode: 'soft' | 'hard') => {
    try {
      await api.request({ 
        url: 'workerMonitorCluster:restart', 
        method: 'POST', 
        data: { hostname, mode } 
      });
      message.success(`[${mode}] Restart signal sent to ${hostname === '*' ? 'all nodes' : hostname}`);
      setTimeout(fetchData, 3000);
    } catch {
      message.error(`Failed to send restart signal to ${hostname}`);
    }
  };

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(fetchData, autoRefresh * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchData]);

  const onlineCount = environments.filter((e) => e.status === 'online').length;

  const nodeColumns = [
    { title: t('Name'), dataIndex: 'name', key: 'name', width: 200 },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={statusColors[status] || 'default'} icon={
          status === 'online' ? <CheckCircleOutlined /> :
          status === 'warning' ? <WarningOutlined /> :
          <CloseCircleOutlined />
        }>
          {status.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: t('Type'),
      dataIndex: 'workerMode',
      key: 'workerMode',
      width: 100,
      render: (mode: string) => {
        const isWorker = mode === 'worker' || mode === 'task' || mode === '*';
        return (
          <Tag color={isWorker ? 'blue' : 'green'}>
            {isWorker ? 'WORKER' : 'APP'}
          </Tag>
        );
      },
    },
    { title: t('PID'), dataIndex: 'pid', key: 'pid', width: 80 },
    { title: t('Version'), dataIndex: 'appVersion', key: 'appVersion', width: 120 },
    { title: t('Last Heartbeat'), dataIndex: 'lastHeartbeatAt', key: 'lastHeartbeatAt', width: 200 },
    {
      title: 'Action',
      key: 'action',
      width: 180,
      render: (_: any, r: any) => (
        <Space size="small">
          <Popconfirm
            title="Soft Restart Node?"
            description="Reload the NocoBase app inside this process (does not clear RAM leaks)."
            onConfirm={() => handleRestartNode(r.name, 'soft')}
          >
            <Button type="link" style={{ color: '#faad14' }} disabled={r.status === 'offline'}>Soft Restart</Button>
          </Popconfirm>
          
          <Popconfirm
            title="Hard Restart Node?"
            description="Force kill process. Docker will recreate this container (clears RAM)."
            onConfirm={() => handleRestartNode(r.name, 'hard')}
          >
            <Button type="link" danger disabled={r.status === 'offline'}>Hard Restart</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const healthChecks = health?.checks || {};

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* Toolbar */}
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
          <Space>
            <Popconfirm
              title="Soft Restart ALL Nodes?"
              description="Sends a soft reload signal to all active Nodes simultaneously."
              onConfirm={() => handleRestartNode('*', 'soft')}
            >
              <Button style={{ color: '#faad14', borderColor: '#ffe58f' }} icon={<ReloadOutlined />}>{t('Soft Restart Cluster')}</Button>
            </Popconfirm>
            <Popconfirm
              title="Hard Restart ALL Nodes?"
              description="Sends a lethal signal. Docker will reboot ALL container infrastructure."
              onConfirm={() => handleRestartNode('*', 'hard')}
            >
              <Button danger icon={<ReloadOutlined />}>{t('Hard Restart Cluster')}</Button>
            </Popconfirm>
          </Space>
        </Space>

        {/* Stats cards */}
        <Row gutter={16}>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title={t('Nodes Online')}
                value={onlineCount}
                suffix={`/ ${environments.length}`}
                prefix={<ClusterOutlined />}
                valueStyle={{ color: onlineCount === environments.length ? '#3f8600' : '#cf1322' }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title={t('Worker Nodes')}
                value={environments.filter(e => e.workerMode === 'worker' || e.workerMode === 'task' || e.workerMode === '*').length}
                prefix={<ClusterOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title={t('Process Uptime')}
                value={currentNode ? formatUptime(currentNode.node.uptime) : '-'}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title={t('Memory (Heap)')}
                value={currentNode ? formatBytes(currentNode.memory.heapUsed) : '-'}
                suffix={currentNode ? `/ ${formatBytes(currentNode.memory.heapTotal)}` : ''}
              />
            </Card>
          </Col>
        </Row>

        {/* Health checks */}
        <Card title={t('Health Checks')} size="small">
          {health && !health.healthy && (
            <Alert type="warning" message={t('Some subsystems are unhealthy')} showIcon style={{ marginBottom: 12 }} />
          )}
          <Row gutter={[16, 8]}>
            {Object.entries(healthChecks).map(([name, check]: [string, any]) => (
              <Col span={4} key={name}>
                <Card size="small" style={{ textAlign: 'center' }}>
                  <Tag color={statusColors[check.status] || 'default'}>{check.status}</Tag>
                  <div style={{ marginTop: 4, fontWeight: 500 }}>{name}</div>
                  {check.latency !== undefined && (
                    <div style={{ fontSize: 11, color: '#888' }}>{check.latency}ms</div>
                  )}
                  {check.detail && (
                    <div style={{ fontSize: 11, color: '#888' }}>{check.detail}</div>
                  )}
                </Card>
              </Col>
            ))}
          </Row>
        </Card>

        {/* Cluster nodes table */}
        <Card title={t('Cluster Nodes')} size="small">
          <Table
            dataSource={environments}
            columns={nodeColumns}
            rowKey="id"
            size="small"
            pagination={false}
          />
        </Card>

        {/* Current node details */}
        {currentNode && (
          <Card title={t('Current Node Details')} size="small">
            <Descriptions size="small" column={3}>
              <Descriptions.Item label={t('Hostname')}>{currentNode.node.hostname}</Descriptions.Item>
              <Descriptions.Item label="PID">{currentNode.node.pid}</Descriptions.Item>
              <Descriptions.Item label="Node.js">{currentNode.node.nodeVersion}</Descriptions.Item>
              <Descriptions.Item label={t('Worker Mode')}>{currentNode.node.workerMode || '(default)'}</Descriptions.Item>
              <Descriptions.Item label={t('App Port')}>{currentNode.node.appPort}</Descriptions.Item>
              <Descriptions.Item label={t('Cluster Mode')}>{currentNode.node.clusterMode || '(disabled)'}</Descriptions.Item>
              <Descriptions.Item label={t('RSS Memory')}>{formatBytes(currentNode.memory.rss)}</Descriptions.Item>
              <Descriptions.Item label={t('OS Memory')}>
                {formatBytes(currentNode.os.freeMemory)} free / {formatBytes(currentNode.os.totalMemory)}
              </Descriptions.Item>
              <Descriptions.Item label={t('CPU Cores')}>{currentNode.os.cpuCount}</Descriptions.Item>
            </Descriptions>
          </Card>
        )}
      </Space>
    </Spin>
  );
}
