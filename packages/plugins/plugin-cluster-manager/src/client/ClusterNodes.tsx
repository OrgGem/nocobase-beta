import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  ReloadOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
  ClusterOutlined,
  FileTextOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT, formatBytes, formatUptime } from './utils';
import { isWorkerOnlyMode } from '../shared/worker-processes';

function LogViewerModal({ open, node, onClose }: { open: boolean; node: any; onClose: () => void }) {
  const t = useT();
  const api = useApp().apiClient;
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

  const filteredLines = searchText ? lines.filter((l) => l.toLowerCase().includes(searchText.toLowerCase())) : lines;

  return (
    <Modal
      title={
        <Space>
          <FileTextOutlined />
          {t('Instance Logs')} — {node?.name || ''}
          {logMeta && (
            <Tag>
              {logMeta.hostname}:{logMeta.pid} ({logMeta.workerMode})
            </Tag>
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
            <div key={i} style={{ padding: '1px 0', color }}>
              {line}
            </div>
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

function renderPackageGroup(packages?: string[]) {
  if (!packages?.length) {
    return <Typography.Text type="secondary">-</Typography.Text>;
  }
  return (
    <Space wrap size={[4, 2]}>
      {packages.map((pkg) => (
        <Tag key={pkg}>{pkg}</Tag>
      ))}
    </Space>
  );
}

function countPackages(packages?: { apt?: string[]; npm?: string[]; python?: string[] }) {
  return (packages?.apt?.length || 0) + (packages?.npm?.length || 0) + (packages?.python?.length || 0);
}

function getNodeRole(record: any): 'app' | 'worker' | 'sandbox' {
  if (record?.appRole === 'app' || record?.appRole === 'worker' || record?.appRole === 'sandbox') {
    return record.appRole;
  }
  if (record?.isSandbox) {
    return 'sandbox';
  }
  return isWorkerOnlyMode(record?.workerMode) ? 'worker' : 'app';
}

function servesWorkerQueues(record: any) {
  return record?.appRole === 'worker' || isWorkerOnlyMode(record?.workerMode);
}

function readClusterListPayload(response: any) {
  const body = response?.data;
  const wrapped = body?.data;

  if (Array.isArray(wrapped)) {
    return { rows: wrapped, meta: body?.meta || {} };
  }

  if (Array.isArray(wrapped?.data)) {
    return { rows: wrapped.data, meta: wrapped.meta || {} };
  }

  if (Array.isArray(body?.rows)) {
    return { rows: body.rows, meta: body?.meta || {} };
  }

  return { rows: [], meta: {} };
}

export function ClusterNodes() {
  const t = useT();
  const api = useApp().apiClient;
  const [loading, setLoading] = useState(false);
  const [currentNode, setCurrentNode] = useState<any>(null);
  const [environments, setEnvironments] = useState<any[]>([]);
  const [clusterListMeta, setClusterListMeta] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [drift, setDrift] = useState<any>(null);
  const [legacyDiagnostics, setLegacyDiagnostics] = useState<any>(null);
  const [autoRefresh, setAutoRefresh] = useState<number | null>(null);
  const [logNode, setLogNode] = useState<any>(null);
  const [rollingRole, setRollingRole] = useState<'worker' | 'app' | 'sandbox' | 'all'>('worker');
  const [rollingMode, setRollingMode] = useState<'soft' | 'hard'>('soft');
  const [rollingDelayMs, setRollingDelayMs] = useState(5000);
  const [rolling, setRolling] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [currentRes, listRes, healthRes, driftRes, legacyRes] = await Promise.all([
        api.request({ url: 'clusterManagerCluster:current' }),
        api.request({ url: 'clusterManagerCluster:list' }),
        api.request({ url: 'clusterManagerCluster:health' }),
        api.request({ url: 'clusterManagerCluster:drift' }),
        api.request({ url: 'clusterManagerCluster:legacyDiagnostics' }),
      ]);
      const listPayload = readClusterListPayload(listRes);
      setCurrentNode(currentRes?.data?.data);
      setEnvironments(listPayload.rows);
      setClusterListMeta(listPayload.meta);
      setHealth(healthRes?.data?.data);
      setDrift(driftRes?.data?.data);
      setLegacyDiagnostics(legacyRes?.data?.data);
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
        data: { hostname, mode },
      });
      message.success(`[${mode}] Restart signal sent to ${hostname === '*' ? 'all nodes' : hostname}`);
      setTimeout(fetchData, 3000);
    } catch {
      message.error(`Failed to send restart signal to ${hostname}`);
    }
  };

  const handleRollingRestart = async () => {
    setRolling(true);
    try {
      const res = await api.request({
        url: 'clusterManagerCluster:rollingRestart',
        method: 'POST',
        data: {
          role: rollingRole,
          mode: rollingMode,
          delayMs: rollingDelayMs,
        },
      });
      const count = res?.data?.data?.published?.length || 0;
      message.success(t('Rolling restart dispatched for {count} node(s)').replace('{count}', String(count)));
      setTimeout(fetchData, 3000);
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || t('Failed to dispatch rolling restart'));
    } finally {
      setRolling(false);
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
        <Tag
          color={statusColors[status] || 'default'}
          icon={
            status === 'online' ? (
              <CheckCircleOutlined />
            ) : status === 'warning' ? (
              <WarningOutlined />
            ) : (
              <CloseCircleOutlined />
            )
          }
        >
          {status.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: t('Type'),
      dataIndex: 'workerMode',
      key: 'workerMode',
      width: 150,
      render: (mode: string, record: any) => {
        const role = getNodeRole(record);
        if (role === 'sandbox') {
          return <Tag color="purple">SANDBOX</Tag>;
        }
        if (role === 'app' && isWorkerOnlyMode(mode)) {
          return (
            <Space size={4}>
              <Tag color="green">APP</Tag>
              <Tag color="blue">QUEUES</Tag>
            </Space>
          );
        }
        return <Tag color={role === 'worker' ? 'blue' : 'green'}>{role === 'worker' ? 'WORKER' : 'APP'}</Tag>;
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
          <Button
            type="link"
            icon={<FileTextOutlined />}
            onClick={() => setLogNode(r)}
            disabled={r.status === 'offline'}
          >
            {t('Logs')}
          </Button>
        </Space>
      ),
    },
  ];

  const healthChecks = health?.checks || {};
  const driftSummary = drift?.summary || {};
  const packageDrifts = drift?.packageDrifts || [];
  const versionDrifts = drift?.versionDrifts || [];
  const runtimeDrifts = drift?.runtimeDrifts || [];
  const legacyFindings = legacyDiagnostics?.findings || [];
  const registryStatus = clusterListMeta?.registry || {};
  const showRegistryNotice = Boolean(
    clusterListMeta?.fallback || registryStatus.lastHeartbeatError || registryStatus.lastReadError,
  );
  const renderFindingMessage = (finding: any) => {
    const template = finding.messageKey ? t(finding.messageKey) : finding.message;
    if (!finding.messageArgs) {
      return template;
    }
    return Object.entries(finding.messageArgs).reduce(
      (text, [key, value]) => text.replace(`{${key}}`, String(value)),
      template,
    );
  };

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* Toolbar */}
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchData}>
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
          <Space>
            <Popconfirm
              title="Soft Restart ALL Nodes?"
              description="Sends a soft reload signal to all active Nodes simultaneously."
              onConfirm={() => handleRestartNode('*', 'soft')}
            >
              <Button style={{ color: '#faad14', borderColor: '#ffe58f' }} icon={<ReloadOutlined />}>
                {t('Soft Restart Cluster')}
              </Button>
            </Popconfirm>
            <Popconfirm
              title="Hard Restart ALL Nodes?"
              description="Sends a lethal signal. Docker will reboot ALL container infrastructure."
              onConfirm={() => handleRestartNode('*', 'hard')}
            >
              <Button danger icon={<ReloadOutlined />}>
                {t('Hard Restart Cluster')}
              </Button>
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
                value={environments.filter((e) => servesWorkerQueues(e)).length}
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

        <Card title={t('Rolling Restart')} size="small">
          <Space wrap>
            <Select
              value={rollingRole}
              onChange={setRollingRole}
              style={{ width: 180 }}
              options={[
                { value: 'worker', label: t('Worker nodes only') },
                { value: 'app', label: t('App nodes only') },
                { value: 'sandbox', label: t('Sandbox nodes only') },
                { value: 'all', label: t('All nodes') },
              ]}
            />
            <Select
              value={rollingMode}
              onChange={setRollingMode}
              style={{ width: 150 }}
              options={[
                { value: 'soft', label: t('Soft restart') },
                { value: 'hard', label: t('Hard restart') },
              ]}
            />
            <InputNumber
              min={1000}
              max={60000}
              step={1000}
              value={rollingDelayMs}
              onChange={(value) => setRollingDelayMs(Number(value) || 5000)}
              addonAfter="ms"
              style={{ width: 150 }}
            />
            <Popconfirm
              title={t('Start rolling restart?')}
              description={t('Nodes will receive restart commands one-by-one with the configured delay.')}
              onConfirm={handleRollingRestart}
              okText={t('Start')}
              cancelText={t('Cancel')}
            >
              <Button icon={<ReloadOutlined />} loading={rolling}>
                {t('Rolling Restart')}
              </Button>
            </Popconfirm>
          </Space>
        </Card>

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
                  {check.latency !== undefined && <div style={{ fontSize: 11, color: '#888' }}>{check.latency}ms</div>}
                  {check.detail && <div style={{ fontSize: 11, color: '#888' }}>{check.detail}</div>}
                </Card>
              </Col>
            ))}
          </Row>
        </Card>

        <Card
          title={t('Cluster Drift')}
          size="small"
          extra={
            drift?.checkedAt ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {new Date(drift.checkedAt).toLocaleString()}
              </Typography.Text>
            ) : null
          }
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Alert
              type={drift?.healthy ? 'success' : 'warning'}
              showIcon
              message={drift?.healthy ? t('No cluster drift detected') : t('Cluster drift detected')}
              description={
                drift?.referenceVersion
                  ? `${t('Reference version')}: ${drift.referenceVersion}`
                  : t('No reference version available')
              }
            />
            <Row gutter={16}>
              <Col span={6}>
                <Statistic title={t('Checked Nodes')} value={driftSummary.nodes || 0} />
              </Col>
              <Col span={6}>
                <Statistic title={t('Version Drift')} value={driftSummary.versionDrifts || 0} />
              </Col>
              <Col span={6}>
                <Statistic title={t('Runtime Drift')} value={driftSummary.runtimeDrifts || 0} />
              </Col>
              <Col span={6}>
                <Statistic title={t('Package Drift')} value={driftSummary.packageDrifts || 0} />
              </Col>
            </Row>

            {(versionDrifts.length > 0 || runtimeDrifts.length > 0) && (
              <Table
                size="small"
                rowKey={(record: any) =>
                  `${record.id || record.name}:${record.actualVersion || record.actual?.nodeVersion}`
                }
                pagination={false}
                dataSource={[
                  ...versionDrifts.map((item: any) => ({ ...item, driftType: t('Version') })),
                  ...runtimeDrifts.map((item: any) => ({
                    ...item,
                    driftType: t('Runtime'),
                    expectedVersion: item.expected?.nodeVersion,
                    actualVersion: item.actual?.nodeVersion,
                  })),
                ]}
                columns={[
                  { title: t('Type'), dataIndex: 'driftType', width: 120 },
                  { title: t('Name'), dataIndex: 'name' },
                  { title: t('Role'), dataIndex: 'role', width: 120 },
                  { title: t('Expected'), dataIndex: 'expectedVersion' },
                  { title: t('Actual'), dataIndex: 'actualVersion' },
                ]}
              />
            )}

            {packageDrifts.length > 0 && (
              <Table
                size="small"
                rowKey={(record: any) => record.id || record.name}
                pagination={{ pageSize: 5 }}
                dataSource={packageDrifts}
                columns={[
                  { title: t('Name'), dataIndex: 'name' },
                  { title: t('Role'), dataIndex: 'role', width: 110 },
                  {
                    title: t('Package Status'),
                    dataIndex: 'status',
                    width: 130,
                    render: (status: string) => <Tag color={status === 'succeeded' ? 'green' : 'orange'}>{status}</Tag>,
                  },
                  {
                    title: t('Missing Packages'),
                    dataIndex: 'missingPackages',
                    render: (packages: any) =>
                      countPackages(packages) === 0 ? (
                        <Typography.Text type="secondary">{t('No missing packages')}</Typography.Text>
                      ) : (
                        <Space direction="vertical" size={2}>
                          <div>APT: {renderPackageGroup(packages?.apt)}</div>
                          <div>NPM: {renderPackageGroup(packages?.npm)}</div>
                          <div>Python: {renderPackageGroup(packages?.python)}</div>
                        </Space>
                      ),
                  },
                ]}
              />
            )}
          </Space>
        </Card>

        <Card title={t('Legacy Multi-app Diagnostics')} size="small">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type={legacyDiagnostics?.healthy ? 'success' : 'warning'}
              showIcon
              message={
                legacyDiagnostics?.healthy
                  ? t('No legacy multi-app risk detected')
                  : t('Legacy multi-app risk detected')
              }
            />
            {legacyFindings.map((finding: any) => (
              <Alert
                key={finding.code}
                type={finding.level === 'warning' ? 'warning' : 'info'}
                showIcon
                message={renderFindingMessage(finding)}
              />
            ))}
            <Space wrap>
              {(legacyDiagnostics?.plugins || []).map((plugin: any) => (
                <Tag key={plugin.name} color={plugin.enabled || plugin.loaded ? 'orange' : 'default'}>
                  {plugin.name}: {plugin.enabled ? t('Enabled') : t('Disabled')}
                </Tag>
              ))}
              <Tag color={legacyDiagnostics?.appSupervisor?.enabled ? 'green' : 'default'}>
                app-supervisor: {legacyDiagnostics?.appSupervisor?.enabled ? t('Enabled') : t('Disabled')}
              </Tag>
              <Tag>
                {t('Legacy app records')}: {legacyDiagnostics?.legacyApplicationCount || 0}
              </Tag>
            </Space>
          </Space>
        </Card>

        {/* Cluster nodes table */}
        <Card title={t('Cluster Nodes')} size="small">
          {showRegistryNotice && (
            <Alert
              type={registryStatus.configured ? 'warning' : 'info'}
              showIcon
              style={{ marginBottom: 12 }}
              message={
                registryStatus.configured
                  ? t('Cluster registry has no worker heartbeats')
                  : t('Cluster registry Redis is not configured')
              }
              description={
                registryStatus.configured
                  ? t(
                      'Cluster Nodes reads Redis heartbeats, not the container runtime. Check worker boot, plugin-cluster-manager, and shared Redis configuration.',
                    )
                  : t(
                      'Set REDIS_URL or CLUSTER_MANAGER_REDIS_URL on every app and worker to enable cluster node discovery.',
                    )
              }
            />
          )}
          <Table
            dataSource={environments}
            columns={nodeColumns}
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
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
              <Descriptions.Item label={t('Worker Mode')}>
                {currentNode.node.workerMode || '(default)'}
              </Descriptions.Item>
              <Descriptions.Item label={t('App Port')}>{currentNode.node.appPort}</Descriptions.Item>
              <Descriptions.Item label={t('Cluster Mode')}>
                {currentNode.node.clusterMode || '(disabled)'}
              </Descriptions.Item>
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
