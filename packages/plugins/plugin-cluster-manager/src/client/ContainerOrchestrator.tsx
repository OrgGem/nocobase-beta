import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  InputNumber,
  Popconfirm,
  message,
  Modal,
  Typography,
  Alert,
  Spin,
  Tooltip,
  Badge,
  Row,
  Col,
  Form,
  Input,
  Select,
  Switch,
} from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  DeleteOutlined,
  FileTextOutlined,
  ReloadOutlined,
  ExpandAltOutlined,
  ShrinkOutlined,
  CloudServerOutlined,
  ApiOutlined,
  SettingOutlined,
  SaveOutlined,
  PlusOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './utils';

const { Text, Title } = Typography;

interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  image: string;
  createdAt: string;
  cpu?: number;
  memory?: number;
}

interface StackInfo {
  id: number;
  name: string;
  adapter: string;
  image: string;
  command?: string;
  envVars?: Record<string, string>;
  resourceLimits?: Record<string, string>;
  replicas: number;
  desiredReplicas: number;
  enabled: boolean;
  namespace?: string;
  deploymentName?: string;
  serviceAccountName?: string;
  imagePullPolicy?: string;
  k8sContainerName?: string;
  k8sEnv?: Record<string, any>[];
  k8sEnvFrom?: Record<string, any>[];
  k8sVolumeMounts?: Record<string, any>[];
  k8sVolumes?: Record<string, any>[];
}

const DEFAULT_WORKER_COMMAND = `export NOCOBASE_RUNNING_IN_DOCKER=true
if ! command -v git >/dev/null; then echo "Installing git..."; if command -v apt-get >/dev/null; then apt-get update && apt-get install -y git; elif command -v apk >/dev/null; then apk add git; fi; fi
if [ ! -d /app/nocobase ]; then mkdir -p /app/nocobase; fi
if [ ! -f /app/nocobase/package.json ]; then
  echo "copying..."
  tar -zxf /app/nocobase.tar.gz --absolute-names -C /app/nocobase
  touch /app/nocobase/node_modules/@nocobase/app/dist/client/index.html
fi
echo "Applying license hotfix..."
cd /app/nocobase && echo "module.exports={getEnvAsync:async()=>({sys:'mock',osVer:'mock',db:{id:'mock'}}),getInstanceIdWithPublicKeyAsync:async()=>'mock',getInstanceIdAsync:async()=>'mock',instanceIdDecrypt:()=>'mock',createKeyPair:()=>({publicKey:'mock',privateKey:'mock'}),encryptWithPublicKey:()=>'mock',encrypt:()=>'mock',decryptWithPrivateKey:()=>'mock',createSignature:()=>'mock',verifySignature:()=>true,keyEncrypt:()=>'mock',keyDecrypt:()=>JSON.stringify({licenseKey:{domain:'*'}})}" > node_modules/@nocobase/license-kit/index.js
cd /app/nocobase && yarn nocobase postinstall
PRIMARY_URL="http://app-1:13000/api/app:getInfo"
MAX_WAIT=900
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if wget -q --spider "$PRIMARY_URL" 2>/dev/null; then
    echo "Primary ready after \${WAITED}s. Waiting an additional 15s..."
    sleep 15
    break
  fi
  sleep 5
  WAITED=$((WAITED + 5))
done
exec yarn --cwd /app/nocobase start`;

const DEFAULT_WORKER_ENV = {
  APP_ROLE: 'worker',
  WORKER_MODE: '*',
  APP_PORT: '13000',
  SKILL_HUB_SANDBOX: 'false',
};

const DEFAULT_K8S_ENV_FROM = [
  { configMapRef: { name: 'nocobase-config' } },
  { secretRef: { name: 'nocobase-secret' } },
];

const DEFAULT_K8S_VOLUME_MOUNTS = [
  { name: 'app-storage', mountPath: '/app/nocobase/storage' },
  { name: 'script-volume', mountPath: '/hotfix-license.js', subPath: 'hotfix-license.js' },
];

