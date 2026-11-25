// SPDX-License-Identifier: Apache-2.0

import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SettingOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useState } from 'react';
import { MAX_SERVER_WEIGHT, MIN_SERVER_WEIGHT, VALID_BALANCE_ALGORITHMS } from '../../shared/constants';
import type {
  HaproxyAclConfig,
  HaproxyBackendConfig,
  HaproxyBackendSwitchingRule,
  HaproxyBindConfig,
  HaproxyFrontendConfig,
  HaproxyHttpRequestRule,
  HaproxyServerConfig,
  HaproxySslCertificate,
  HaproxyTransaction,
} from '../../shared/types';
import { useHaproxyApi, type WriteOptsPayload } from '../api';
import { useHaproxySession } from '../hooks/useHaproxySession';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/format';
import { NodeToolbar } from './NodeToolbar';

export const HaproxyConfigView: React.FC<{ fixedConnectionId?: number }> = ({ fixedConnectionId }) => {
  const t = useT();
  const api = useHaproxyApi();
  const { permissions, connections, selectedConnectionId, setSelectedConnectionId, bootstrapping } =
    useHaproxySession(fixedConnectionId);

  const canEdit = Boolean(permissions?.canConfig);

  const [loading, setLoading] = useState(false);
  const [configVersion, setConfigVersion] = useState<number | null>(null);
  const [openTransactions, setOpenTransactions] = useState<HaproxyTransaction[]>([]);
  const [activeTxId, setActiveTxId] = useState<string>('');
  const [forceReload, setForceReload] = useState<boolean>(false);

  const [frontends, setFrontends] = useState<HaproxyFrontendConfig[]>([]);
  const [backends, setBackends] = useState<HaproxyBackendConfig[]>([]);
  const [sslCerts, setSslCerts] = useState<HaproxySslCertificate[]>([]);

  // Frontend modal
  const [feModalOpen, setFeModalOpen] = useState(false);
  const [editingFe, setEditingFe] = useState<HaproxyFrontendConfig | null>(null);
  const [feForm] = Form.useForm<HaproxyFrontendConfig>();

  // Backend modal
  const [beModalOpen, setBeModalOpen] = useState(false);
  const [editingBe, setEditingBe] = useState<HaproxyBackendConfig | null>(null);
  const [beForm] = Form.useForm<{
    name: string;
    mode: string;
    algorithm: string;
    adv_check?: string;
    httpchkMethod?: string;
    httpchkUri?: string;
    connect_timeout?: number;
    server_timeout?: number;
  }>();

  // Frontend Routing & Binds Drawer
  const [routingFrontend, setRoutingFrontend] = useState<string | null>(null);
  const [binds, setBinds] = useState<HaproxyBindConfig[]>([]);
  const [acls, setAcls] = useState<HaproxyAclConfig[]>([]);
  const [switchingRules, setSwitchingRules] = useState<HaproxyBackendSwitchingRule[]>([]);
  const [httpRules, setHttpRules] = useState<HaproxyHttpRequestRule[]>([]);
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [editingBind, setEditingBind] = useState<HaproxyBindConfig | null>(null);
  const [bindForm] = Form.useForm<HaproxyBindConfig>();

  // Backend Permanent Servers Drawer
  const [serversBackend, setServersBackend] = useState<string | null>(null);
  const [backendServers, setBackendServers] = useState<HaproxyServerConfig[]>([]);
  const [srvModalOpen, setSrvModalOpen] = useState(false);
  const [editingSrv, setEditingSrv] = useState<HaproxyServerConfig | null>(null);
  const [srvForm] = Form.useForm<{
    name: string;
    address: string;
    port?: number;
    weight?: number;
    check: boolean;
    backup: boolean;
    maintenance: boolean;
    ssl: boolean;
    verify: string;
    sni?: string;
    maxconn?: number;
  }>();

  const buildWriteOpts = useCallback(
    (): WriteOptsPayload =>
      activeTxId
        ? { transactionId: activeTxId }
        : {
            forceReload,
          },
    [activeTxId, forceReload],
  );

  const loadConfigOverview = useCallback(async () => {
    if (!selectedConnectionId) return;
    setLoading(true);
    try {
      const txParam = activeTxId || undefined;
      const [verRes, txs, fes, bes, certs] = await Promise.all([
        api.getConfigVersion(selectedConnectionId, txParam).catch(() => ({ version: 0 })),
        api.listTransactions(selectedConnectionId, 'in_progress').catch(() => []),
        api.listFrontends(selectedConnectionId, txParam),
        api.listBackends(selectedConnectionId, txParam),
        api.listSslCertificates(selectedConnectionId).catch(() => []),
      ]);
      setConfigVersion(verRes.version);
      setOpenTransactions(txs);
      if (activeTxId && !txs.some((tx) => tx.id === activeTxId)) {
        setActiveTxId('');
      }
      setFrontends(fes);
      setBackends(bes);
      setSslCerts(certs);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [activeTxId, api, selectedConnectionId]);

  useEffect(() => {
    setActiveTxId('');
    setRoutingFrontend(null);
    setServersBackend(null);
  }, [selectedConnectionId]);

  useEffect(() => {
    loadConfigOverview();
  }, [loadConfigOverview]);

  const loadFrontendRouting = useCallback(
    async (feName: string) => {
      if (!selectedConnectionId) return;
      const txParam = activeTxId || undefined;
      try {
        const [bList, aList, swList, hList] = await Promise.all([
          api.listBinds(selectedConnectionId, feName, txParam),
          api.listFrontendAcls(selectedConnectionId, feName, txParam),
          api.listBackendSwitchingRules(selectedConnectionId, feName, txParam),
          api.listFrontendHttpRequestRules(selectedConnectionId, feName, txParam),
        ]);
        setBinds(bList);
        setAcls(aList);
        setSwitchingRules(swList);
        setHttpRules(hList);
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [activeTxId, api, selectedConnectionId],
  );

  const loadBackendServerList = useCallback(
    async (beName: string) => {
      if (!selectedConnectionId) return;
      try {
        const list = await api.listBackendServers(selectedConnectionId, beName, activeTxId || undefined);
        setBackendServers(list);
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [activeTxId, api, selectedConnectionId],
  );

  // --- Transaction Lifecycle ---

  const handleStartTransaction = useCallback(async () => {
    if (!selectedConnectionId) return;
    try {
      const tx = await api.startTransaction(selectedConnectionId);
      setActiveTxId(tx.id);
      message.success(
        t('Transaction {{id}} started (base version {{version}})', {
          id: tx.id,
          version: tx._version ?? configVersion ?? '?',
        }),
      );
      await loadConfigOverview();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [api, configVersion, loadConfigOverview, selectedConnectionId, t]);

  const handleCommitTransaction = useCallback(async () => {
    if (!selectedConnectionId || !activeTxId) return;
    try {
      const committedId = activeTxId;
      await api.commitTransaction(selectedConnectionId, committedId, forceReload);
      setActiveTxId('');
      message.success(t('Transaction {{id}} committed', { id: committedId }));
      await loadConfigOverview();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [activeTxId, api, forceReload, loadConfigOverview, selectedConnectionId, t]);

  const handleDiscardTransaction = useCallback(async () => {
    if (!selectedConnectionId || !activeTxId) return;
    try {
      const discardedId = activeTxId;
      await api.deleteTransaction(selectedConnectionId, discardedId);
      setActiveTxId('');
      message.success(t('Transaction {{id}} discarded', { id: discardedId }));
      await loadConfigOverview();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [activeTxId, api, loadConfigOverview, selectedConnectionId, t]);

  // --- Frontend CRUD ---

  const handleSaveFrontend = useCallback(async () => {
    if (!selectedConnectionId) return;
    try {
      const values = await feForm.validateFields();
      if (editingFe) {
        await api.updateFrontend(selectedConnectionId, editingFe.name, values, buildWriteOpts());
      } else {
        await api.createFrontend(selectedConnectionId, values, buildWriteOpts());
      }
      message.success(t('Saved successfully'));
      setFeModalOpen(false);
      await loadConfigOverview();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    }
  }, [api, buildWriteOpts, editingFe, feForm, loadConfigOverview, selectedConnectionId, t]);

  const handleDeleteFrontend = useCallback(
    async (name: string) => {
      if (!selectedConnectionId) return;
      try {
        await api.deleteFrontend(selectedConnectionId, name, buildWriteOpts());
        message.success(t('Deleted successfully'));
        await loadConfigOverview();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, buildWriteOpts, loadConfigOverview, selectedConnectionId, t],
  );

  // --- Bind CRUD & Rule Lists ---

  const handleSaveBind = useCallback(async () => {
    if (!selectedConnectionId || !routingFrontend) return;
    try {
      const values = await bindForm.validateFields();
      if (editingBind) {
        await api.updateBind(selectedConnectionId, routingFrontend, editingBind.name, values, buildWriteOpts());
      } else {
        await api.createBind(selectedConnectionId, routingFrontend, values, buildWriteOpts());
      }
      message.success(t('Saved successfully'));
      setBindModalOpen(false);
      await loadFrontendRouting(routingFrontend);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    }
  }, [api, bindForm, buildWriteOpts, editingBind, loadFrontendRouting, routingFrontend, selectedConnectionId, t]);

  const handleDeleteBind = useCallback(
    async (bindName: string) => {
      if (!selectedConnectionId || !routingFrontend) return;
      try {
        await api.deleteBind(selectedConnectionId, routingFrontend, bindName, buildWriteOpts());
        message.success(t('Deleted successfully'));
        await loadFrontendRouting(routingFrontend);
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, buildWriteOpts, loadFrontendRouting, routingFrontend, selectedConnectionId, t],
  );

  const handleSaveAcls = useCallback(async () => {
    if (!selectedConnectionId || !routingFrontend) return;
    try {
      await api.replaceFrontendAcls(selectedConnectionId, routingFrontend, acls, buildWriteOpts());
      message.success(t('Saved successfully'));
      await loadFrontendRouting(routingFrontend);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [acls, api, buildWriteOpts, loadFrontendRouting, routingFrontend, selectedConnectionId, t]);

  const handleSaveSwitchingRules = useCallback(async () => {
    if (!selectedConnectionId || !routingFrontend) return;
    try {
      await api.replaceBackendSwitchingRules(selectedConnectionId, routingFrontend, switchingRules, buildWriteOpts());
      message.success(t('Saved successfully'));
      await loadFrontendRouting(routingFrontend);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [api, buildWriteOpts, loadFrontendRouting, routingFrontend, selectedConnectionId, switchingRules, t]);

  const handleSaveHttpRules = useCallback(async () => {
    if (!selectedConnectionId || !routingFrontend) return;
    try {
      await api.replaceFrontendHttpRequestRules(selectedConnectionId, routingFrontend, httpRules, buildWriteOpts());
      message.success(t('Saved successfully'));
      await loadFrontendRouting(routingFrontend);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [api, buildWriteOpts, httpRules, loadFrontendRouting, routingFrontend, selectedConnectionId, t]);

  // --- Backend & Permanent Servers CRUD ---

  const handleSaveBackend = useCallback(async () => {
    if (!selectedConnectionId) return;
    try {
      const values = await beForm.validateFields();
      const payload: HaproxyBackendConfig = {
        name: values.name,
        mode: values.mode,
        balance: values.algorithm ? { algorithm: values.algorithm } : undefined,
        ...(values.adv_check ? { adv_check: values.adv_check } : {}),
        ...(values.adv_check === 'httpchk' && values.httpchkUri
          ? {
              httpchk_params: {
                method: values.httpchkMethod || 'GET',
                uri: values.httpchkUri,
              },
            }
          : {}),
        ...(values.connect_timeout != null ? { connect_timeout: values.connect_timeout } : {}),
        ...(values.server_timeout != null ? { server_timeout: values.server_timeout } : {}),
      };
      if (editingBe) {
        await api.updateBackend(selectedConnectionId, editingBe.name, payload, buildWriteOpts());
      } else {
        await api.createBackend(selectedConnectionId, payload, buildWriteOpts());
      }
      message.success(t('Saved successfully'));
      setBeModalOpen(false);
      await loadConfigOverview();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    }
  }, [api, beForm, buildWriteOpts, editingBe, loadConfigOverview, selectedConnectionId, t]);

  const handleDeleteBackend = useCallback(
    async (name: string) => {
      if (!selectedConnectionId) return;
      try {
        await api.deleteBackend(selectedConnectionId, name, buildWriteOpts());
        message.success(t('Deleted successfully'));
        await loadConfigOverview();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, buildWriteOpts, loadConfigOverview, selectedConnectionId, t],
  );

  const handleSaveBackendServer = useCallback(async () => {
    if (!selectedConnectionId || !serversBackend) return;
    try {
      const values = await srvForm.validateFields();
      const payload: HaproxyServerConfig = {
        name: values.name,
        address: values.address,
        ...(values.port != null ? { port: values.port } : {}),
        ...(values.weight != null ? { weight: values.weight } : {}),
        check: values.check ? 'enabled' : 'disabled',
        backup: values.backup ? 'enabled' : 'disabled',
        maintenance: values.maintenance ? 'enabled' : 'disabled',
        ssl: values.ssl ? 'enabled' : 'disabled',
        ...(values.ssl && values.verify ? { verify: values.verify } : {}),
        ...(values.ssl && values.sni ? { sni: values.sni } : {}),
        ...(values.maxconn != null ? { maxconn: values.maxconn } : {}),
      };
      if (editingSrv) {
        await api.updateBackendServer(selectedConnectionId, serversBackend, editingSrv.name, payload, buildWriteOpts());
      } else {
        await api.createBackendServer(selectedConnectionId, serversBackend, payload, buildWriteOpts());
      }
      message.success(t('Saved successfully'));
      setSrvModalOpen(false);
      await loadBackendServerList(serversBackend);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    }
  }, [api, buildWriteOpts, editingSrv, loadBackendServerList, selectedConnectionId, serversBackend, srvForm, t]);

  const handleDeleteBackendServer = useCallback(
    async (srvName: string) => {
      if (!selectedConnectionId || !serversBackend) return;
      try {
        await api.deleteBackendServer(selectedConnectionId, serversBackend, srvName, buildWriteOpts());
        message.success(t('Deleted successfully'));
        await loadBackendServerList(serversBackend);
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, buildWriteOpts, loadBackendServerList, selectedConnectionId, serversBackend, t],
  );

  if (!bootstrapping && connections.length === 0) {
    return (
      <Card>
        <Empty description={t('No enabled HAProxy Data Plane connections')} />
      </Card>
    );
  }

  const frontendCols: ColumnsType<HaproxyFrontendConfig> = [
    {
      title: t('Frontend'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: t('Mode'),
      dataIndex: 'mode',
      key: 'mode',
      render: (m?: string) => (m ? <Tag>{m.toUpperCase()}</Tag> : '—'),
    },
    {
      title: t('Default Backend'),
      dataIndex: 'default_backend',
      key: 'default_backend',
      render: (b?: string) => (b ? <Tag color="blue">{b}</Tag> : '—'),
    },
    {
      title: t('Max Connections'),
      dataIndex: 'maxconn',
      key: 'maxconn',
      render: (v?: number | null) => v ?? '—',
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_v: unknown, row: HaproxyFrontendConfig) => (
        <Space size={6} wrap>
          <Button
            htmlType="button"
            size="small"
            icon={<SwapOutlined aria-hidden="true" />}
            aria-label={`${t('Manage Routing & Binds')} ${row.name}`}
            onClick={() => {
              setRoutingFrontend(row.name);
              loadFrontendRouting(row.name);
            }}
          >
            {t('Manage Routing & Binds')}
          </Button>
          {canEdit && (
            <>
              <Button
                htmlType="button"
                size="small"
                icon={<EditOutlined aria-hidden="true" />}
                aria-label={`${t('Edit')} ${row.name}`}
                onClick={() => {
                  setEditingFe(row);
                  feForm.setFieldsValue(row);
                  setFeModalOpen(true);
                }}
              >
                {t('Edit')}
              </Button>
              <Popconfirm
                title={t('Delete frontend {{name}}?', { name: row.name })}
                onConfirm={() => handleDeleteFrontend(row.name)}
              >
                <Button
                  htmlType="button"
                  size="small"
                  danger
                  icon={<DeleteOutlined aria-hidden="true" />}
                  aria-label={`${t('Delete')} ${row.name}`}
                >
                  {t('Delete')}
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  const backendCols: ColumnsType<HaproxyBackendConfig> = [
    {
      title: t('Backend'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: t('Mode'),
      dataIndex: 'mode',
      key: 'mode',
      render: (m?: string) => (m ? <Tag>{m.toUpperCase()}</Tag> : '—'),
    },
    {
      title: t('Algorithm'),
      key: 'algo',
      render: (_v: unknown, row: HaproxyBackendConfig) =>
        row.balance?.algorithm ? <Tag color="geekblue">{row.balance.algorithm}</Tag> : '—',
    },
    {
      title: t('Health Check'),
      key: 'check',
      render: (_v: unknown, row: HaproxyBackendConfig) => {
        if (!row.adv_check) return '—';
        const uri = row.httpchk_params?.uri ? ` ${row.httpchk_params.method ?? 'GET'} ${row.httpchk_params.uri}` : '';
        return `${row.adv_check}${uri}`;
      },
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_v: unknown, row: HaproxyBackendConfig) => (
        <Space size={6} wrap>
          <Button
            htmlType="button"
            size="small"
            icon={<SettingOutlined aria-hidden="true" />}
            aria-label={`${t('Manage Servers')} ${row.name}`}
            onClick={() => {
              setServersBackend(row.name);
              loadBackendServerList(row.name);
            }}
          >
            {t('Manage Servers')}
          </Button>
          {canEdit && (
            <>
              <Button
                htmlType="button"
                size="small"
                icon={<EditOutlined aria-hidden="true" />}
                aria-label={`${t('Edit')} ${row.name}`}
                onClick={() => {
                  setEditingBe(row);
                  beForm.setFieldsValue({
                    name: row.name,
                    mode: row.mode ?? 'http',
                    algorithm: row.balance?.algorithm ?? 'roundrobin',
                    adv_check: row.adv_check ?? '',
                    httpchkMethod: row.httpchk_params?.method ?? 'GET',
                    httpchkUri: row.httpchk_params?.uri ?? '',
                    connect_timeout: row.connect_timeout ?? undefined,
                    server_timeout: row.server_timeout ?? undefined,
                  });
                  setBeModalOpen(true);
                }}
              >
                {t('Edit')}
              </Button>
              <Popconfirm
                title={t('Delete backend {{name}}?', { name: row.name })}
                onConfirm={() => handleDeleteBackend(row.name)}
              >
                <Button
                  htmlType="button"
                  size="small"
                  danger
                  icon={<DeleteOutlined aria-hidden="true" />}
                  aria-label={`${t('Delete')} ${row.name}`}
                >
                  {t('Delete')}
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <NodeToolbar
        connections={connections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        fixedConnectionId={fixedConnectionId}
        loading={loading}
        onRefresh={loadConfigOverview}
        extraRight={
          configVersion != null ? (
            <Tag color="geekblue">
              {t('Config Version')}: v{configVersion}
            </Tag>
          ) : null
        }
      />

      {canEdit && (
        <Card size="small">
          <Row gutter={[12, 12]} align="middle" justify="space-between">
            <Col>
              <Space wrap>
                <Typography.Text strong>{t('Active Transaction')}:</Typography.Text>
                <Select
                  style={{ minWidth: 280 }}
                  aria-label={t('Active Transaction')}
                  value={activeTxId}
                  onChange={setActiveTxId}
                  options={[
                    { value: '', label: t('Direct Apply (auto-version + reload)') },
                    ...openTransactions.map((tx) => ({
                      value: tx.id,
                      label: `${t('Stage in Transaction')}: ${tx.id.slice(0, 12)}... (v${tx._version ?? '?'})`,
                    })),
                  ]}
                />
                {!activeTxId && (
                  <Button htmlType="button" icon={<PlusOutlined aria-hidden="true" />} onClick={handleStartTransaction}>
                    {t('Start Transaction')}
                  </Button>
                )}
                {activeTxId && (
                  <>
                    <Button
                      htmlType="button"
                      type="primary"
                      icon={<CheckOutlined aria-hidden="true" />}
                      onClick={handleCommitTransaction}
                    >
                      {t('Commit Transaction')}
                    </Button>
                    <Popconfirm title={t('Discard this transaction?')} onConfirm={handleDiscardTransaction}>
                      <Button htmlType="button" danger icon={<CloseOutlined aria-hidden="true" />}>
                        {t('Discard Transaction')}
                      </Button>
                    </Popconfirm>
                  </>
                )}
              </Space>
            </Col>
            <Col>
              <Space>
                <Switch
                  checked={forceReload}
                  onChange={setForceReload}
                  aria-label={t('Force immediate reload (skip reload-delay)')}
                />
                <Typography.Text>{t('Force immediate reload (skip reload-delay)')}</Typography.Text>
              </Space>
            </Col>
          </Row>
        </Card>
      )}

      <Card size="small">
        <Tabs
          items={[
            {
              key: 'frontends',
              label: `${t('Frontends')} (${frontends.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {canEdit && (
                    <Button
                      htmlType="button"
                      type="primary"
                      icon={<PlusOutlined aria-hidden="true" />}
                      onClick={() => {
                        setEditingFe(null);
                        feForm.resetFields();
                        feForm.setFieldsValue({ mode: 'http', httplog: true });
                        setFeModalOpen(true);
                      }}
                    >
                      {t('Add Frontend')}
                    </Button>
                  )}
                  <Table<HaproxyFrontendConfig>
                    rowKey="name"
                    size="small"
                    loading={loading}
                    columns={frontendCols}
                    dataSource={frontends}
                    pagination={{ pageSize: 20, hideOnSinglePage: true }}
                  />
                </Space>
              ),
            },
            {
              key: 'backends',
              label: `${t('Backends')} (${backends.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {canEdit && (
                    <Button
                      htmlType="button"
                      type="primary"
                      icon={<PlusOutlined aria-hidden="true" />}
                      onClick={() => {
                        setEditingBe(null);
                        beForm.resetFields();
                        beForm.setFieldsValue({ mode: 'http', algorithm: 'roundrobin', httpchkMethod: 'GET' });
                        setBeModalOpen(true);
                      }}
                    >
                      {t('Add Backend')}
                    </Button>
                  )}
                  <Table<HaproxyBackendConfig>
                    rowKey="name"
                    size="small"
                    loading={loading}
                    columns={backendCols}
                    dataSource={backends}
                    pagination={{ pageSize: 20, hideOnSinglePage: true }}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* Frontend Modal */}
      <Modal
        open={feModalOpen}
        title={editingFe ? `${t('Edit Frontend')}: ${editingFe.name}` : t('Add Frontend')}
        okText={t('Save')}
        cancelText={t('Cancel')}
        onOk={handleSaveFrontend}
        onCancel={() => setFeModalOpen(false)}
        destroyOnClose
      >
        <Form form={feForm} layout="vertical">
          <Form.Item name="name" label={t('Frontend')} rules={[{ required: true }]}>
            <Input disabled={Boolean(editingFe)} autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Form.Item name="mode" label={t('Mode')}>
            <Radio.Group
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'tcp', label: 'TCP' },
              ]}
            />
          </Form.Item>
          <Form.Item name="default_backend" label={t('Default Backend')}>
            <Select allowClear options={backends.map((b) => ({ value: b.name, label: b.name }))} />
          </Form.Item>
          <Form.Item name="maxconn" label={t('Max Connections')}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="httplog" label={t('HTTP Log')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="tcplog" label={t('TCP Log')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* Backend Modal */}
      <Modal
        open={beModalOpen}
        title={editingBe ? `${t('Edit Backend')}: ${editingBe.name}` : t('Add Backend')}
        okText={t('Save')}
        cancelText={t('Cancel')}
        onOk={handleSaveBackend}
        onCancel={() => setBeModalOpen(false)}
        destroyOnClose
      >
        <Form form={beForm} layout="vertical">
          <Form.Item name="name" label={t('Backend')} rules={[{ required: true }]}>
            <Input disabled={Boolean(editingBe)} autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Form.Item name="mode" label={t('Mode')}>
            <Radio.Group
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'tcp', label: 'TCP' },
              ]}
            />
          </Form.Item>
          <Form.Item name="algorithm" label={t('Algorithm')}>
            <Select options={VALID_BALANCE_ALGORITHMS.map((alg) => ({ value: alg, label: alg }))} />
          </Form.Item>
          <Form.Item name="adv_check" label={t('Health Check')}>
            <Select
              allowClear
              options={[
                { value: 'httpchk', label: 'httpchk' },
                { value: 'tcp-check', label: 'tcp-check' },
                { value: 'ssl-hello-chk', label: 'ssl-hello-chk' },
              ]}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="httpchkMethod" label={t('Check Method')}>
                <Select options={['GET', 'HEAD', 'OPTIONS', 'POST'].map((m) => ({ value: m, label: m }))} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="httpchkUri" label={t('Check URI')}>
                <Input placeholder="/healthz" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="connect_timeout" label={t('Connect Timeout (ms)')}>
                <InputNumber min={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="server_timeout" label={t('Server Timeout (ms)')}>
                <InputNumber min={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* Frontend Routing & Binds Drawer */}
      <Drawer
        open={Boolean(routingFrontend)}
        title={routingFrontend ? `${t('Manage Routing & Binds')}: ${routingFrontend}` : ''}
        width={820}
        onClose={() => setRoutingFrontend(null)}
        destroyOnClose
      >
        <Tabs
          items={[
            {
              key: 'binds',
              label: `${t('Binds (Listeners)')} (${binds.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {canEdit && (
                    <Button
                      htmlType="button"
                      type="primary"
                      size="small"
                      icon={<PlusOutlined aria-hidden="true" />}
                      onClick={() => {
                        setEditingBind(null);
                        bindForm.resetFields();
                        bindForm.setFieldsValue({ address: '0.0.0.0', port: 80, ssl: false });
                        setBindModalOpen(true);
                      }}
                    >
                      {t('Add Bind')}
                    </Button>
                  )}
                  <Table<HaproxyBindConfig>
                    rowKey="name"
                    size="small"
                    dataSource={binds}
                    pagination={false}
                    columns={[
                      { title: t('Name'), dataIndex: 'name', key: 'name' },
                      {
                        title: t('Address'),
                        key: 'addr',
                        render: (_v: unknown, r: HaproxyBindConfig) => `${r.address ?? '*'}:${r.port ?? ''}`,
                      },
                      {
                        title: 'SSL',
                        key: 'ssl',
                        render: (_v: unknown, r: HaproxyBindConfig) =>
                          r.ssl ? <Tag color="green">{r.ssl_certificate || 'SSL'}</Tag> : '—',
                      },
                      ...(canEdit
                        ? [
                            {
                              title: t('Actions'),
                              key: 'actions',
                              render: (_v: unknown, r: HaproxyBindConfig) => (
                                <Space size={4}>
                                  <Button
                                    htmlType="button"
                                    size="small"
                                    aria-label={`${t('Edit')} ${r.name}`}
                                    onClick={() => {
                                      setEditingBind(r);
                                      bindForm.setFieldsValue(r);
                                      setBindModalOpen(true);
                                    }}
                                  >
                                    {t('Edit')}
                                  </Button>
                                  <Button
                                    htmlType="button"
                                    size="small"
                                    danger
                                    aria-label={`${t('Delete')} ${r.name}`}
                                    onClick={() => handleDeleteBind(r.name)}
                                  >
                                    {t('Delete')}
                                  </Button>
                                </Space>
                              ),
                            },
                          ]
                        : []),
                    ]}
                  />
                </Space>
              ),
            },
            {
              key: 'acls',
              label: `${t('ACL Definitions')} (${acls.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {acls.map((item, idx) => (
                    <Row key={idx} gutter={8} align="middle">
                      <Col span={6}>
                        <Input
                          placeholder={t('ACL Name')}
                          aria-label={`${t('ACL Name')} ${idx + 1}`}
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          disabled={!canEdit}
                          value={item.acl_name}
                          onChange={(e) => {
                            const next = [...acls];
                            next[idx] = { ...item, acl_name: e.target.value };
                            setAcls(next);
                          }}
                        />
                      </Col>
                      <Col span={7}>
                        <Input
                          placeholder={t('Criterion (e.g. hdr(host), path_beg)')}
                          aria-label={`${t('Criterion (e.g. hdr(host), path_beg)')} ${idx + 1}`}
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          disabled={!canEdit}
                          value={item.criterion}
                          onChange={(e) => {
                            const next = [...acls];
                            next[idx] = { ...item, criterion: e.target.value };
                            setAcls(next);
                          }}
                        />
                      </Col>
                      <Col span={9}>
                        <Input
                          placeholder={t('Match Value (e.g. -i app.example.com)')}
                          aria-label={`${t('Match Value (e.g. -i app.example.com)')} ${idx + 1}`}
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          disabled={!canEdit}
                          value={item.value ?? ''}
                          onChange={(e) => {
                            const next = [...acls];
                            next[idx] = { ...item, value: e.target.value };
                            setAcls(next);
                          }}
                        />
                      </Col>
                      {canEdit && (
                        <Col span={2}>
                          <Button
                            htmlType="button"
                            danger
                            size="small"
                            icon={<DeleteOutlined aria-hidden="true" />}
                            aria-label={`${t('Delete')} ACL ${idx + 1}`}
                            onClick={() => setAcls(acls.filter((_, i) => i !== idx))}
                          />
                        </Col>
                      )}
                    </Row>
                  ))}
                  {canEdit && (
                    <Space>
                      <Button
                        htmlType="button"
                        icon={<PlusOutlined aria-hidden="true" />}
                        onClick={() => setAcls([...acls, { acl_name: '', criterion: 'hdr(host)', value: '' }])}
                      >
                        {t('Add ACL')}
                      </Button>
                      <Button htmlType="button" type="primary" onClick={handleSaveAcls}>
                        {t('Save ACLs')}
                      </Button>
                    </Space>
                  )}
                </Space>
              ),
            },
            {
              key: 'switching',
              label: `${t('Backend Switching Rules (use_backend)')} (${switchingRules.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {switchingRules.map((rule, idx) => (
                    <Row key={idx} gutter={8} align="middle">
                      <Col span={8}>
                        <Select
                          style={{ width: '100%' }}
                          placeholder={t('Target Backend')}
                          aria-label={`${t('Target Backend')} ${idx + 1}`}
                          disabled={!canEdit}
                          value={rule.name || undefined}
                          onChange={(val: string) => {
                            const next = [...switchingRules];
                            next[idx] = { ...rule, name: val };
                            setSwitchingRules(next);
                          }}
                          options={backends.map((b) => ({ value: b.name, label: b.name }))}
                        />
                      </Col>
                      <Col span={4}>
                        <Select
                          style={{ width: '100%' }}
                          aria-label={`${t('Condition')} ${idx + 1}`}
                          disabled={!canEdit}
                          value={rule.cond || 'if'}
                          onChange={(val: string) => {
                            const next = [...switchingRules];
                            next[idx] = { ...rule, cond: val };
                            setSwitchingRules(next);
                          }}
                          options={[
                            { value: 'if', label: 'if' },
                            { value: 'unless', label: 'unless' },
                          ]}
                        />
                      </Col>
                      <Col span={10}>
                        <Input
                          placeholder={t('Condition Expression (ACL names)')}
                          aria-label={`${t('Condition Expression (ACL names)')} ${idx + 1}`}
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          disabled={!canEdit}
                          value={rule.cond_test ?? ''}
                          onChange={(e) => {
                            const next = [...switchingRules];
                            next[idx] = { ...rule, cond_test: e.target.value };
                            setSwitchingRules(next);
                          }}
                        />
                      </Col>
                      {canEdit && (
                        <Col span={2}>
                          <Button
                            htmlType="button"
                            danger
                            size="small"
                            icon={<DeleteOutlined aria-hidden="true" />}
                            aria-label={`${t('Delete')} rule ${idx + 1}`}
                            onClick={() => setSwitchingRules(switchingRules.filter((_, i) => i !== idx))}
                          />
                        </Col>
                      )}
                    </Row>
                  ))}
                  {canEdit && (
                    <Space>
                      <Button
                        htmlType="button"
                        icon={<PlusOutlined aria-hidden="true" />}
                        onClick={() =>
                          setSwitchingRules([
                            ...switchingRules,
                            { name: backends[0]?.name ?? '', cond: 'if', cond_test: '' },
                          ])
                        }
                      >
                        {t('Add Switching Rule')}
                      </Button>
                      <Button htmlType="button" type="primary" onClick={handleSaveSwitchingRules}>
                        {t('Save Switching Rules')}
                      </Button>
                    </Space>
                  )}
                </Space>
              ),
            },
            {
              key: 'httpRules',
              label: `${t('HTTP Request Rules')} (${httpRules.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {httpRules.map((rule, idx) => (
                    <Card key={idx} size="small">
                      <Row gutter={[8, 8]} align="middle">
                        <Col span={6}>
                          <Select
                            style={{ width: '100%' }}
                            aria-label={`${t('Rule Action')} ${idx + 1}`}
                            disabled={!canEdit}
                            value={rule.type}
                            onChange={(val: string) => {
                              const next = [...httpRules];
                              next[idx] = { type: val, cond: rule.cond, cond_test: rule.cond_test };
                              setHttpRules(next);
                            }}
                            options={[
                              { value: 'set-header', label: 'set-header' },
                              { value: 'add-header', label: 'add-header' },
                              { value: 'del-header', label: 'del-header' },
                              { value: 'redirect', label: 'redirect' },
                              { value: 'deny', label: 'deny' },
                              { value: 'allow', label: 'allow' },
                            ]}
                          />
                        </Col>
                        {(rule.type === 'set-header' || rule.type === 'add-header' || rule.type === 'del-header') && (
                          <>
                            <Col span={6}>
                              <Input
                                placeholder={t('Header Name')}
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                disabled={!canEdit}
                                value={rule.hdr_name ?? ''}
                                onChange={(e) => {
                                  const next = [...httpRules];
                                  next[idx] = { ...rule, hdr_name: e.target.value };
                                  setHttpRules(next);
                                }}
                              />
                            </Col>
                            {rule.type !== 'del-header' && (
                              <Col span={6}>
                                <Input
                                  placeholder={t('Header Format / Value')}
                                  autoCorrect="off"
                                  autoCapitalize="none"
                                  spellCheck={false}
                                  disabled={!canEdit}
                                  value={rule.hdr_format ?? ''}
                                  onChange={(e) => {
                                    const next = [...httpRules];
                                    next[idx] = { ...rule, hdr_format: e.target.value };
                                    setHttpRules(next);
                                  }}
                                />
                              </Col>
                            )}
                          </>
                        )}
                        {rule.type === 'redirect' && (
                          <>
                            <Col span={5}>
                              <Select
                                style={{ width: '100%' }}
                                disabled={!canEdit}
                                value={rule.redir_type || 'scheme'}
                                onChange={(val: string) => {
                                  const next = [...httpRules];
                                  next[idx] = { ...rule, redir_type: val };
                                  setHttpRules(next);
                                }}
                                options={[
                                  { value: 'scheme', label: 'scheme' },
                                  { value: 'location', label: 'location' },
                                  { value: 'prefix', label: 'prefix' },
                                ]}
                              />
                            </Col>
                            <Col span={7}>
                              <Input
                                placeholder={t('Redirect Target')}
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                disabled={!canEdit}
                                value={rule.redir_value ?? ''}
                                onChange={(e) => {
                                  const next = [...httpRules];
                                  next[idx] = { ...rule, redir_value: e.target.value };
                                  setHttpRules(next);
                                }}
                              />
                            </Col>
                          </>
                        )}
                        <Col span={4}>
                          <Select
                            allowClear
                            placeholder={t('Condition')}
                            style={{ width: '100%' }}
                            disabled={!canEdit}
                            value={rule.cond || undefined}
                            onChange={(val?: string) => {
                              const next = [...httpRules];
                              next[idx] = { ...rule, cond: val };
                              setHttpRules(next);
                            }}
                            options={[
                              { value: 'if', label: 'if' },
                              { value: 'unless', label: 'unless' },
                            ]}
                          />
                        </Col>
                        <Col span={6}>
                          <Input
                            placeholder={t('Condition Expression (ACL names)')}
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            disabled={!canEdit}
                            value={rule.cond_test ?? ''}
                            onChange={(e) => {
                              const next = [...httpRules];
                              next[idx] = { ...rule, cond_test: e.target.value };
                              setHttpRules(next);
                            }}
                          />
                        </Col>
                        {canEdit && (
                          <Col span={2}>
                            <Button
                              htmlType="button"
                              danger
                              size="small"
                              icon={<DeleteOutlined aria-hidden="true" />}
                              aria-label={`${t('Delete')} HTTP rule ${idx + 1}`}
                              onClick={() => setHttpRules(httpRules.filter((_, i) => i !== idx))}
                            />
                          </Col>
                        )}
                      </Row>
                    </Card>
                  ))}
                  {canEdit && (
                    <Space>
                      <Button
                        htmlType="button"
                        icon={<PlusOutlined aria-hidden="true" />}
                        onClick={() =>
                          setHttpRules([
                            ...httpRules,
                            { type: 'set-header', hdr_name: 'X-Forwarded-Proto', hdr_format: 'https' },
                          ])
                        }
                      >
                        {t('Add HTTP Rule')}
                      </Button>
                      <Button htmlType="button" type="primary" onClick={handleSaveHttpRules}>
                        {t('Save HTTP Rules')}
                      </Button>
                    </Space>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Drawer>

      {/* Bind Modal */}
      <Modal
        open={bindModalOpen}
        title={editingBind ? `${t('Edit Bind')}: ${editingBind.name}` : t('Add Bind')}
        okText={t('Save')}
        cancelText={t('Cancel')}
        onOk={handleSaveBind}
        onCancel={() => setBindModalOpen(false)}
        destroyOnClose
      >
        <Form form={bindForm} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input disabled={Boolean(editingBind)} autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item name="address" label={t('Address')}>
                <Input placeholder="0.0.0.0" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="port" label={t('Port')} rules={[{ required: true }]}>
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="ssl" label={t('SSL Termination')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="ssl_certificate" label={t('SSL Certificate Path / Storage Name')}>
            {sslCerts.length > 0 ? (
              <Select
                allowClear
                showSearch
                options={sslCerts.map((c) => ({
                  value: c.file || c.storage_name,
                  label: `${c.storage_name}${c.domains ? ` (${c.domains})` : ''}`,
                }))}
              />
            ) : (
              <Input
                placeholder="/etc/haproxy/certs/site.pem"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            )}
          </Form.Item>
          <Form.Item name="alpn" label={t('ALPN (e.g. h2,http/1.1)')}>
            <Input placeholder="h2,http/1.1" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Form.Item name="accept_proxy" label={t('ACCEPT PROXY Protocol')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* Backend Permanent Servers Drawer */}
      <Drawer
        open={Boolean(serversBackend)}
        title={serversBackend ? `${t('Configured Servers')}: ${serversBackend}` : ''}
        width={760}
        onClose={() => setServersBackend(null)}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {!canEdit && <Alert type="info" showIcon message={t('Structured Configuration & Transactions')} />}
          {canEdit && (
            <Button
              htmlType="button"
              type="primary"
              size="small"
              icon={<PlusOutlined aria-hidden="true" />}
              onClick={() => {
                setEditingSrv(null);
                srvForm.resetFields();
                srvForm.setFieldsValue({
                  weight: 100,
                  check: true,
                  backup: false,
                  maintenance: false,
                  ssl: false,
                  verify: 'none',
                });
                setSrvModalOpen(true);
              }}
            >
              {t('Add Server')}
            </Button>
          )}
          <Table<HaproxyServerConfig>
            rowKey="name"
            size="small"
            dataSource={backendServers}
            pagination={false}
            columns={[
              { title: t('Server'), dataIndex: 'name', key: 'name' },
              {
                title: t('Address'),
                key: 'addr',
                render: (_v: unknown, r: HaproxyServerConfig) => `${r.address}${r.port ? `:${r.port}` : ''}`,
              },
              { title: t('Weight'), dataIndex: 'weight', key: 'weight' },
              {
                title: t('Health Check'),
                dataIndex: 'check',
                key: 'check',
                render: (c?: string) => <Tag color={c === 'enabled' ? 'green' : 'default'}>{c ?? 'disabled'}</Tag>,
              },
              ...(canEdit
                ? [
                    {
                      title: t('Actions'),
                      key: 'actions',
                      render: (_v: unknown, r: HaproxyServerConfig) => (
                        <Space size={4}>
                          <Button
                            htmlType="button"
                            size="small"
                            aria-label={`${t('Edit')} ${r.name}`}
                            onClick={() => {
                              setEditingSrv(r);
                              srvForm.setFieldsValue({
                                name: r.name,
                                address: r.address,
                                port: r.port ?? undefined,
                                weight: r.weight ?? 100,
                                check: r.check === 'enabled',
                                backup: r.backup === 'enabled',
                                maintenance: r.maintenance === 'enabled',
                                ssl: r.ssl === 'enabled',
                                verify: r.verify ?? 'none',
                                sni: r.sni,
                                maxconn: r.maxconn ?? undefined,
                              });
                              setSrvModalOpen(true);
                            }}
                          >
                            {t('Edit')}
                          </Button>
                          <Popconfirm
                            title={t('Delete server {{name}}?', { name: r.name })}
                            onConfirm={() => handleDeleteBackendServer(r.name)}
                          >
                            <Button htmlType="button" size="small" danger aria-label={`${t('Delete')} ${r.name}`}>
                              {t('Delete')}
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Space>
      </Drawer>

      {/* Permanent Backend Server Modal */}
      <Modal
        open={srvModalOpen}
        title={editingSrv ? `${t('Edit Server')}: ${editingSrv.name}` : t('Add Server')}
        okText={t('Save')}
        cancelText={t('Cancel')}
        onOk={handleSaveBackendServer}
        onCancel={() => setSrvModalOpen(false)}
        destroyOnClose
      >
        <Form form={srvForm} layout="vertical">
          <Form.Item name="name" label={t('Server')} rules={[{ required: true }]}>
            <Input disabled={Boolean(editingSrv)} autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item name="address" label={t('Address')} rules={[{ required: true }]}>
                <Input placeholder="10.0.1.15" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="port" label={t('Port')}>
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="weight" label={t('Weight (0 - 256)')}>
                <InputNumber min={MIN_SERVER_WEIGHT} max={MAX_SERVER_WEIGHT} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="maxconn" label={t('Max Connections')}>
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="check" label={t('Enable Health Check')} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="backup" label={t('Backup Server')} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="maintenance" label={t('Maintenance Mode')} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="ssl" label={t('Backend TLS (SSL)')} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="verify" label={t('Verify Backend Certificate')}>
                <Radio.Group
                  options={[
                    { value: 'none', label: 'none' },
                    { value: 'required', label: 'required' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="sni" label={t('SNI')}>
                <Input autoCorrect="off" autoCapitalize="none" spellCheck={false} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Space>
  );
};

export default HaproxyConfigView;
