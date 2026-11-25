// SPDX-License-Identifier: Apache-2.0

import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
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
  Tag,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { VALID_BALANCE_ALGORITHMS } from '../../shared/constants';
import type {
  HaproxyFrontendConfig,
  HaproxyProxyMode,
  HaproxyReverseProxyRoute,
  HaproxySslCertificate,
  ReverseProxyNodeError,
  ReverseProxyRouteKind,
  UpsertReverseProxyTargetInput,
} from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useHaproxySession } from '../hooks/useHaproxySession';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/format';

interface ReverseProxyFormValues {
  connectionId: number;
  kind: ReverseProxyRouteKind;
  proxySlug?: string;
  mode: HaproxyProxyMode;
  listenAddress: string;
  inboundPort?: number;
  inboundSsl: boolean;
  sslCertificate?: string;
  sharedFrontendName?: string;
  hostMatch?: string;
  pathBegMatch?: string;
  balanceAlgorithm: string;
  targets: Array<{
    name?: string;
    address: string;
    port: number;
    weight?: number;
    ssl?: boolean;
    check?: boolean;
    backup?: boolean;
  }>;
  httpCheckEnabled: boolean;
  httpCheckMethod: string;
  httpCheckUri: string;
  connectTimeoutMs?: number;
  serverTimeoutMs?: number;
  enabled: boolean;
}

type HealthFilterValue = '__all__' | 'healthy' | 'degraded_or_down' | 'disabled';

function renderTargetLiveTag(status: string | null, maintenance: boolean) {
  if (maintenance) {
    return <Tag>MAINT</Tag>;
  }
  const upper = (status ?? '').toUpperCase();
  if (upper.startsWith('UP')) {
    return <Tag color="success">{status}</Tag>;
  }
  if (upper.startsWith('DOWN')) {
    return <Tag color="error">{status}</Tag>;
  }
  if (upper.startsWith('DRAIN') || upper.startsWith('MAINT')) {
    return <Tag color="warning">{status}</Tag>;
  }
  return status ? <Tag>{status}</Tag> : null;
}

