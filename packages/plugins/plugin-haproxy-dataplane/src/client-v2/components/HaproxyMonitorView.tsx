// SPDX-License-Identifier: Apache-2.0

import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  ControlOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_SERVER_WEIGHT, MIN_SERVER_WEIGHT } from '../../shared/constants';
import type {
  HaproxyAdminState,
  HaproxyMergedServerRow,
  HaproxyNodeSnapshot,
  HaproxyRuntimeMapEntry,
  HaproxyStatRow,
  HaproxyStickTable,
  HaproxyStickTableEntry,
  HaproxyStorageFile,
} from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useHaproxySession } from '../hooks/useHaproxySession';
import { useT } from '../locale';
import { formatBytes, formatDurationSeconds, getErrorMessage } from '../utils/format';
import { NodeToolbar } from './NodeToolbar';

export type HaproxyMonitorTabKey = 'servers' | 'backends' | 'frontends' | 'runtimeMaps';

export interface HaproxyMonitorViewProps {
  fixedConnectionId?: number;
  defaultRefreshSeconds?: number;
  defaultTab?: HaproxyMonitorTabKey;
}

function renderOperationalTag(state: string, status: string) {
  const normalized = state.toLowerCase();
  const upperStatus = status.toUpperCase();
  if (upperStatus.startsWith('MAINT')) {
    return (
      <Tag icon={<StopOutlined aria-hidden="true" />} color="default">
        MAINT
      </Tag>
    );
  }
  if (normalized === 'up' || upperStatus.startsWith('UP') || upperStatus === 'OPEN') {
    return (
      <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
        {upperStatus || 'UP'}
      </Tag>
    );
  }
  if (normalized === 'stopping' || upperStatus.startsWith('DRAIN')) {
    return (
      <Tag icon={<PauseCircleOutlined aria-hidden="true" />} color="warning">
        {upperStatus || 'STOPPING'}
      </Tag>
    );
  }
  if (normalized === 'down' || upperStatus.startsWith('DOWN')) {
    return (
      <Tag icon={<CloseCircleOutlined aria-hidden="true" />} color="error">
        {upperStatus || 'DOWN'}
      </Tag>
    );
  }
  return (
    <Tag icon={<ClockCircleOutlined aria-hidden="true" />} color="processing">
      {status || state || 'UNKNOWN'}
    </Tag>
  );
}

function renderAdminStateTag(adminState: string) {
  const normalized = adminState.toLowerCase();
  if (normalized === 'ready') {
    return (
      <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="green">
        ready
      </Tag>
    );
  }
  if (normalized === 'drain') {
    return (
      <Tag icon={<PauseCircleOutlined aria-hidden="true" />} color="gold">
        drain
      </Tag>
    );
  }
  if (normalized === 'maint') {
    return (
      <Tag icon={<WarningOutlined aria-hidden="true" />} color="volcano">
        maint
      </Tag>
    );
  }
  return <Tag>{adminState}</Tag>;
}

