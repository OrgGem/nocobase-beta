import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Table, Tag, Button, Space, Row, Col, Statistic, Descriptions, Select, Spin, Alert, Popconfirm, message, Modal, Input, Switch } from 'antd';
import {
  ReloadOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
  ClusterOutlined,
  CloudServerOutlined,
  FileTextOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT, formatBytes, formatUptime } from './utils';



function LogViewerModal({ open, node, onClose }: { open: boolean; node: any; onClose: () => void }) {
  const t = useT();
  const api = useAPIClient();
  const [lines, setLines] = useState<string[]>([]);
  const [logMeta, setLogMeta] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [searchText, setSearchText] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const res = await api.request({
        url: 'clusterManagerCluster:logs',
        params: { lines: 200, targetNodeId: node?.id },
      });
      const data = res?.data?.data;
      if (data) {
        if (data._error) {
          message.warning(data._error);
        }
        setLines(data.lines || []);
        setLogMeta(data.node);
      }
    } catch {
      message.error('Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [api, open, node]);

  useEffect(() => {
    if (open) {
      setLines([]);
      setSearchText('');
      setAutoRefresh(true);
      fetchLogs();
    }
  }, [open, fetchLogs]);

  useEffect(() => {
    if (!open || !autoRefresh) return;
    const timer = setInterval(fetchLogs, 5000);
    return () => clearInterval(timer);
  }, [open, autoRefresh, fetchLogs]);

  useEffect(() => {
    if (logEndRef.current && !searchText) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, searchText]);

  const filteredLines = searchText
    ? lines.filter((l) => l.toLowerCase().includes(searchText.toLowerCase()))
    : lines;

  return (
    <Modal
      title={
        <Space>
          <FileTextOutlined />
          {t('Instance Logs')} — {node?.name || ''}
          {logMeta && (
            <Tag>{logMeta.hostname}:{logMeta.pid} ({logMeta.workerMode})</Tag>
          )}
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width="80vw"
      styles={{ body: { height: '70vh', display: 'flex', flexDirection: 'column', padding: '12px 24px' } }}
      destroyOnClose
    >
      <Space style={{ marginBottom: 8, flexShrink: 0 }}>
        <Input
          placeholder={t('Search logs...')}
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ width: 300 }}
        />
        <Switch
          checked={autoRefresh}
          onChange={setAutoRefresh}
          checkedChildren={t('Auto 5s')}
          unCheckedChildren={t('Paused')}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchLogs} loading={loading} size="small">
          {t('Refresh')}
        </Button>
        <span style={{ fontSize: 12, color: '#888' }}>
          {filteredLines.length} / {lines.length} {t('lines')}
        </span>
      </Space>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          background: '#1e1e1e',
          color: '#d4d4d4',
          fontFamily: 'Consolas, Monaco, "Courier New", monospace',
          fontSize: 12,
          lineHeight: 1.5,
          padding: 12,
          borderRadius: 6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {filteredLines.length === 0 && !loading && (
          <div style={{ color: '#888', textAlign: 'center', paddingTop: 40 }}>
            {lines.length === 0 ? t('No logs available') : t('No matching logs')}
          </div>
        )}
        {filteredLines.map((line, i) => {
          let color = '#d4d4d4';
          if (/\berror\b/i.test(line)) color = '#f5222d';
          else if (/\bwarn(ing)?\b/i.test(line)) color = '#faad14';
          else if (/\bdebug\b/i.test(line)) color = '#8c8c8c';
          return (
            <div key={i} style={{ padding: '1px 0', color }}>{line}</div>
          );
        })}
        <div ref={logEndRef} />
      </div>
    </Modal>
  );
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
  const [logNode, setLogNode] = useState<any>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [currentRes, listRes, healthRes] = await Promise.all([
        api.request({ url: 'clusterManagerCluster:current' }),
        api.request({ url: 'clusterManagerCluster:list' }),
        api.request({ url: 'clusterManagerCluster:health' }),
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
        url: 'clusterManagerCluster:restart', 
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
      render: (mode: string, record: any) => {
        if (record.isSandbox) {
          return <Tag color="purple">SANDBOX</Tag>;
        }
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
      width: 100,
      render: (_: any, r: any) => (
        <Space size="small">
          <Button type="link" icon={<FileTextOutlined />} onClick={() => setLogNode(r)} disabled={r.status === 'offline'}>
            {t('Logs')}
          </Button>
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

        {/* Current node details (always APP node) */}
        {currentNode && (
          <Card
            title={
              <Space>
                {t('Current Node Details')}
                <Tag color="green">APP</Tag>
              </Space>
            }
            size="small"
          >
            {currentNode._fallback && (
              <Alert
                type="warning"
                message={t('APP node not found in cluster registry. Showing data from the responding worker node.')}
                showIcon
                style={{ marginBottom: 12 }}
              />
            )}
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
        <LogViewerModal open={!!logNode} node={logNode} onClose={() => setLogNode(null)} />
      </Space>
    </Spin>
  );
}