export const HaproxyReverseProxyView: React.FC<{ fixedConnectionId?: number }> = ({ fixedConnectionId }) => {
  const t = useT();
  const api = useHaproxyApi();
  const { permissions, connections, selectedConnectionId, bootstrapping } = useHaproxySession(fixedConnectionId);

  const canEdit = Boolean(permissions?.canConfig);

  const [loading, setLoading] = useState(false);
  const [routes, setRoutes] = useState<HaproxyReverseProxyRoute[]>([]);
  const [nodeErrors, setNodeErrors] = useState<ReverseProxyNodeError[]>([]);

  // --- Filters ---
  const [nodeFilter, setNodeFilter] = useState<number | '__all__'>(fixedConnectionId ?? '__all__');
  const [inboundFilter, setInboundFilter] = useState('');
  const [outboundFilter, setOutboundFilter] = useState('');
  const [healthFilter, setHealthFilter] = useState<HealthFilterValue>('__all__');

  // --- Create / Edit Modal ---
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingRoute, setEditingRoute] = useState<HaproxyReverseProxyRoute | null>(null);
  const [modalFrontends, setModalFrontends] = useState<HaproxyFrontendConfig[]>([]);
  const [modalSslCerts, setModalSslCerts] = useState<HaproxySslCertificate[]>([]);
  const [form] = Form.useForm<ReverseProxyFormValues>();

  const watchedConnId = Form.useWatch('connectionId', form);
  const watchedKind = Form.useWatch('kind', form);
  const watchedMode = Form.useWatch('mode', form);
  const watchedInboundSsl = Form.useWatch('inboundSsl', form);
  const watchedHttpCheck = Form.useWatch('httpCheckEnabled', form);

  useEffect(() => {
    if (fixedConnectionId) {
      setNodeFilter(fixedConnectionId);
    }
  }, [fixedConnectionId]);

  const loadRoutes = useCallback(async () => {
    if (connections.length === 0) return;
    setLoading(true);
    try {
      const res = await api.listReverseProxies(fixedConnectionId);
      setRoutes(res.routes);
      setNodeErrors(res.nodeErrors);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, connections.length, fixedConnectionId]);

  useEffect(() => {
    loadRoutes();
  }, [loadRoutes]);

  useEffect(() => {
    if (!modalOpen || !watchedConnId) return;
    let active = true;
    async function loadNodeOptions() {
      try {
        const [fes, certs] = await Promise.all([
          api.listFrontends(watchedConnId).catch(() => [] as HaproxyFrontendConfig[]),
          api.listSslCertificates(watchedConnId).catch(() => [] as HaproxySslCertificate[]),
        ]);
        if (!active) return;
        setModalFrontends(fes);
        setModalSslCerts(certs);
      } catch {
        // Ignore transient option fetch errors; form still functions.
      }
    }
    loadNodeOptions();
    return () => {
      active = false;
    };
  }, [api, modalOpen, watchedConnId]);

  const nodeAddressByConnId = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of routes) {
      if (r.nodeAddress && r.nodeAddress !== '—') {
        map.set(r.connectionId, r.nodeAddress);
      }
    }
    for (const ne of nodeErrors) {
      if (ne.nodeAddress && ne.nodeAddress !== '—') {
        map.set(ne.connectionId, ne.nodeAddress);
      }
    }
    return map;
  }, [nodeErrors, routes]);

  const filteredRoutes = useMemo(() => {
    const inQuery = inboundFilter.trim().toLowerCase();
    const outQuery = outboundFilter.trim().toLowerCase();

    return routes.filter((row) => {
      if (nodeFilter !== '__all__' && row.connectionId !== nodeFilter) {
        return false;
      }
      if (healthFilter === 'healthy' && row.healthState !== 'healthy') {
        return false;
      }
      if (
        healthFilter === 'degraded_or_down' &&
        row.healthState !== 'degraded' &&
        row.healthState !== 'down' &&
        row.healthState !== 'no_servers'
      ) {
        return false;
      }
      if (healthFilter === 'disabled' && row.healthState !== 'disabled') {
        return false;
      }
      if (inQuery) {
        const bindTokens = row.binds.map((b) => `${b.address}:${b.port ?? ''} ${b.port ?? ''}`).join(' ');
        const aclTokens = [
          row.frontendName,
          row.mode,
          row.hostMatch ?? '',
          row.pathBegMatch ?? '',
          row.ruleCondTest ?? '',
          ...row.matchedAcls.map((a) => `${a.criterion} ${a.value ?? ''}`),
        ].join(' ');
        if (!`${bindTokens} ${aclTokens}`.toLowerCase().includes(inQuery)) {
          return false;
        }
      }
      if (outQuery) {
        const targetTokens = row.targets
          .map((tItem) => `${tItem.name} ${tItem.address}:${tItem.port ?? ''} ${tItem.address} ${tItem.port ?? ''}`)
          .join(' ');
        if (!`${row.backendName} ${targetTokens}`.toLowerCase().includes(outQuery)) {
          return false;
        }
      }
      return true;
    });
  }, [healthFilter, inboundFilter, nodeFilter, outboundFilter, routes]);

  const summaryCounts = useMemo(() => {
    let healthy = 0;
    let degradedOrDown = 0;
    let disabled = 0;
    for (const r of filteredRoutes) {
      if (r.healthState === 'healthy') healthy += 1;
      else if (r.healthState === 'degraded' || r.healthState === 'down' || r.healthState === 'no_servers') {
        degradedOrDown += 1;
      } else if (r.healthState === 'disabled') {
        disabled += 1;
      }
    }
    return { total: filteredRoutes.length, healthy, degradedOrDown, disabled };
  }, [filteredRoutes]);

  const openCreateModal = useCallback(() => {
    const defaultConn =
      (nodeFilter !== '__all__' ? nodeFilter : null) ?? selectedConnectionId ?? connections[0]?.id ?? 0;
    setEditingRoute(null);
    form.resetFields();
    form.setFieldsValue({
      connectionId: defaultConn,
      kind: 'dedicated_port',
      proxySlug: '',
      mode: 'http',
      listenAddress: '0.0.0.0',
      inboundPort: 8080,
      inboundSsl: false,
      balanceAlgorithm: 'roundrobin',
      targets: [{ name: 'srv_1', address: '', port: 80, weight: 100, check: true, ssl: false, backup: false }],
      httpCheckEnabled: false,
      httpCheckMethod: 'GET',
      httpCheckUri: '/',
      connectTimeoutMs: 5000,
      serverTimeoutMs: 30000,
      enabled: true,
    });
    setModalOpen(true);
  }, [connections, form, nodeFilter, selectedConnectionId]);

  const openEditModal = useCallback(
    (row: HaproxyReverseProxyRoute) => {
      setEditingRoute(row);
      form.resetFields();
      const firstBind = row.binds[0];
      form.setFieldsValue({
        connectionId: row.connectionId,
        kind: row.kind,
        proxySlug: row.frontendName.replace(/^fe_/, ''),
        mode: row.mode === 'tcp' ? 'tcp' : 'http',
        listenAddress: firstBind?.address && firstBind.address !== '*' ? firstBind.address : '0.0.0.0',
        inboundPort: firstBind?.port ?? 80,
        inboundSsl: Boolean(firstBind?.ssl),
        sslCertificate: firstBind?.sslCertificate ?? undefined,
        sharedFrontendName: row.frontendName,
        hostMatch: row.hostMatch ?? '',
        pathBegMatch: row.pathBegMatch ?? '',
        balanceAlgorithm: row.balanceAlgorithm || 'roundrobin',
        targets:
          row.targets.length > 0
            ? row.targets.map((tItem) => ({
                name: tItem.name,
                address: tItem.address,
                port: tItem.port ?? 80,
                weight: tItem.weight ?? 100,
                ssl: tItem.ssl,
                check: tItem.check,
                backup: tItem.backup,
              }))
            : [{ name: 'srv_1', address: '', port: 80, weight: 100, check: true, ssl: false, backup: false }],
        httpCheckEnabled: row.advCheck === 'httpchk',
        httpCheckMethod: row.httpCheckMethod || 'GET',
        httpCheckUri: row.httpCheckUri || '/',
        connectTimeoutMs: row.connectTimeoutMs ?? 5000,
        serverTimeoutMs: row.serverTimeoutMs ?? 30000,
        enabled: row.enabled,
      });
      setModalOpen(true);
    },
    [form],
  );

  const handleSave = useCallback(async () => {
    try {
      const values = await form.validateFields();
      const cleanedTargets: UpsertReverseProxyTargetInput[] = (values.targets ?? [])
        .filter((item) => item && String(item.address ?? '').trim() !== '' && Number(item.port) > 0)
        .map((item, idx) => ({
          name: item.name?.trim() || `srv_${idx + 1}`,
          address: item.address.trim(),
          port: Number(item.port),
          weight: item.weight != null ? Number(item.weight) : 100,
          ssl: Boolean(item.ssl),
          check: item.check !== false,
          backup: Boolean(item.backup),
        }));

      if (cleanedTargets.length === 0) {
        message.error(t('At least one outbound target IP and port is required'));
        return;
      }

      setSaving(true);
      await api.upsertReverseProxy({
        connectionId: values.connectionId,
        isEdit: Boolean(editingRoute),
        kind: values.kind,
        proxySlug: values.proxySlug?.trim() || undefined,
        frontendName: values.kind === 'routing_rule' ? values.sharedFrontendName : editingRoute?.frontendName,
        backendName: editingRoute?.backendName,
        ruleIndex: editingRoute?.ruleIndex ?? null,
        mode: values.kind === 'routing_rule' ? 'http' : values.mode,
        listenAddress: values.listenAddress,
        inboundPort: values.inboundPort,
        inboundSsl: values.inboundSsl,
        sslCertificate: values.sslCertificate ?? null,
        hostMatch: values.hostMatch ?? null,
        pathBegMatch: values.pathBegMatch ?? null,
        balanceAlgorithm: values.balanceAlgorithm,
        targets: cleanedTargets,
        httpCheckEnabled: values.httpCheckEnabled,
        httpCheckMethod: values.httpCheckMethod,
        httpCheckUri: values.httpCheckUri,
        connectTimeoutMs: values.connectTimeoutMs ?? null,
        serverTimeoutMs: values.serverTimeoutMs ?? null,
        enabled: values.enabled,
      });

      message.success(t('Reverse proxy saved and applied'));
      setModalOpen(false);
      setEditingRoute(null);
      await loadRoutes();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [api, editingRoute, form, loadRoutes, t]);

  const handleToggleEnabled = useCallback(
    async (row: HaproxyReverseProxyRoute) => {
      const nextEnabled = !row.enabled;
      try {
        await api.toggleReverseProxy({
          connectionId: row.connectionId,
          kind: row.kind,
          frontendName: row.frontendName,
          backendName: row.backendName,
          enabled: nextEnabled,
        });
        message.success(nextEnabled ? t('Reverse proxy enabled') : t('Reverse proxy disabled'));
        await loadRoutes();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, loadRoutes, t],
  );

  const handleDelete = useCallback(
    async (row: HaproxyReverseProxyRoute) => {
      try {
        await api.deleteReverseProxy({
          connectionId: row.connectionId,
          kind: row.kind,
          frontendName: row.frontendName,
          backendName: row.backendName,
          ruleIndex: row.ruleIndex,
        });
        message.success(t('Reverse proxy deleted'));
        await loadRoutes();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, loadRoutes, t],
  );

  if (!bootstrapping && connections.length === 0) {
    return (
      <Card>
        <Empty description={t('No enabled HAProxy Data Plane connections')} />
      </Card>
    );
  }

  const nodeSelectOptions = connections.map((c) => {
    const addr = nodeAddressByConnId.get(c.id);
    const baseLabel = c.title ? `${c.title} (${c.name})` : c.name;
    return {
      value: c.id,
      label: addr ? `${baseLabel} — ${addr}` : baseLabel,
    };
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Multi-field Filter Bar wrapped in semantic <search> landmark */}
      <Card size="small">
        {React.createElement(
          'search',
          { 'aria-label': t('Filter reverse proxies') },
          <Row gutter={[12, 12]} align="middle" justify="space-between">
            <Col>
              <Space wrap size={10}>
                {!fixedConnectionId && (
                  <Select
                    style={{ minWidth: 230 }}
                    aria-label={t('Node')}
                    value={nodeFilter}
                    onChange={(val: number | '__all__') => setNodeFilter(val)}
                    options={[{ value: '__all__', label: t('All nodes') }, ...nodeSelectOptions]}
                  />
                )}
                <Input
                  allowClear
                  style={{ width: 240 }}
                  placeholder={t('Filter inbound (port, domain, path, frontend)')}
                  aria-label={t('Filter inbound (port, domain, path, frontend)')}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={inboundFilter}
                  onChange={(e) => setInboundFilter(e.target.value)}
                />
                <Input
                  allowClear
                  style={{ width: 230 }}
                  placeholder={t('Filter outbound (IP, port, backend)')}
                  aria-label={t('Filter outbound (IP, port, backend)')}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={outboundFilter}
                  onChange={(e) => setOutboundFilter(e.target.value)}
                />
                <Select
                  style={{ minWidth: 185 }}
                  aria-label={t('Health & Timeouts')}
                  value={healthFilter}
                  onChange={(val: HealthFilterValue) => setHealthFilter(val)}
                  options={[
                    { value: '__all__', label: t('All health states') },
                    { value: 'healthy', label: t('Healthy (UP)') },
                    { value: 'degraded_or_down', label: t('Degraded / Down') },
                    { value: 'disabled', label: t('Disabled') },
                  ]}
                />
                <Button
                  htmlType="button"
                  icon={<ReloadOutlined aria-hidden="true" />}
                  loading={loading}
                  onClick={loadRoutes}
                >
                  {t('Refresh')}
                </Button>
              </Space>
            </Col>
            <Col>
              <Space wrap>
                <Tag color="blue">
                  {t('Total Routes')}: {summaryCounts.total}
                </Tag>
                <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
                  {t('Healthy (UP)')}: {summaryCounts.healthy}
                </Tag>
                {summaryCounts.degradedOrDown > 0 && (
                  <Tag icon={<WarningOutlined aria-hidden="true" />} color="error">
                    {t('Degraded / Down')}: {summaryCounts.degradedOrDown}
                  </Tag>
                )}
                {summaryCounts.disabled > 0 && (
                  <Tag icon={<StopOutlined aria-hidden="true" />}>
                    {t('Disabled')}: {summaryCounts.disabled}
                  </Tag>
                )}
                {canEdit && (
                  <Button
                    htmlType="button"
                    type="primary"
                    icon={<PlusOutlined aria-hidden="true" />}
                    onClick={openCreateModal}
                  >
                    {t('Add Reverse Proxy')}
                  </Button>
                )}
              </Space>
            </Col>
          </Row>,
        )}
      </Card>

      {nodeErrors.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={nodeErrors.map((ne) => `${ne.nodeName} (${ne.nodeAddress}): ${ne.error}`).join(' | ')}
        />
      )}

      {/* Unified In -> Out Reverse Proxy Table */}
      <Card size="small">
        <div
          role="region"
          aria-label={t('Reverse Proxy (In → Out)')}
          tabIndex={0}
          style={{ overflowX: 'auto', maxWidth: '100%' }}
        >
          <Table<HaproxyReverseProxyRoute>
            rowKey="routeKey"
            size="small"
            sticky
            loading={loading}
            dataSource={filteredRoutes}
            scroll={{ x: 1080 }}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            columns={[
              {
                title: t('Node'),
                key: 'node',
                width: 200,
                render: (_v: unknown, row: HaproxyReverseProxyRoute) => (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>{row.nodeTitle || row.nodeName}</Typography.Text>
                    <Space size={4} wrap>
                      <Tag color="geekblue">{row.nodeAddress}</Tag>
                      {row.nodeHostname && row.nodeHostname !== row.nodeAddress && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          ({row.nodeHostname})
                        </Typography.Text>
                      )}
                    </Space>
                  </Space>
                ),
              },
              {
                title: t('Inbound'),
                key: 'inbound',
                width: 270,
                render: (_v: unknown, row: HaproxyReverseProxyRoute) => (
                  <Space direction="vertical" size={4}>
                    <Space size={4} wrap>
                      <Tag color={row.mode === 'tcp' ? 'purple' : 'blue'}>{String(row.mode).toUpperCase()}</Tag>
                      {row.binds.length > 0 ? (
                        row.binds.map((b) => (
                          <Space key={b.name} size={2}>
                            <Typography.Text code strong>
                              {b.address}:{b.port ?? '*'}
                            </Typography.Text>
                            {b.ssl && <Tag color="gold">SSL</Tag>}
                          </Space>
                        ))
                      ) : (
                        <Typography.Text type="secondary">—</Typography.Text>
                      )}
                    </Space>
                    <Space size={4} wrap>
                      {row.hostMatch && <Tag color="cyan">Host: {row.hostMatch}</Tag>}
                      {row.pathBegMatch && <Tag color="cyan">Path: {row.pathBegMatch}</Tag>}
                      {!row.hostMatch && !row.pathBegMatch && row.kind === 'routing_rule' && row.ruleCondTest && (
                        <Tag>
                          {row.ruleCond ?? 'if'} {row.ruleCondTest}
                        </Tag>
                      )}
                      {row.kind === 'dedicated_port' && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t('Default route')} · {row.frontendName}
                        </Typography.Text>
                      )}
                      {row.kind === 'routing_rule' && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {row.frontendName}
                        </Typography.Text>
                      )}
                    </Space>
                  </Space>
                ),
              },
              {
                title: t('Outbound'),
                key: 'outbound',
                width: 300,
                render: (_v: unknown, row: HaproxyReverseProxyRoute) => {
                  if (row.isDynamicBackend) {
                    return (
                      <Space direction="vertical" size={2}>
                        <Tag icon={<SwapOutlined aria-hidden="true" />} color="processing">
                          {t('Dynamic Map')}
                        </Tag>
                        <Typography.Text code style={{ fontSize: 12 }}>
                          {row.backendName}
                        </Typography.Text>
                      </Space>
                    );
                  }
                  return (
                    <Space direction="vertical" size={4}>
                      {row.targets.length > 0 ? (
                        row.targets.map((srv) => (
                          <Space key={srv.name} size={4} wrap>
                            <ArrowRightOutlined aria-hidden="true" style={{ opacity: 0.55, fontSize: 12 }} />
                            <Typography.Text code strong>
                              {srv.address}
                              {srv.port != null ? `:${srv.port}` : ''}
                            </Typography.Text>
                            {srv.ssl && <Tag color="gold">SSL</Tag>}
                            {renderTargetLiveTag(srv.liveStatus, srv.maintenance)}
                          </Space>
                        ))
                      ) : (
                        <Typography.Text type="secondary">—</Typography.Text>
                      )}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {row.backendName || '—'}
                        {row.balanceAlgorithm ? ` (${row.balanceAlgorithm})` : ''}
                      </Typography.Text>
                    </Space>
                  );
                },
              },
              {
                title: t('Health & Timeouts'),
                key: 'health',
                width: 240,
                render: (_v: unknown, row: HaproxyReverseProxyRoute) => {
                  let statusTag: React.ReactNode;
                  if (row.healthState === 'disabled') {
                    statusTag = <Tag icon={<StopOutlined aria-hidden="true" />}>{t('Disabled')}</Tag>;
                  } else if (row.healthState === 'healthy') {
                    statusTag = (
                      <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
                        UP ({row.upTargets}/{row.totalTargets})
                      </Tag>
                    );
                  } else if (row.healthState === 'degraded') {
                    statusTag = (
                      <Tag icon={<WarningOutlined aria-hidden="true" />} color="warning">
                        DEGRADED ({row.upTargets}/{row.totalTargets})
                      </Tag>
                    );
                  } else if (row.healthState === 'down' || row.healthState === 'no_servers') {
                    statusTag = (
                      <Tag icon={<CloseCircleOutlined aria-hidden="true" />} color="error">
                        DOWN ({row.upTargets}/{row.totalTargets})
                      </Tag>
                    );
                  } else {
                    statusTag = (
                      <Tag icon={<SwapOutlined aria-hidden="true" />} color="processing">
                        {t('Dynamic Map')}
                      </Tag>
                    );
                  }

                  const sampleCheck = row.targets.find((s) => s.checkStatus);

                  return (
                    <Space direction="vertical" size={3}>
                      <Space size={4} wrap>
                        {statusTag}
                        {sampleCheck?.checkStatus && (
                          <Tag>
                            {sampleCheck.checkStatus}
                            {sampleCheck.checkCode != null ? ` (${sampleCheck.checkCode})` : ''}
                          </Tag>
                        )}
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('Connect')}: {row.connectTimeoutMs != null ? `${row.connectTimeoutMs}ms` : '—'} ·{' '}
                        {t('Server')}: {row.serverTimeoutMs != null ? `${row.serverTimeoutMs}ms` : '—'}
                        {row.timeoutInherited ? ` (${t('inherited')})` : ''}
                      </Typography.Text>
                    </Space>
                  );
                },
              },
              ...(canEdit
                ? [
                    {
                      title: t('Actions'),
                      key: 'actions',
                      width: 240,
                      render: (_v: unknown, row: HaproxyReverseProxyRoute) => {
                        const routeLabel = `${row.nodeName} ${row.frontendName} ${row.backendName}`;
                        const toggleLabel = row.enabled ? t('Disable') : t('Enable');
                        return (
                          <Space size={6} wrap>
                            <Button
                              htmlType="button"
                              size="small"
                              icon={<EditOutlined aria-hidden="true" />}
                              disabled={row.isDynamicBackend}
                              aria-label={`${t('Edit')} ${routeLabel}`}
                              onClick={() => openEditModal(row)}
                            >
                              {t('Edit')}
                            </Button>
                            <Button
                              htmlType="button"
                              size="small"
                              icon={
                                row.enabled ? (
                                  <PauseCircleOutlined aria-hidden="true" />
                                ) : (
                                  <PlayCircleOutlined aria-hidden="true" />
                                )
                              }
                              disabled={!row.canToggle}
                              aria-label={`${toggleLabel} ${routeLabel}`}
                              onClick={() => handleToggleEnabled(row)}
                            >
                              {toggleLabel}
                            </Button>
                            <Popconfirm
                              title={t('Delete this reverse proxy route?')}
                              onConfirm={() => handleDelete(row)}
                            >
                              <Button
                                htmlType="button"
                                size="small"
                                danger
                                icon={<DeleteOutlined aria-hidden="true" />}
                                disabled={row.isDynamicBackend}
                                aria-label={`${t('Delete')} ${routeLabel}`}
                              >
                                {t('Delete')}
                              </Button>
                            </Popconfirm>
                          </Space>
                        );
                      },
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </Card>

      {/* 1-Step Create / Edit Reverse Proxy Modal */}
      <Modal
        open={modalOpen}
        width={760}
        title={editingRoute ? t('Edit Reverse Proxy') : t('Add Reverse Proxy')}
        okText={t('Save')}
        cancelText={t('Cancel')}
        confirmLoading={saving}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditingRoute(null);
        }}
      >
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="connectionId" label={t('Node')} rules={[{ required: true }]}>
                <Select disabled={Boolean(editingRoute || fixedConnectionId)} options={nodeSelectOptions} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="proxySlug" label={t('Service Identifier (optional)')}>
                <Input
                  disabled={Boolean(editingRoute)}
                  placeholder="crm_web_8090"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="kind" label={t('Proxy Style')}>
            <Radio.Group
              disabled={Boolean(editingRoute)}
              options={[
                { value: 'dedicated_port', label: t('Dedicated Port (Port → IP:Port)') },
                { value: 'routing_rule', label: t('Domain / Path Rule on Shared Port') },
              ]}
            />
          </Form.Item>

          {watchedKind === 'dedicated_port' ? (
            <Card size="small" title={t('Inbound')} style={{ marginBottom: 12 }}>
              <Row gutter={12}>
                <Col span={6}>
                  <Form.Item name="mode" label={t('Mode')} style={{ marginBottom: 8 }}>
                    <Radio.Group
                      options={[
                        { value: 'http', label: 'HTTP' },
                        { value: 'tcp', label: 'TCP' },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={9}>
                  <Form.Item name="listenAddress" label={t('Listen Address')} style={{ marginBottom: 8 }}>
                    <Input placeholder="0.0.0.0" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
                  </Form.Item>
                </Col>
                <Col span={9}>
                  <Form.Item
                    name="inboundPort"
                    label={t('Inbound Port')}
                    rules={[{ required: true }]}
                    style={{ marginBottom: 8 }}
                  >
                    <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12} align="middle">
                <Col span={8}>
                  <Form.Item
                    name="inboundSsl"
                    label={t('SSL Termination')}
                    valuePropName="checked"
                    style={{ marginBottom: 0 }}
                  >
                    <Switch />
                  </Form.Item>
                </Col>
                {watchedInboundSsl && (
                  <Col span={16}>
                    <Form.Item
                      name="sslCertificate"
                      label={t('SSL Certificate Path / Storage Name')}
                      style={{ marginBottom: 0 }}
                    >
                      <Select
                        allowClear
                        showSearch
                        options={modalSslCerts.map((c) => ({
                          value: c.file || c.storage_name,
                          label: `${c.storage_name}${c.domains ? ` (${c.domains})` : ''}`,
                        }))}
                      />
                    </Form.Item>
                  </Col>
                )}
              </Row>
            </Card>
          ) : (
            <Card size="small" title={t('Inbound')} style={{ marginBottom: 12 }}>
              <Row gutter={12}>
                <Col span={8}>
                  <Form.Item
                    name="sharedFrontendName"
                    label={t('Shared Listener Frontend')}
                    rules={[{ required: true }]}
                    style={{ marginBottom: 0 }}
                  >
                    <Select
                      disabled={Boolean(editingRoute)}
                      options={modalFrontends
                        .filter((f) => (f.mode ?? 'http') === 'http')
                        .map((f) => ({ value: f.name, label: f.name }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={9}>
                  <Form.Item name="hostMatch" label={t('Domain Match (Host header)')} style={{ marginBottom: 0 }}>
                    <Input placeholder="app.example.com" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
                  </Form.Item>
                </Col>
                <Col span={7}>
                  <Form.Item name="pathBegMatch" label={t('Path Prefix Match (optional)')} style={{ marginBottom: 0 }}>
                    <Input placeholder="/api" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          )}

          <Card
            size="small"
            title={t('Outbound Upstream Targets')}
            extra={
              <Form.Item name="balanceAlgorithm" noStyle>
                <Select
                  size="small"
                  style={{ width: 140 }}
                  aria-label={t('Algorithm')}
                  options={VALID_BALANCE_ALGORITHMS.map((alg) => ({ value: alg, label: alg }))}
                />
              </Form.Item>
            }
            style={{ marginBottom: 12 }}
          >
            <Form.List name="targets">
              {(fields, { add, remove }) => (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {fields.map((field, index) => (
                    <Row key={field.key} gutter={8} align="middle">
                      <Col span={9}>
                        <Form.Item
                          {...field}
                          name={[field.name, 'address']}
                          label={index === 0 ? t('Target IP / Host') : undefined}
                          rules={[{ required: true }]}
                          style={{ marginBottom: 0 }}
                        >
                          <Input placeholder="10.0.1.25" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
                        </Form.Item>
                      </Col>
                      <Col span={5}>
                        <Form.Item
                          {...field}
                          name={[field.name, 'port']}
                          label={index === 0 ? t('Target Port') : undefined}
                          rules={[{ required: true }]}
                          style={{ marginBottom: 0 }}
                        >
                          <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={4}>
                        <Form.Item
                          {...field}
                          name={[field.name, 'weight']}
                          label={index === 0 ? t('Weight') : undefined}
                          style={{ marginBottom: 0 }}
                        >
                          <InputNumber min={0} max={256} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={3}>
                        <Form.Item
                          {...field}
                          name={[field.name, 'ssl']}
                          label={index === 0 ? 'TLS' : undefined}
                          valuePropName="checked"
                          style={{ marginBottom: 0 }}
                        >
                          <Switch size="small" />
                        </Form.Item>
                      </Col>
                      <Col span={3}>
                        {fields.length > 1 && (
                          <Button
                            htmlType="button"
                            size="small"
                            danger
                            icon={<DeleteOutlined aria-hidden="true" />}
                            aria-label={`${t('Delete')} #${index + 1}`}
                            onClick={() => remove(field.name)}
                          />
                        )}
                      </Col>
                    </Row>
                  ))}
                  <Button
                    htmlType="button"
                    size="small"
                    type="dashed"
                    icon={<PlusOutlined aria-hidden="true" />}
                    onClick={() =>
                      add({
                        name: `srv_${fields.length + 1}`,
                        address: '',
                        port: 80,
                        weight: 100,
                        check: true,
                        ssl: false,
                      })
                    }
                  >
                    {t('Add Upstream Target')}
                  </Button>
                </Space>
              )}
            </Form.List>
          </Card>

          <Card size="small" title={t('Health & Timeouts')}>
            <Row gutter={12} align="middle">
              <Col span={7}>
                <Form.Item name="connectTimeoutMs" label={t('Connect Timeout (ms)')} style={{ marginBottom: 8 }}>
                  <InputNumber min={100} max={3600000} step={500} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={7}>
                <Form.Item name="serverTimeoutMs" label={t('Server Timeout (ms)')} style={{ marginBottom: 8 }}>
                  <InputNumber min={100} max={3600000} step={1000} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked" style={{ marginBottom: 8 }}>
                  <Switch />
                </Form.Item>
              </Col>
              {(watchedKind === 'routing_rule' || watchedMode !== 'tcp') && (
                <Col span={5}>
                  <Form.Item
                    name="httpCheckEnabled"
                    label={t('HTTP Health Check')}
                    valuePropName="checked"
                    style={{ marginBottom: 8 }}
                  >
                    <Switch />
                  </Form.Item>
                </Col>
              )}
            </Row>
            {watchedHttpCheck && (watchedKind === 'routing_rule' || watchedMode !== 'tcp') && (
              <Row gutter={12}>
                <Col span={6}>
                  <Form.Item name="httpCheckMethod" label={t('Check Method')} style={{ marginBottom: 0 }}>
                    <Select options={['GET', 'HEAD', 'OPTIONS'].map((m) => ({ value: m, label: m }))} />
                  </Form.Item>
                </Col>
                <Col span={18}>
                  <Form.Item name="httpCheckUri" label={t('Check URI')} style={{ marginBottom: 0 }}>
                    <Input placeholder="/health" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
                  </Form.Item>
                </Col>
              </Row>
            )}
          </Card>
        </Form>
      </Modal>
    </Space>
  );
};

export default HaproxyReverseProxyView;