export const HaproxyMonitorView: React.FC<HaproxyMonitorViewProps> = ({
  fixedConnectionId,
  defaultRefreshSeconds = 0,
  defaultTab = 'servers',
}) => {
  const t = useT();
  const api = useHaproxyApi();
  const { permissions, connections, selectedConnectionId, setSelectedConnectionId, bootstrapping, bootstrapError } =
    useHaproxySession(fixedConnectionId);

  const [refreshSeconds, setRefreshSeconds] = useState<number>(defaultRefreshSeconds);
  const [activeTab, setActiveTab] = useState<HaproxyMonitorTabKey>(defaultTab);
  const [backendFilter, setBackendFilter] = useState<string>('__all__');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [snapshot, setSnapshot] = useState<HaproxyNodeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutatingKey, setMutatingKey] = useState<string | null>(null);

  const [weightTarget, setWeightTarget] = useState<HaproxyMergedServerRow | null>(null);
  const [weightSaving, setWeightSaving] = useState(false);
  const [weightForm] = Form.useForm<{ weight: number }>();

  const [addSrvOpen, setAddSrvOpen] = useState(false);
  const [addSrvSaving, setAddSrvSaving] = useState(false);
  const [addSrvForm] = Form.useForm<{
    backend: string;
    name: string;
    address: string;
    port?: number;
    weight?: number;
    check: boolean;
  }>();

  // Runtime Maps & Stick Tables state
  const [runtimeMaps, setRuntimeMaps] = useState<HaproxyStorageFile[]>([]);
  const [selectedMap, setSelectedMap] = useState<string>('');
  const [mapEntries, setMapEntries] = useState<HaproxyRuntimeMapEntry[]>([]);
  const [mapEntryModalOpen, setMapEntryModalOpen] = useState(false);
  const [mapEntryForm] = Form.useForm<{ key: string; value: string; forceSync: boolean }>();

  const [stickTables, setStickTables] = useState<HaproxyStickTable[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [tableEntries, setTableEntries] = useState<HaproxyStickTableEntry[]>([]);

  const activeConnRef = useRef<number | null>(selectedConnectionId);
  activeConnRef.current = selectedConnectionId;

  useEffect(() => {
    setRefreshSeconds(defaultRefreshSeconds);
  }, [defaultRefreshSeconds]);

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab]);

  const loadSnapshot = useCallback(
    async (silent = false) => {
      const connId = selectedConnectionId;
      if (!connId) {
        setSnapshot(null);
        return;
      }
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const data = await api.getSnapshot(connId);
        if (activeConnRef.current !== connId) return;
        setSnapshot(data);
      } catch (err) {
        if (activeConnRef.current !== connId) return;
        setError(getErrorMessage(err, t('Failed to load HAProxy live snapshot')));
      } finally {
        if (!silent && activeConnRef.current === connId) {
          setLoading(false);
        }
      }
    },
    [api, selectedConnectionId, t],
  );

  const loadRuntimeExtras = useCallback(async () => {
    if (!selectedConnectionId) return;
    try {
      const [maps, tables] = await Promise.all([
        api.listRuntimeMaps(selectedConnectionId).catch(() => []),
        api.listStickTables(selectedConnectionId).catch(() => []),
      ]);
      setRuntimeMaps(maps);
      setStickTables(tables);
      const firstMap = maps[0]?.storage_name ?? '';
      setSelectedMap((prev) => (prev && maps.some((m) => m.storage_name === prev) ? prev : firstMap));
      const firstTable = tables[0]?.name ?? '';
      setSelectedTable((prev) => (prev && tables.some((st) => st.name === prev) ? prev : firstTable));
    } catch {
      // Ignore non-fatal runtime map/stick-table errors.
    }
  }, [api, selectedConnectionId]);

  useEffect(() => {
    if (selectedConnectionId && (permissions?.canRead || permissions?.canRuntime)) {
      setBackendFilter('__all__');
      loadSnapshot(false);
    }
  }, [loadSnapshot, permissions?.canRead, permissions?.canRuntime, selectedConnectionId]);

  useEffect(() => {
    if (activeTab === 'runtimeMaps' && selectedConnectionId) {
      loadRuntimeExtras();
    }
  }, [activeTab, loadRuntimeExtras, selectedConnectionId]);

  useEffect(() => {
    if (activeTab === 'runtimeMaps' && selectedConnectionId && selectedMap) {
      api
        .getRuntimeMapEntries(selectedConnectionId, selectedMap)
        .then(setMapEntries)
        .catch(() => setMapEntries([]));
    }
  }, [activeTab, api, selectedConnectionId, selectedMap]);

  useEffect(() => {
    if (activeTab === 'runtimeMaps' && selectedConnectionId && selectedTable) {
      api
        .getStickTableEntries(selectedConnectionId, selectedTable)
        .then(setTableEntries)
        .catch(() => setTableEntries([]));
    }
  }, [activeTab, api, selectedConnectionId, selectedTable]);

  useEffect(() => {
    if (!selectedConnectionId || refreshSeconds <= 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      loadSnapshot(true);
    }, refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [loadSnapshot, refreshSeconds, selectedConnectionId]);

  const handleSetAdminState = useCallback(
    async (row: HaproxyMergedServerRow, adminState: HaproxyAdminState) => {
      if (!selectedConnectionId) return;
      setMutatingKey(row.key);
      try {
        await api.updateRuntimeServer({
          connectionId: selectedConnectionId,
          backend: row.backendName,
          server: row.name,
          adminState,
        });
        message.success(
          t('Server {{backend}}/{{server}} state set to {{state}}', {
            backend: row.backendName,
            server: row.name,
            state: adminState,
          }),
        );
        await loadSnapshot(true);
      } catch (err) {
        message.error(getErrorMessage(err, t('Failed to update runtime server')));
      } finally {
        setMutatingKey(null);
      }
    },
    [api, loadSnapshot, selectedConnectionId, t],
  );

  const openWeightModal = useCallback(
    (row: HaproxyMergedServerRow) => {
      setWeightTarget(row);
      weightForm.setFieldsValue({ weight: row.weight ?? 100 });
    },
    [weightForm],
  );

  const handleSubmitWeight = useCallback(async () => {
    if (!weightTarget || !selectedConnectionId) return;
    try {
      const values = await weightForm.validateFields();
      setWeightSaving(true);
      await api.updateRuntimeServer({
        connectionId: selectedConnectionId,
        backend: weightTarget.backendName,
        server: weightTarget.name,
        weight: values.weight,
      });
      message.success(
        t('Server {{backend}}/{{server}} weight updated to {{weight}}', {
          backend: weightTarget.backendName,
          server: weightTarget.name,
          weight: values.weight,
        }),
      );
      setWeightTarget(null);
      await loadSnapshot(true);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        return;
      }
      message.error(getErrorMessage(err, t('Failed to update runtime server')));
    } finally {
      setWeightSaving(false);
    }
  }, [api, loadSnapshot, selectedConnectionId, t, weightForm, weightTarget]);

  const handleAddRuntimeServer = useCallback(async () => {
    if (!selectedConnectionId) return;
    try {
      const values = await addSrvForm.validateFields();
      setAddSrvSaving(true);
      await api.addRuntimeServer({
        connectionId: selectedConnectionId,
        backend: values.backend,
        name: values.name,
        address: values.address,
        port: values.port,
        weight: values.weight,
        check: values.check ? 'enabled' : 'disabled',
      });
      message.success(t('Saved successfully'));
      setAddSrvOpen(false);
      await loadSnapshot(true);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    } finally {
      setAddSrvSaving(false);
    }
  }, [addSrvForm, api, loadSnapshot, selectedConnectionId, t]);

  const handleDeleteRuntimeServer = useCallback(
    async (row: HaproxyMergedServerRow) => {
      if (!selectedConnectionId) return;
      try {
        await api.deleteRuntimeServer(selectedConnectionId, row.backendName, row.name);
        message.success(t('Deleted successfully'));
        await loadSnapshot(true);
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, loadSnapshot, selectedConnectionId, t],
  );

  const handleAddMapEntry = useCallback(async () => {
    if (!selectedConnectionId || !selectedMap) return;
    try {
      const values = await mapEntryForm.validateFields();
      await api.addRuntimeMapEntry(selectedConnectionId, selectedMap, values.key, values.value, values.forceSync);
      message.success(t('Entry saved'));
      setMapEntryModalOpen(false);
      const updated = await api.getRuntimeMapEntries(selectedConnectionId, selectedMap);
      setMapEntries(updated);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    }
  }, [api, mapEntryForm, selectedConnectionId, selectedMap, t]);

  const handleDeleteMapEntry = useCallback(
    async (entryId: string) => {
      if (!selectedConnectionId || !selectedMap) return;
      try {
        await api.deleteRuntimeMapEntry(selectedConnectionId, selectedMap, entryId, true);
        message.success(t('Entry deleted'));
        const updated = await api.getRuntimeMapEntries(selectedConnectionId, selectedMap);
        setMapEntries(updated);
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, selectedConnectionId, selectedMap, t],
  );

  const totals = useMemo(() => {
    const frontends = snapshot?.frontends ?? [];
    const servers = snapshot?.servers ?? [];
    const totalReq = frontends.reduce((acc, f) => acc + (f.reqTot ?? f.stot), 0);
    const totalBin = frontends.reduce((acc, f) => acc + f.bin, 0);
    const totalBout = frontends.reduce((acc, f) => acc + f.bout, 0);
    const upServers = servers.filter(
      (s) => s.operationalState.toLowerCase() === 'up' && s.adminState.toLowerCase() !== 'maint',
    ).length;
    return {
      totalReq,
      totalBin,
      totalBout,
      upServers,
      totalServers: servers.length,
    };
  }, [snapshot]);

  const backendNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...(snapshot?.backends.map((b) => b.name) ?? []),
          ...(snapshot?.servers.map((s) => s.backendName) ?? []),
        ]),
      ).filter(Boolean),
    [snapshot],
  );

  const backendOptions = useMemo(
    () => [
      { value: '__all__', label: t('All backends') },
      ...backendNames.map((name) => ({ value: name, label: name })),
    ],
    [backendNames, t],
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredServers = useMemo(
    () =>
      (snapshot?.servers ?? []).filter((row) => {
        if (backendFilter !== '__all__' && row.backendName !== backendFilter) return false;
        if (!normalizedQuery) return true;
        return (
          row.name.toLowerCase().includes(normalizedQuery) ||
          row.backendName.toLowerCase().includes(normalizedQuery) ||
          (row.address ?? '').toLowerCase().includes(normalizedQuery)
        );
      }),
    [backendFilter, normalizedQuery, snapshot?.servers],
  );

  const filteredBackends = useMemo(
    () =>
      (snapshot?.backends ?? []).filter((row) => {
        if (backendFilter !== '__all__' && row.name !== backendFilter) return false;
        if (!normalizedQuery) return true;
        return (
          row.name.toLowerCase().includes(normalizedQuery) || (row.algo ?? '').toLowerCase().includes(normalizedQuery)
        );
      }),
    [backendFilter, normalizedQuery, snapshot?.backends],
  );

  const filteredFrontends = useMemo(
    () =>
      (snapshot?.frontends ?? []).filter((row) => {
        if (!normalizedQuery) return true;
        return (
          row.name.toLowerCase().includes(normalizedQuery) || (row.mode ?? '').toLowerCase().includes(normalizedQuery)
        );
      }),
    [normalizedQuery, snapshot?.frontends],
  );

  const serverColumns: ColumnsType<HaproxyMergedServerRow> = useMemo(() => {
    const cols: ColumnsType<HaproxyMergedServerRow> = [
      {
        title: t('Backend'),
        dataIndex: 'backendName',
        key: 'backendName',
        render: (val: string) => <Tag color="blue">{val}</Tag>,
      },
      {
        title: t('Server'),
        dataIndex: 'name',
        key: 'name',
        render: (val: string) => <Typography.Text strong>{val}</Typography.Text>,
      },
      {
        title: t('Address'),
        key: 'address',
        render: (_v: unknown, row: HaproxyMergedServerRow) =>
          row.address ? (
            <Typography.Text code>{row.port ? `${row.address}:${row.port}` : row.address}</Typography.Text>
          ) : (
            '—'
          ),
      },
      {
        title: t('Operational'),
        key: 'operationalState',
        render: (_v: unknown, row: HaproxyMergedServerRow) => renderOperationalTag(row.operationalState, row.status),
      },
      {
        title: t('Admin State'),
        dataIndex: 'adminState',
        key: 'adminState',
        render: (val: string) => renderAdminStateTag(val),
      },
      {
        title: t('Weight'),
        dataIndex: 'weight',
        key: 'weight',
        render: (val: number | null) => (val != null ? <Typography.Text strong>{val}</Typography.Text> : '—'),
      },
      {
        title: t('Sessions (Cur / Max)'),
        key: 'sessions',
        render: (_v: unknown, row: HaproxyMergedServerRow) => `${row.scur} / ${row.smax}`,
      },
      {
        title: t('HTTP 2xx / 4xx / 5xx'),
        key: 'httpCodes',
        render: (_v: unknown, row: HaproxyMergedServerRow) => `${row.hrsp2xx} / ${row.hrsp4xx} / ${row.hrsp5xx}`,
      },
      {
        title: t('Bytes In / Out'),
        key: 'bytes',
        render: (_v: unknown, row: HaproxyMergedServerRow) => `${formatBytes(row.bin)} / ${formatBytes(row.bout)}`,
      },
      {
        title: t('Health Check'),
        key: 'check',
        render: (_v: unknown, row: HaproxyMergedServerRow) => {
          if (!row.checkStatus) return '—';
          const codePart = row.checkCode != null ? ` ${row.checkCode}` : '';
          const durPart = row.checkDuration != null ? ` (${row.checkDuration}ms)` : '';
          return `${row.checkStatus}${codePart}${durPart}`;
        },
      },
    ];

    if (permissions?.canRuntime) {
      cols.push({
        title: t('Runtime Controls'),
        key: 'controls',
        fixed: 'right',
        render: (_v: unknown, row: HaproxyMergedServerRow) => {
          const busy = mutatingKey === row.key;
          const currentAdmin = row.adminState.toLowerCase();
          const targetLabel = `${row.backendName}/${row.name}`;
          return (
            <Space size={4} wrap>
              <Button
                htmlType="button"
                size="small"
                type={currentAdmin === 'ready' ? 'primary' : 'default'}
                loading={busy}
                disabled={currentAdmin === 'ready'}
                aria-label={`${t('Ready')} ${targetLabel}`}
                onClick={() => handleSetAdminState(row, 'ready')}
              >
                {t('Ready')}
              </Button>
              <Button
                htmlType="button"
                size="small"
                loading={busy}
                disabled={currentAdmin === 'drain'}
                aria-label={`${t('Drain')} ${targetLabel}`}
                onClick={() => handleSetAdminState(row, 'drain')}
              >
                {t('Drain')}
              </Button>
              <Button
                htmlType="button"
                size="small"
                danger={currentAdmin !== 'maint'}
                loading={busy}
                disabled={currentAdmin === 'maint'}
                aria-label={`${t('Maint')} ${targetLabel}`}
                onClick={() => handleSetAdminState(row, 'maint')}
              >
                {t('Maint')}
              </Button>
              <Button
                htmlType="button"
                size="small"
                icon={<ControlOutlined aria-hidden="true" />}
                aria-label={`${t('Set Weight')} ${targetLabel}`}
                onClick={() => openWeightModal(row)}
              >
                {t('Set Weight')}
              </Button>
              <Popconfirm
                title={t('Remove transient runtime server {{name}}?', { name: targetLabel })}
                onConfirm={() => handleDeleteRuntimeServer(row)}
              >
                <Button
                  htmlType="button"
                  size="small"
                  danger
                  icon={<DeleteOutlined aria-hidden="true" />}
                  aria-label={`${t('Delete Runtime Server')} ${targetLabel}`}
                />
              </Popconfirm>
            </Space>
          );
        },
      });
    }

    return cols;
  }, [handleDeleteRuntimeServer, handleSetAdminState, mutatingKey, openWeightModal, permissions?.canRuntime, t]);

  const backendColumns: ColumnsType<HaproxyStatRow> = useMemo(
    () => [
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
        render: (mode: string | null) => (mode ? <Tag>{mode.toUpperCase()}</Tag> : '—'),
      },
      {
        title: t('Algorithm'),
        dataIndex: 'algo',
        key: 'algo',
        render: (algo: string | null) => (algo ? <Tag color="geekblue">{algo}</Tag> : '—'),
      },
      {
        title: t('Status'),
        dataIndex: 'status',
        key: 'status',
        render: (status: string) => renderOperationalTag(status, status),
      },
      {
        title: t('Active / Backup'),
        key: 'actBck',
        render: (_v: unknown, row: HaproxyStatRow) => `${row.act ?? 0} / ${row.bck ?? 0}`,
      },
      {
        title: t('Sessions (Cur / Max)'),
        key: 'sessions',
        render: (_v: unknown, row: HaproxyStatRow) => `${row.scur} / ${row.smax}`,
      },
      {
        title: t('Queue'),
        dataIndex: 'qcur',
        key: 'qcur',
      },
      {
        title: t('HTTP 2xx / 4xx / 5xx'),
        key: 'httpCodes',
        render: (_v: unknown, row: HaproxyStatRow) => `${row.hrsp2xx} / ${row.hrsp4xx} / ${row.hrsp5xx}`,
      },
      {
        title: t('Bytes In / Out'),
        key: 'bytes',
        render: (_v: unknown, row: HaproxyStatRow) => `${formatBytes(row.bin)} / ${formatBytes(row.bout)}`,
      },
      {
        title: t('Response Time'),
        dataIndex: 'rtime',
        key: 'rtime',
        render: (rtime: number | null) => (rtime != null ? `${rtime} ms` : '—'),
      },
    ],
    [t],
  );

  const frontendColumns: ColumnsType<HaproxyStatRow> = useMemo(
    () => [
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
        render: (mode: string | null) => (mode ? <Tag>{mode.toUpperCase()}</Tag> : '—'),
      },
      {
        title: t('Status'),
        dataIndex: 'status',
        key: 'status',
        render: (status: string) => renderOperationalTag(status, status),
      },
      {
        title: t('Sessions (Cur / Max)'),
        key: 'sessions',
        render: (_v: unknown, row: HaproxyStatRow) =>
          `${row.scur} / ${row.smax}${row.slim ? ` (limit ${row.slim})` : ''}`,
      },
      {
        title: t('Req Rate'),
        dataIndex: 'reqRate',
        key: 'reqRate',
        render: (val: number | null) => (val != null ? `${val}/s` : '—'),
      },
      {
        title: t('Total Sessions'),
        dataIndex: 'stot',
        key: 'stot',
      },
      {
        title: t('HTTP 2xx / 4xx / 5xx'),
        key: 'httpCodes',
        render: (_v: unknown, row: HaproxyStatRow) => `${row.hrsp2xx} / ${row.hrsp4xx} / ${row.hrsp5xx}`,
      },
      {
        title: t('Errors (Req / Conn / Resp)'),
        key: 'errors',
        render: (_v: unknown, row: HaproxyStatRow) => `${row.ereq} / ${row.econ} / ${row.eresp}`,
      },
      {
        title: t('Bytes In / Out'),
        key: 'bytes',
        render: (_v: unknown, row: HaproxyStatRow) => `${formatBytes(row.bin)} / ${formatBytes(row.bout)}`,
      },
    ],
    [t],
  );

  if (!bootstrapping && permissions && !permissions.canRead && !permissions.canRuntime) {
    return <Alert type="warning" showIcon message={t('You do not have permission to view HAProxy live stats.')} />;
  }

  if (!bootstrapping && connections.length === 0) {
    return (
      <Card>
        <Empty
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text strong>{t('No enabled HAProxy Data Plane connections')}</Typography.Text>
              <Typography.Text type="secondary">
                {t('Add a connection in the Connections tab to start monitoring HAProxy nodes.')}
              </Typography.Text>
            </Space>
          }
        />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <NodeToolbar
        connections={connections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        fixedConnectionId={fixedConnectionId}
        loading={loading}
        onRefresh={() => loadSnapshot(false)}
        extraLeft={
          <Select
            style={{ minWidth: 155 }}
            aria-label={t('Auto refresh')}
            value={refreshSeconds}
            onChange={(val: number) => setRefreshSeconds(val)}
            options={[
              { value: 0, label: `${t('Auto refresh')}: ${t('Off')}` },
              { value: 5, label: `${t('Auto refresh')}: 5s` },
              { value: 10, label: `${t('Auto refresh')}: 10s` },
              { value: 30, label: `${t('Auto refresh')}: 30s` },
            ]}
          />
        }
        extraRight={
          snapshot?.fetchedAt ? (
            <Typography.Text type="secondary" role="status" aria-live="polite">
              {t('Last updated')}: {new Date(snapshot.fetchedAt).toLocaleTimeString()}
            </Typography.Text>
          ) : null
        }
      />

      {(bootstrapError || error) && <Alert type="error" showIcon message={bootstrapError || error} />}
      {snapshot?.processInfo.error && <Alert type="warning" showIcon message={snapshot.processInfo.error} />}
      {snapshot?.statsError && <Alert type="warning" showIcon message={snapshot.statsError} />}

      {snapshot && (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={12} sm={12} md={6}>
              <Card size="small">
                <Statistic
                  title={t('Active Connections')}
                  value={snapshot.processInfo.currConns ?? 0}
                  suffix={snapshot.processInfo.maxConn ? `/ ${snapshot.processInfo.maxConn}` : undefined}
                />
              </Card>
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Card size="small">
                <Statistic title={t('Servers UP')} value={totals.upServers} suffix={`/ ${totals.totalServers}`} />
              </Card>
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Card size="small">
                <Statistic title={t('Total Requests')} value={totals.totalReq} />
              </Card>
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Card size="small">
                <Statistic
                  title={t('Traffic In / Out')}
                  value={`${formatBytes(totals.totalBin)} / ${formatBytes(totals.totalBout)}`}
                />
              </Card>
            </Col>
          </Row>

          <Card size="small">
            <Descriptions size="small" column={{ xs: 1, sm: 2, md: 6 }}>
              <Descriptions.Item label={t('HAProxy Version')}>{snapshot.processInfo.version ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Data Plane API')}>{snapshot.apiInfo.apiVersion ?? 'v3'}</Descriptions.Item>
              <Descriptions.Item label={t('Config Version')}>
                {snapshot.configVersion != null ? <Tag color="geekblue">v{snapshot.configVersion}</Tag> : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Host')}>{snapshot.apiInfo.hostname ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Uptime')}>
                {formatDurationSeconds(snapshot.processInfo.uptime)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Threads')}>{snapshot.processInfo.nbthread ?? '—'}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card size="small">
            {activeTab !== 'runtimeMaps' && (
              <Space wrap style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
                <Space wrap>
                  {activeTab !== 'frontends' && (
                    <Select
                      style={{ minWidth: 200 }}
                      aria-label={t('Filter by backend')}
                      value={backendFilter}
                      onChange={(val: string) => setBackendFilter(val)}
                      options={backendOptions}
                    />
                  )}
                  <Input.Search
                    allowClear
                    style={{ width: 260 }}
                    placeholder={t('Search proxy or server')}
                    aria-label={t('Search proxy or server')}
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </Space>
                {permissions?.canRuntime && activeTab === 'servers' && backendNames.length > 0 && (
                  <Button
                    htmlType="button"
                    size="small"
                    icon={<PlusOutlined aria-hidden="true" />}
                    onClick={() => {
                      addSrvForm.resetFields();
                      addSrvForm.setFieldsValue({
                        backend: backendNames[0],
                        weight: 100,
                        check: true,
                      });
                      setAddSrvOpen(true);
                    }}
                  >
                    {t('Add Runtime Server')}
                  </Button>
                )}
              </Space>
            )}

            {permissions?.canRuntime && activeTab === 'servers' && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={t(
                  'Runtime changes apply immediately over HAProxy stats socket without reloading haproxy.cfg.',
                )}
              />
            )}

            <Tabs
              activeKey={activeTab}
              onChange={(key) => setActiveTab(key as HaproxyMonitorTabKey)}
              items={[
                {
                  key: 'servers',
                  label: `${t('Servers (Runtime)')} (${filteredServers.length})`,
                  children: (
                    <Table<HaproxyMergedServerRow>
                      rowKey="key"
                      size="small"
                      loading={loading}
                      columns={serverColumns}
                      dataSource={filteredServers}
                      scroll={{ x: 1120 }}
                      pagination={{ pageSize: 20, hideOnSinglePage: true }}
                    />
                  ),
                },
                {
                  key: 'backends',
                  label: `${t('Backends')} (${filteredBackends.length})`,
                  children: (
                    <Table<HaproxyStatRow>
                      rowKey="key"
                      size="small"
                      loading={loading}
                      columns={backendColumns}
                      dataSource={filteredBackends}
                      scroll={{ x: 960 }}
                      pagination={{ pageSize: 20, hideOnSinglePage: true }}
                    />
                  ),
                },
                {
                  key: 'frontends',
                  label: `${t('Frontends')} (${filteredFrontends.length})`,
                  children: (
                    <Table<HaproxyStatRow>
                      rowKey="key"
                      size="small"
                      loading={loading}
                      columns={frontendColumns}
                      dataSource={filteredFrontends}
                      scroll={{ x: 960 }}
                      pagination={{ pageSize: 20, hideOnSinglePage: true }}
                    />
                  ),
                },
                {
                  key: 'runtimeMaps',
                  label: t('Runtime Maps & Stick Tables'),
                  children: (
                    <Row gutter={[16, 16]}>
                      <Col xs={24} lg={12}>
                        <Card
                          size="small"
                          title={t('Runtime Maps')}
                          extra={
                            <Space>
                              <Select
                                style={{ minWidth: 170 }}
                                aria-label={t('Select runtime map')}
                                value={selectedMap || undefined}
                                onChange={setSelectedMap}
                                options={runtimeMaps.map((m) => ({
                                  value: m.storage_name,
                                  label: m.storage_name,
                                }))}
                              />
                              {permissions?.canRuntime && selectedMap && (
                                <Button
                                  htmlType="button"
                                  size="small"
                                  type="primary"
                                  icon={<PlusOutlined aria-hidden="true" />}
                                  onClick={() => {
                                    mapEntryForm.resetFields();
                                    mapEntryForm.setFieldsValue({ forceSync: true });
                                    setMapEntryModalOpen(true);
                                  }}
                                >
                                  {t('Add Map Entry')}
                                </Button>
                              )}
                            </Space>
                          }
                        >
                          <Table<HaproxyRuntimeMapEntry>
                            rowKey={(r) => r.id ?? r.key}
                            size="small"
                            dataSource={mapEntries}
                            pagination={{ pageSize: 10, hideOnSinglePage: true }}
                            columns={[
                              { title: t('Key'), dataIndex: 'key', key: 'key' },
                              { title: t('Value'), dataIndex: 'value', key: 'value' },
                              ...(permissions?.canRuntime
                                ? [
                                    {
                                      title: t('Actions'),
                                      key: 'actions',
                                      render: (_v: unknown, row: HaproxyRuntimeMapEntry) => (
                                        <Button
                                          htmlType="button"
                                          size="small"
                                          danger
                                          aria-label={`${t('Delete')} ${row.key}`}
                                          onClick={() => handleDeleteMapEntry(row.id ?? row.key)}
                                        >
                                          {t('Delete')}
                                        </Button>
                                      ),
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        </Card>
                      </Col>

                      <Col xs={24} lg={12}>
                        <Card
                          size="small"
                          title={t('Stick Tables')}
                          extra={
                            <Select
                              style={{ minWidth: 180 }}
                              aria-label={t('Select stick table')}
                              value={selectedTable || undefined}
                              onChange={setSelectedTable}
                              options={stickTables.map((st) => ({
                                value: st.name,
                                label: `${st.name} (${st.used ?? 0}/${st.size ?? 0})`,
                              }))}
                            />
                          }
                        >
                          <Table<HaproxyStickTableEntry>
                            rowKey={(r) => r.id ?? String(r.key)}
                            size="small"
                            dataSource={tableEntries}
                            pagination={{ pageSize: 10, hideOnSinglePage: true }}
                            columns={[
                              { title: t('Key'), dataIndex: 'key', key: 'key' },
                              { title: 'Server ID', dataIndex: 'server_id', key: 'server_id' },
                              { title: t('Expiration (ms)'), dataIndex: 'exp', key: 'exp' },
                            ]}
                          />
                        </Card>
                      </Col>
                    </Row>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}

      <Modal
        open={Boolean(weightTarget)}
        title={
          weightTarget
            ? `${t('Update Server Weight')}: ${weightTarget.backendName}/${weightTarget.name}`
            : t('Update Server Weight')
        }
        okText={t('Apply')}
        cancelText={t('Cancel')}
        confirmLoading={weightSaving}
        onOk={handleSubmitWeight}
        onCancel={() => setWeightTarget(null)}
        destroyOnClose
      >
        <Form form={weightForm} layout="vertical">
          <Form.Item name="weight" label={t('Weight (0 - 256)')} rules={[{ required: true }]}>
            <InputNumber min={MIN_SERVER_WEIGHT} max={MAX_SERVER_WEIGHT} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={addSrvOpen}
        title={t('Add Runtime Server')}
        okText={t('Save')}
        cancelText={t('Cancel')}
        confirmLoading={addSrvSaving}
        onOk={handleAddRuntimeServer}
        onCancel={() => setAddSrvOpen(false)}
        destroyOnClose
      >
        <Form form={addSrvForm} layout="vertical">
          <Form.Item name="backend" label={t('Backend')} rules={[{ required: true }]}>
            <Select options={backendNames.map((b) => ({ value: b, label: b }))} />
          </Form.Item>
          <Form.Item name="name" label={t('Server')} rules={[{ required: true }]}>
            <Input autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Form.Item name="address" label={t('Address')} rules={[{ required: true }]}>
            <Input placeholder="10.0.1.25" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Form.Item name="port" label={t('Port')}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="weight" label={t('Weight (0 - 256)')}>
            <InputNumber min={MIN_SERVER_WEIGHT} max={MAX_SERVER_WEIGHT} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="check" label={t('Enable Health Check')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={mapEntryModalOpen}
        title={`${t('Add Map Entry')}: ${selectedMap}`}
        okText={t('Save')}
        cancelText={t('Cancel')}
        onOk={handleAddMapEntry}
        onCancel={() => setMapEntryModalOpen(false)}
        destroyOnClose
      >
        <Form form={mapEntryForm} layout="vertical">
          <Form.Item name="key" label={t('Key')} rules={[{ required: true }]}>
            <Input autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Form.Item name="value" label={t('Value')} rules={[{ required: true }]}>
            <Input autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Form.Item name="forceSync" label={t('Sync to disk immediately (force_sync)')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
};

export default HaproxyMonitorView;
