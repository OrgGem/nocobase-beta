import { Button, Input, Popconfirm, Select, Space, Switch, Table, Tag, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { RouteFormModal, RouteFormValues, RouteOption, CryptoKeyOption } from './RouteFormModal';
import { RouteUsageModal } from './RouteUsageModal';
import { TestRouteModal } from './TestRouteModal';

interface RouteRow {
  id: number;
  name: string;
  direction: 'inbound' | 'outbound';
  method: string;
  inboundPath?: string;
  targetUrl: string;
  partnerId?: number | null;
  description?: string;
  enabled: boolean;
  authMode?: 'both' | 'api-key' | 'role';
  encryptionMode: 'none' | 'aes-256-gcm' | 'pgp' | 'rsa-oaep';
  wireFormat: 'binary' | 'json';
  aesSecret?: string;
  aesSecretEnvVar?: string;
  pgpEncryptKeyName?: string;
  pgpDecryptKeyName?: string;
  pgpSignKeyName?: string;
  pgpVerifyKeyName?: string;
  rsaEncryptKeyName?: string;
  rsaDecryptKeyName?: string;
  responseEncrypted?: boolean;
  hmacSignEnabled?: boolean;
  hmacVerifyEnabled?: boolean;
  hmacSecret?: string;
  hmacSecretEnvVar?: string;
  hmacToleranceSec?: number;
  jwtSignEnabled?: boolean;
  jwtSignAlgorithm?: 'RS256' | 'HS256';
  jwtSignKeyName?: string;
  jwtVerifyEnabled?: boolean;
  jwtVerifyKeyName?: string;
  jwtSecret?: string;
  jwtSecretEnvVar?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  jwtExpiresInSec?: number;
  rateLimitEnabled?: boolean;
  rateLimitMax?: number;
  rateLimitWindowSec?: number;
  ipAllowlist?: string[];
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  maxBodyMb: number;
  logPayloads: boolean;
  forwardHeaders?: string[];
  forwardResponseHeaders?: string[];
  staticHeaders?: { name: string; value: string }[];
}

const ENCRYPTION_COLORS: Record<string, string> = {
  none: 'default',
  'aes-256-gcm': 'blue',
  pgp: 'purple',
  'rsa-oaep': 'cyan',
};

export const RoutesPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [rows, setRows] = useState<RouteRow[]>([]);
  const [partners, setPartners] = useState<RouteOption[]>([]);
  const [cryptoKeys, setCryptoKeys] = useState<CryptoKeyOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<RouteRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [testRoute, setTestRoute] = useState<RouteRow | null>(null);
  const [usageRoute, setUsageRoute] = useState<RouteRow | null>(null);
  const [search, setSearch] = useState('');
  const [directionFilter, setDirectionFilter] = useState<'inbound' | 'outbound' | 'all'>('all');
  const [encryptionFilter, setEncryptionFilter] = useState<string>('all');

  const load = useCallback(async () => {
    setLoading(true);
    // allSettled: partners/keys feed the form modal only, so their failure
    // should not blank out the routes table.
    const [routesRes, partnersRes, keysRes] = await Promise.allSettled([
      api.request({ url: 'apiRoutes:list', params: { paginate: false, sort: ['-createdAt'] } }),
      api.request({ url: 'apiPartners:list', params: { paginate: false } }),
      api.request({ url: 'cryptoKeys:list', params: { paginate: false } }),
    ]);
    if (routesRes.status === 'fulfilled') {
      setRows((routesRes.value?.data?.data ?? []) as RouteRow[]);
    } else {
      setRows([]);
      message.error(getErrorMessage(routesRes.reason, t('Failed to load routes') as string));
    }
    setPartners(partnersRes.status === 'fulfilled' ? ((partnersRes.value?.data?.data ?? []) as RouteOption[]) : []);
    setCryptoKeys(keysRes.status === 'fulfilled' ? ((keysRes.value?.data?.data ?? []) as CryptoKeyOption[]) : []);
    setLoading(false);
  }, [api, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (record: RouteRow) => {
    setEditing(record);
    setModalOpen(true);
  };

  const onSave = async (values: RouteFormValues) => {
    setSaving(true);
    try {
      if (editing) {
        await api.request({
          url: 'apiRoutes:update',
          method: 'post',
          params: { filterByTk: editing.id },
          data: values,
        });
      } else {
        await api.request({ url: 'apiRoutes:create', method: 'post', data: values });
      }
      message.success(t('Route saved') as string);
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save route') as string));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: number) => {
    try {
      await api.request({ url: 'apiRoutes:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('Route deleted') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete route') as string));
    }
  };

  const onToggleEnabled = async (record: RouteRow, enabled: boolean) => {
    try {
      await api.request({
        url: 'apiRoutes:update',
        method: 'post',
        params: { filterByTk: record.id },
        data: { enabled },
      });
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save route') as string));
    }
  };

  const partnerName = (id?: number | null) => partners.find((p) => p.id === id)?.name;

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (directionFilter !== 'all' && row.direction !== directionFilter) return false;
      if (encryptionFilter !== 'all' && row.encryptionMode !== encryptionFilter) return false;
      if (!q) return true;
      return (
        row.name.toLowerCase().includes(q) ||
        (row.inboundPath ?? '').toLowerCase().includes(q) ||
        (row.targetUrl ?? '').toLowerCase().includes(q) ||
        (row.description ?? '').toLowerCase().includes(q) ||
        (partnerName(row.partnerId) ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, directionFilter, encryptionFilter, partners]);

  const columns = [
    {
      title: t('Name') as string,
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      sorter: (a: RouteRow, b: RouteRow) => a.name.localeCompare(b.name),
    },
    {
      title: t('Direction') as string,
      dataIndex: 'direction',
      key: 'direction',
      render: (direction: string) => (
        <Tag color={direction === 'inbound' ? 'green' : 'geekblue'}>
          {direction === 'inbound' ? t('Inbound') : t('Outbound')}
        </Tag>
      ),
    },
    {
      title: t('Method') as string,
      dataIndex: 'method',
      key: 'method',
      sorter: (a: RouteRow, b: RouteRow) => a.method.localeCompare(b.method),
    },
    {
      title: t('Path / Target') as string,
      key: 'target',
      ellipsis: true,
      render: (_: unknown, record: RouteRow) =>
        record.direction === 'inbound' ? `/api/apim/inbound/${record.inboundPath ?? ''}` : record.targetUrl,
    },
    {
      title: t('Partner') as string,
      key: 'partner',
      render: (_: unknown, record: RouteRow) => partnerName(record.partnerId) ?? '-',
    },
    {
      title: t('Encryption') as string,
      dataIndex: 'encryptionMode',
      key: 'encryptionMode',
      render: (mode: string) => <Tag color={ENCRYPTION_COLORS[mode] ?? 'default'}>{mode}</Tag>,
    },
    {
      title: t('Auth') as string,
      dataIndex: 'authMode',
      key: 'authMode',
      render: (mode: string) => {
        const label = mode === 'api-key' ? 'API Key' : mode === 'role' ? 'Role' : 'Both';
        return <Tag color={mode === 'role' ? 'purple' : mode === 'api-key' ? 'blue' : 'cyan'}>{label}</Tag>;
      },
    },
    {
      title: t('Enabled') as string,
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean, record: RouteRow) => (
        <Switch size="small" checked={enabled} onChange={(v) => onToggleEnabled(record, v)} />
      ),
    },
    {
      title: t('Actions') as string,
      key: 'actions',
      render: (_: unknown, record: RouteRow) => (
        <Space>
          <Button size="small" onClick={() => setUsageRoute(record)}>
            {t('Usage')}
          </Button>
          <Button size="small" onClick={() => setTestRoute(record)}>
            {t('Test')}
          </Button>
          <Button size="small" onClick={() => openEdit(record)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete') + '?'} onConfirm={() => onDelete(record.id)}>
            <Button size="small" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          allowClear
          placeholder={t('Search routes') as string}
          style={{ width: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          value={directionFilter}
          onChange={setDirectionFilter}
          style={{ width: 140 }}
          options={[
            { value: 'all', label: t('All') as string },
            { value: 'inbound', label: t('Inbound') as string },
            { value: 'outbound', label: t('Outbound') as string },
          ]}
        />
        <Select
          value={encryptionFilter}
          onChange={setEncryptionFilter}
          style={{ width: 160 }}
          options={[
            { value: 'all', label: t('All Encryption') as string },
            { value: 'none', label: 'none' },
            { value: 'aes-256-gcm', label: 'aes-256-gcm' },
            { value: 'pgp', label: 'pgp' },
            { value: 'rsa-oaep', label: 'rsa-oaep' },
          ]}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Create Route')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={load}>
          {t('Refresh')}
        </Button>
      </Space>
      <div style={{ overflowX: 'auto' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filteredRows}
          loading={loading}
          pagination={false}
          scroll={{ x: 1200 }}
        />
      </div>
      <RouteFormModal
        open={modalOpen}
        initial={editing}
        partners={partners}
        cryptoKeys={cryptoKeys}
        saving={saving}
        onSubmit={onSave}
        onCancel={() => setModalOpen(false)}
      />
      <TestRouteModal route={testRoute} onClose={() => setTestRoute(null)} />
      <RouteUsageModal route={usageRoute} onClose={() => setUsageRoute(null)} />
    </div>
  );
};

export default RoutesPage;