const DEFAULT_K8S_VOLUMES = [
  { name: 'app-storage', persistentVolumeClaim: { claimName: 'app-storage' } },
  { name: 'script-volume', configMap: { name: 'nocobase-scripts' } },
];

const STATUS_COLORS: Record<string, string> = {
  running: 'green',
  stopped: 'orange',
  exited: 'red',
  pending: 'blue',
  creating: 'cyan',
  error: 'red',
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function jsonText(value: any, fallback: any): string {
  return JSON.stringify(value ?? fallback, null, 2);
}

function parseJsonText(value: string | undefined, fallback: any, label: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function stackToFormValues(stack?: StackInfo | null) {
  if (!stack) {
    return {
      name: 'app-workers',
      adapter: 'kubernetes',
      image: 'nocobase/nocobase:2.1.6-full',
      command: DEFAULT_WORKER_COMMAND,
      envVars: jsonText(DEFAULT_WORKER_ENV, {}),
      resourceLimits: jsonText({ memory: '1536Mi' }, {}),
      desiredReplicas: 1,
      enabled: true,
      namespace: 'nocobase',
      deploymentName: 'app-workers',
      serviceAccountName: 'nocobase-orchestrator',
      imagePullPolicy: 'IfNotPresent',
      k8sContainerName: 'worker',
      k8sEnv: jsonText([], []),
      k8sEnvFrom: jsonText(DEFAULT_K8S_ENV_FROM, []),
      k8sVolumeMounts: jsonText(DEFAULT_K8S_VOLUME_MOUNTS, []),
      k8sVolumes: jsonText(DEFAULT_K8S_VOLUMES, []),
      networkMode: '',
    };
  }

  return {
    ...stack,
    envVars: jsonText(stack.envVars, {}),
    resourceLimits: jsonText(stack.resourceLimits, {}),
    k8sEnv: jsonText(stack.k8sEnv, []),
    k8sEnvFrom: jsonText(stack.k8sEnvFrom, []),
    k8sVolumeMounts: jsonText(stack.k8sVolumeMounts, []),
    k8sVolumes: jsonText(stack.k8sVolumes, []),
  };
}

function formValuesToStack(values: any) {
  return {
    ...values,
    envVars: parseJsonText(values.envVars, {}, 'Environment variables'),
    resourceLimits: parseJsonText(values.resourceLimits, {}, 'Resource limits'),
    k8sEnv: parseJsonText(values.k8sEnv, [], 'Kubernetes env'),
    k8sEnvFrom: parseJsonText(values.k8sEnvFrom, [], 'Kubernetes envFrom'),
    k8sVolumeMounts: parseJsonText(values.k8sVolumeMounts, [], 'Kubernetes volume mounts'),
    k8sVolumes: parseJsonText(values.k8sVolumes, [], 'Kubernetes volumes'),
    desiredReplicas: Number(values.desiredReplicas || 0),
    replicas: Number(values.replicas || 0),
  };
}

export function ContainerOrchestrator() {
  const t = useT();
  const api = useApp().apiClient;
  const [loading, setLoading] = useState(false);
  const [stacks, setStacks] = useState<StackInfo[]>([]);
  const [containers, setContainers] = useState<Record<number, ContainerInfo[]>>({});
  const [containerMeta, setContainerMeta] = useState<Record<number, any>>({});
  const [scaleValues, setScaleValues] = useState<Record<number, number>>({});
  const [logModal, setLogModal] = useState<{ visible: boolean; containerId: string; logs: string[] }>({
    visible: false,
    containerId: '',
    logs: [],
  });
  const [pkgLogModal, setPkgLogModal] = useState<{ visible: boolean; containerName: string; logs: string }>({
    visible: false,
    containerName: '',
    logs: '',
  });
  const [pingResult, setPingResult] = useState<any>(null);
  const [settingsModal, setSettingsModal] = useState(false);
  const [stackModal, setStackModal] = useState<{ visible: boolean; stack?: StackInfo | null }>({
    visible: false,
    stack: null,
  });
  const [settingsForm] = Form.useForm();
  const [stackForm] = Form.useForm();
  const [dockerNetworks, setDockerNetworks] = useState<{ id: string; name: string }[]>([]);

  // Fetch Docker networks
  const fetchNetworks = useCallback(async () => {
    try {
      const res = await api.request({ url: '/workerOrchestrator:networks' });
      let networks = res.data?.data || res.data;
      if (!Array.isArray(networks)) networks = [];
      setDockerNetworks(networks);
    } catch {
      setDockerNetworks([]);
    }
  }, [api]);

  // Ping the orchestrator adapter
  const fetchPing = useCallback(async () => {
    try {
      const res = await api.request({ url: '/workerOrchestrator:ping' });
      setPingResult(res.data?.data || res.data);
    } catch {
      setPingResult({ connected: false, adapter: 'unknown' });
    }
  }, [api]);

  // Load stacks from DB
  const fetchStacks = useCallback(async () => {
    try {
      const res = await api.request({ url: '/orchestratorStacks:list', params: { pageSize: 50 } });
      const data = res.data?.data || [];
      setStacks(data);
      // Init scale values
      const sv: Record<number, number> = {};
      data.forEach((s: StackInfo) => {
        sv[s.id] = s.desiredReplicas;
      });
      setScaleValues(sv);
    } catch {
      // Collection might not exist yet
    }
  }, [api]);

  // Load containers for a specific stack
  const fetchContainers = useCallback(
    async (stackId: number) => {
      try {
        const res = await api.request({
          url: '/workerOrchestrator:containers',
          params: { stackId },
        });
        const data = res.data?.data || res.data;
        setContainers((prev) => ({ ...prev, [stackId]: data.data || [] }));
        setContainerMeta((prev) => ({ ...prev, [stackId]: data.meta || {} }));
      } catch (err: any) {
        message.error(`Failed to load containers: ${err.message}`);
      }
    },
    [api],
  );

  // Load settings
  const fetchSettings = useCallback(async () => {
    try {
      const res = await api.request({ url: '/workerOrchestrator:getSettings' });
      settingsForm.setFieldsValue(res.data?.data || res.data);
    } catch {
      // Settings not yet available — leave form at defaults
    }
  }, [api, settingsForm]);

  // Save settings
  const handleSaveSettings = async (values: any) => {
    setLoading(true);
    try {
      await api.request({
        url: '/workerOrchestrator:saveSettings',
        method: 'POST',
        data: values,
      });
      message.success(t('Settings saved successfully. Reconnecting...'));
      setSettingsModal(false);
      await fetchPing();
      await fetchStacks();
    } catch (err: any) {
      message.error(`Failed to save settings: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const openStackModal = (stack?: StackInfo) => {
    setStackModal({ visible: true, stack: stack || null });
    stackForm.setFieldsValue(stackToFormValues(stack));
    fetchNetworks();
  };

  const closeStackModal = () => {
    setStackModal({ visible: false, stack: null });
    stackForm.resetFields();
  };

  const handleSaveStack = async (values: any) => {
    setLoading(true);
    try {
      const payload = formValuesToStack(values);
      if (stackModal.stack?.id) {
        await api.request({
          url: '/orchestratorStacks:update',
          method: 'put',
          params: { filterByTk: stackModal.stack.id },
          data: payload,
        });
        message.success(t('Worker stack updated'));
      } else {
        await api.request({
          url: '/orchestratorStacks:create',
          method: 'post',
          data: payload,
        });
        message.success(t('Worker stack created'));
      }
      closeStackModal();
      await fetchStacks();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed to save worker stack'));
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchPing();
    fetchStacks();
    fetchSettings();
  }, [fetchPing, fetchStacks, fetchSettings]);

  // Load containers for each stack and poll every 10s
  useEffect(() => {
    const doFetch = () => {
      stacks.forEach((s) => fetchContainers(s.id));
    };
    doFetch();

    const interval = setInterval(() => {
      fetchStacks(); // refresh stack info
      doFetch(); // refresh containers
    }, 10000);

    return () => clearInterval(interval);
  }, [stacks, fetchContainers, fetchStacks]);

  // Scale action
  const handleScale = async (stackId: number) => {
    const replicas = scaleValues[stackId];
    if (replicas === undefined) return;
    setLoading(true);
    try {
      const res = await api.request({
        url: '/workerOrchestrator:scale',
        method: 'POST',
        data: { stackId, replicas },
      });
      const result = res.data?.data || res.data;
      message.success(`Scaled: ${result.previousReplicas} → ${result.currentReplicas} replicas`);
      await fetchContainers(stackId);
      await fetchStacks();
    } catch (err: any) {
      message.error(err.response?.data?.errors?.[0]?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  // Start/Stop/Remove actions
  const handleAction = async (action: string, containerId: string, stackId: number) => {
    setLoading(true);
    try {
      await api.request({
        url: `/workerOrchestrator:${action}`,
        method: 'POST',
        data: { stackId, containerId },
      });
      message.success(`${action} ${containerId} successful`);
      await fetchContainers(stackId);
    } catch (err: any) {
      message.error(err.response?.data?.errors?.[0]?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  // View logs
  const handleViewLogs = async (containerId: string, stackId: number) => {
    try {
      const res = await api.request({
        url: '/workerOrchestrator:logs',
        params: { stackId, containerId, tail: 200 },
      });
      const data = res.data?.data || res.data;
      setLogModal({ visible: true, containerId, logs: data.lines || [] });
    } catch (err: any) {
      message.error(`Failed to get logs: ${err.message}`);
    }
  };

  // Container table columns
  const containerColumns = [
    {
      title: t('Container'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: ContainerInfo) => (
        <Space>
          <Text code style={{ fontSize: 11 }}>
            {record.id}
          </Text>
          <Text>{name}</Text>
        </Space>
      ),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => <Tag color={STATUS_COLORS[status] || 'default'}>{status.toUpperCase()}</Tag>,
    },
    {
      title: t('Packages'),
      key: 'packages',
      width: 140,
      render: (_: any, record: any) => {
        const pStatus = record.packageStatus;
        if (!pStatus) return <Text type="secondary">-</Text>;
        let color = 'processing';
        if (pStatus.initStatus === 'succeeded') color = 'success';
        if (pStatus.initStatus === 'failed') color = 'error';
        return (
          <Tooltip title={pStatus.initProgressLog || 'Click to view logs'}>
            <Tag
              color={color}
              style={{ cursor: 'pointer' }}
              onClick={() =>
                setPkgLogModal({ visible: true, containerName: record.name, logs: pStatus.lastInitLog || '' })
              }
            >
              {pStatus.initStatus === 'running' && <ReloadOutlined spin style={{ marginRight: 4 }} />}
              {pStatus.initStatus === 'succeeded'
                ? 'Installed'
                : pStatus.initStatus === 'failed'
                  ? 'Failed'
                  : `${pStatus.initProgressPercent || 0}%`}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: t('Image'),
      dataIndex: 'image',
      key: 'image',
      ellipsis: true,
      render: (img: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {img}
        </Text>
      ),
    },
    {
      title: t('Age'),
      dataIndex: 'createdAt',
      key: 'age',
      width: 80,
      render: (dt: string) => (dt ? formatAge(dt) : '-'),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 160,
      render: (_: any, record: ContainerInfo & { _stackId?: number }) => {
        const isK8s = pingResult?.adapter === 'kubernetes';
        return (
          <Space size="small">
            {!isK8s &&
              (record.status === 'running' ? (
                <Tooltip title={t('Stop')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<PauseCircleOutlined />}
                    onClick={() => handleAction('stop', record.id, record._stackId!)}
                  />
                </Tooltip>
              ) : (
                <Tooltip title={t('Start')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<PlayCircleOutlined style={{ color: '#52c41a' }} />}
                    onClick={() => handleAction('start', record.id, record._stackId!)}
                  />
                </Tooltip>
              ))}
            <Tooltip title={t('Logs')}>
              <Button
                size="small"
                type="text"
                icon={<FileTextOutlined />}
                onClick={() => handleViewLogs(record.id, record._stackId!)}
              />
            </Tooltip>
            <Popconfirm
              title={t('Remove this container?')}
              onConfirm={() => handleAction('remove', record.id, record._stackId!)}
            >
              <Tooltip title={t('Remove')}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  if (!pingResult) {
    return (
      <Spin
        tip={t('Connecting to orchestrator...')}
        style={{ display: 'flex', justifyContent: 'center', padding: 48 }}
      />
    );
  }

  return (
    <div>
      {/* Header */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Space>
              <ApiOutlined style={{ fontSize: 18 }} />
              <Text strong>{t('Adapter')}: </Text>
              <Tag color="blue">{pingResult.adapter?.toUpperCase() || 'NONE'}</Tag>
              <Badge
                status={pingResult.connected ? 'success' : 'error'}
                text={pingResult.connected ? t('Connected') : t('Disconnected')}
              />
              {pingResult.leader !== undefined && (
                <>
                  <Text type="secondary">|</Text>
                  <Badge
                    status={pingResult.leader ? 'success' : 'default'}
                    text={pingResult.leader ? t('Leader (this node)') : t('Follower')}
                  />
                </>
              )}
            </Space>
          </Col>
          <Col>
            <Space>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openStackModal()}>
                {t('New worker stack')}
              </Button>
              <Button icon={<SettingOutlined />} onClick={() => setSettingsModal(true)}>
                {t('Settings')}
              </Button>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  fetchPing();
                  fetchStacks();
                }}
              >
                {t('Refresh')}
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {!pingResult.connected ? (
        <Alert
          type="warning"
          showIcon
          message={t('Orchestrator Not Connected')}
          description={t('Please configure the adapter settings and ensure the container runtime is accessible.')}
          style={{ marginBottom: 16 }}
          action={
            <Button size="small" type="primary" onClick={() => setSettingsModal(true)}>
              {t('Configure Settings')}
            </Button>
          }
        />
      ) : (
        <>
          {/* Stacks */}
          {stacks.length === 0 && (
            <Alert
              type="info"
              showIcon
              message={t('No stacks configured')}
              description={t('Create a worker stack here, then scale it to start worker pods.')}
              style={{ marginBottom: 16 }}
            />
          )}

          {stacks.map((stack) => {
            const stackContainers = (containers[stack.id] || []).map((c) => ({ ...c, _stackId: stack.id }));
            const meta = containerMeta[stack.id] || {};

            return (
              <Card
                key={stack.id}
                title={
                  <Space>
                    <CloudServerOutlined />
                    <span>{stack.name}</span>
                    <Tag>{stack.adapter}</Tag>
                  </Space>
                }
                extra={
                  <Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {stack.image}
                    </Text>
                    <Tooltip title={t('Edit worker stack')}>
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openStackModal(stack)} />
                    </Tooltip>
                  </Space>
                }
                style={{ marginBottom: 16 }}
              >
                {/* Scale controls */}
                <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Text>{t('Replicas')}:</Text>
                  <Button
                    size="small"
                    icon={<ShrinkOutlined />}
                    disabled={loading || (scaleValues[stack.id] || 0) <= 0}
                    onClick={() =>
                      setScaleValues((prev) => ({ ...prev, [stack.id]: Math.max(0, (prev[stack.id] || 0) - 1) }))
                    }
                  />
                  <InputNumber
                    min={0}
                    max={20}
                    value={scaleValues[stack.id] ?? stack.desiredReplicas}
                    onChange={(v) => setScaleValues((prev) => ({ ...prev, [stack.id]: v ?? 0 }))}
                    style={{ width: 70 }}
                  />
                  <Button
                    size="small"
                    icon={<ExpandAltOutlined />}
                    disabled={loading || (scaleValues[stack.id] || 0) >= 20}
                    onClick={() =>
                      setScaleValues((prev) => ({ ...prev, [stack.id]: Math.min(20, (prev[stack.id] || 0) + 1) }))
                    }
                  />
                  <Button
                    type="primary"
                    loading={loading}
                    onClick={() => handleScale(stack.id)}
                    disabled={(scaleValues[stack.id] ?? stack.desiredReplicas) === meta.running}
                  >
                    {t('Scale')}
                  </Button>
                  <Text type="secondary">
                    {meta.running ?? '?'} / {scaleValues[stack.id] ?? stack.desiredReplicas} {t('running')}
                  </Text>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchContainers(stack.id)} />
                </div>

                {/* Container list */}
                <Table
                  dataSource={stackContainers}
                  columns={containerColumns}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: t('No containers') }}
                />
              </Card>
            );
          })}
        </>
      )}

      {/* Log viewer modal */}
      <Modal
        title={`${t('Logs')}: ${logModal.containerId}`}
        open={logModal.visible}
        onCancel={() => setLogModal({ visible: false, containerId: '', logs: [] })}
        footer={null}
        width={900}
      >
        <pre
          style={{
            maxHeight: 500,
            overflow: 'auto',
            background: '#1e1e1e',
            color: '#d4d4d4',
            padding: 12,
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.6,
            fontFamily: 'Consolas, Monaco, monospace',
          }}
        >
          {logModal.logs.length > 0 ? logModal.logs.join('\n') : t('No logs available')}
        </pre>
      </Modal>

      {/* Package Log viewer modal */}
      <Modal
        title={`${t('Package Logs')}: ${pkgLogModal.containerName}`}
        open={pkgLogModal.visible}
        onCancel={() => setPkgLogModal({ visible: false, containerName: '', logs: '' })}
        footer={null}
        width={900}
      >
        <pre
          style={{
            maxHeight: 500,
            overflow: 'auto',
            background: '#1e1e1e',
            color: '#d4d4d4',
            padding: 12,
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.6,
            fontFamily: 'Consolas, Monaco, monospace',
            whiteSpace: 'pre-wrap',
          }}
        >
          {pkgLogModal.logs || t('No logs available')}
        </pre>
      </Modal>

      {/* Worker Stack Modal */}
      <Modal
        title={stackModal.stack ? t('Edit worker stack') : t('New worker stack')}
        open={stackModal.visible}
        onCancel={closeStackModal}
        onOk={() => stackForm.submit()}
        okText={t('Save')}
        confirmLoading={loading}
        width={860}
        destroyOnClose
      >
        <Form form={stackForm} layout="vertical" onFinish={handleSaveStack}>
          {/* Row 1: Stack name | Image */}
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="name"
                label={t('Stack name')}
                rules={[
                  { required: true, message: t('Stack name is required') },
                  { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: t('Use a lowercase Kubernetes-safe name') },
                ]}
              >
                <Input placeholder="app-workers" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="image" label={t('Image')} rules={[{ required: true }]}>
                <Input placeholder="nocobase/nocobase:2.0.46-full" />
              </Form.Item>
            </Col>
          </Row>

          {/* Row 2: Adapter | Desired replicas | Enabled */}
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="adapter" label={t('Adapter')} rules={[{ required: true }]}>
                <Select>
                  <Select.Option value="kubernetes">{t('Kubernetes')}</Select.Option>
                  <Select.Option value="docker">{t('Docker')}</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="desiredReplicas" label={t('Desired replicas')} rules={[{ required: true }]}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>

          {/* Row 3: Deployment name | Service account | Image pull policy */}
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="deploymentName" label={t('Deployment name')}>
                <Input placeholder="app-workers" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="serviceAccountName" label={t('Service account')}>
                <Input placeholder="nocobase-orchestrator" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="imagePullPolicy" label={t('Image pull policy')}>
                <Select>
                  <Select.Option value="IfNotPresent">IfNotPresent</Select.Option>
                  <Select.Option value="Always">Always</Select.Option>
                  <Select.Option value="Never">Never</Select.Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          {/* Row 4: Container name | Namespace | Network Mode */}
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="k8sContainerName" label={t('Container name')}>
                <Input placeholder="worker" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="namespace" label={t('Namespace')}>
                <Input placeholder="nocobase" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item noStyle shouldUpdate={(prev, curr) => prev.adapter !== curr.adapter}>
                {() => {
                  if (stackForm.getFieldValue('adapter') === 'docker') {
                    return (
                      <Form.Item
                        name="networkMode"
                        label={t('Docker Network')}
                        extra={t('Main network. Workers also inherit app networks.')}
                      >
                        <Select allowClear placeholder={t('Default (bridge)')}>
                          <Select.Option value="bridge">bridge</Select.Option>
                          <Select.Option value="host">host</Select.Option>
                          {(Array.isArray(dockerNetworks) ? dockerNetworks : []).map((n) => (
                            <Select.Option key={n.id} value={n.name}>
                              {n.name}
                            </Select.Option>
                          ))}
                        </Select>
                      </Form.Item>
                    );
                  }
                  return null;
                }}
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="command" label={t('Command')}>
            <Input.TextArea rows={10} />
          </Form.Item>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="envVars" label={t('Environment variables JSON')}>
                <Input.TextArea rows={8} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="resourceLimits" label={t('Resource limits JSON')}>
                <Input.TextArea rows={8} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="k8sEnvFrom" label={t('Kubernetes envFrom JSON')}>
                <Input.TextArea rows={7} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="k8sEnv" label={t('Kubernetes env JSON')}>
                <Input.TextArea rows={7} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="k8sVolumeMounts" label={t('Kubernetes volumeMounts JSON')}>
                <Input.TextArea rows={7} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="k8sVolumes" label={t('Kubernetes volumes JSON')}>
                <Input.TextArea rows={7} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* Settings Modal */}
      <Modal
        title={t('Orchestrator Settings')}
        open={settingsModal}
        onCancel={() => setSettingsModal(false)}
        footer={null}
        width={600}
      >
        <Form
          form={settingsForm}
          layout="vertical"
          onFinish={handleSaveSettings}
          initialValues={{ adapterType: 'none', k8sNamespace: 'nocobase', workerLabelSelector: 'role=worker' }}
        >
          <Form.Item name="adapterType" label={t('Adapter')} rules={[{ required: true }]}>
            <Select>
              <Select.Option value="none">{t('Disabled')}</Select.Option>
              <Select.Option value="docker">{t('Docker')}</Select.Option>
              <Select.Option value="kubernetes">{t('Kubernetes')}</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item noStyle shouldUpdate={(prev, curr) => prev.adapterType !== curr.adapterType}>
            {() => {
              const adapter = settingsForm.getFieldValue('adapterType');
              if (adapter === 'docker') {
                return (
                  <Card size="small" title={t('Docker Configuration')} style={{ marginBottom: 16 }}>
                    <Form.Item name="dockerSocketPath" label={t('Socket Path')} extra="/var/run/docker.sock">
                      <Input />
                    </Form.Item>
                    <Form.Item
                      name="dockerHost"
                      label={t('TCP Host')}
                      extra="e.g. tcp://192.168.1.10:2376 (Overrides socket)"
                    >
                      <Input />
                    </Form.Item>
                  </Card>
                );
              }
              if (adapter === 'kubernetes') {
                return (
                  <Card size="small" title={t('Kubernetes Configuration')} style={{ marginBottom: 16 }}>
                    <Form.Item name="k8sNamespace" label={t('Namespace')} extra="nocobase">
                      <Input />
                    </Form.Item>
                    <Form.Item
                      name="k8sKubeconfig"
                      label={t('Kubeconfig')}
                      extra="Paste kubeconfig YAML or enter a file path. Leave empty to use in-cluster ServiceAccount."
                    >
                      <Input.TextArea rows={4} />
                    </Form.Item>
                  </Card>
                );
              }
              return null;
            }}
          </Form.Item>

          <Form.Item
            name="workerLabelSelector"
            label={t('Worker Label Selector')}
            extra="Only containers with this label will be managed. Example: role=worker"
          >
            <Input />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading} block>
              {t('Save Settings & Reconnect')}
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
