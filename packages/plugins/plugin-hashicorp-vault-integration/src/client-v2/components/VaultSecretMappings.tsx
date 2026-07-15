import {
  ArrowLeftOutlined,
  CopyOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  KeyOutlined,
  PlusOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import {
  AutoComplete,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';

interface VaultConnectionOption {
  id: number;
  name: string;
  title?: string;
  enabled: boolean;
}

interface VaultSecretMapping {
  id: number;
  connectionId: number;
  connection?: VaultConnectionOption;
  variableKey: string;
  secretPath: string;
  secretKey: string;
  exposeToClient: boolean;
  syncToEnv: boolean;
  lastSyncedAt?: string;
  lastError?: string;
}

interface MappingFormValues {
  connectionId: number;
  variableKey: string;
  secretPath: string;
  secretKey: string;
  exposeToClient: boolean;
  syncToEnv: boolean;
}

interface VaultPathEntry {
  name: string;
  path: string;
  isFolder: boolean;
}

function getErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { errors?: { message?: string }[] } }; message?: string };
  return e?.response?.data?.errors?.[0]?.message || e?.message || fallback;
}

export const VaultSecretMappings: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const [mappings, setMappings] = useState<VaultSecretMapping[]>([]);
  const [connections, setConnections] = useState<VaultConnectionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<VaultSecretMapping | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState('');
  const [browserEntries, setBrowserEntries] = useState<VaultPathEntry[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [form] = Form.useForm<MappingFormValues>();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [mappingRes, connectionRes] = await Promise.all([
        api.request({
          url: 'vaultSecretMappings:list',
          params: { pageSize: 100, sort: ['variableKey'], appends: ['connection'] },
        }),
        api.request({ url: 'vaultConnections:list', params: { pageSize: 100, sort: ['id'] } }),
      ]);
      setMappings(mappingRes?.data?.data || []);
      setConnections(connectionRes?.data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadData().catch(() => undefined);
  }, [loadData]);

  const handleSave = async () => {
    const values = await form.validateFields();
    try {
      if (editing) {
        await api.request({
          url: 'vaultSecretMappings:update',
          method: 'post',
          params: { filterByTk: editing.id },
          data: values,
        });
        message.success(t('Mapping updated'));
      } else {
        await api.request({ url: 'vaultSecretMappings:create', method: 'post', data: values });
        message.success(t('Mapping added'));
      }
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      await loadData();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const handleDelete = async (id: number) => {
    await api.request({ url: 'vaultSecretMappings:destroy', method: 'post', params: { filterByTk: id } });
    message.success(t('Deleted'));
    await loadData();
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      await api.request({ url: 'vault:syncNow', method: 'post' });
      message.success(t('Sync completed'));
    } catch (err) {
      message.error(getErrorMessage(err, t('Sync failed') as string));
    } finally {
      setSyncing(false);
      await loadData();
    }
  };

  const handleToggle = async (record: VaultSecretMapping, field: 'exposeToClient' | 'syncToEnv', checked: boolean) => {
    try {
      await api.request({
        url: 'vaultSecretMappings:update',
        method: 'post',
        params: { filterByTk: record.id },
        data: { [field]: checked },
      });
      await loadData();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const loadPath = async (connectionId: number, path: string) => {
    setBrowserLoading(true);
    try {
      const res = await api.request({
        url: 'vaultConnections:listPaths',
        method: 'post',
        params: { filterByTk: connectionId, path },
      });
      setBrowserPath(path);
      setBrowserEntries(res?.data?.data?.entries || []);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to list Vault paths') as string));
    } finally {
      setBrowserLoading(false);
    }
  };

  const loadSecretKeys = async (connectionId: number, path: string) => {
    if (!path) return;
    setKeysLoading(true);
    try {
      const res = await api.request({
        url: 'vaultConnections:listSecretKeys',
        method: 'post',
        params: { filterByTk: connectionId, path },
      });
      setSecretKeys(res?.data?.data?.keys || []);
    } catch (err) {
      setSecretKeys([]);
      message.error(getErrorMessage(err, t('Failed to list secret keys') as string));
    } finally {
      setKeysLoading(false);
    }
  };

  const openPathBrowser = async () => {
    const connectionId = form.getFieldValue('connectionId');
    if (!connectionId) {
      message.warning(t('Select a connection first'));
      return;
    }
    const currentSecretPath = form.getFieldValue('secretPath') || '';
    const currentPath = currentSecretPath.split('/').slice(0, -1).join('/');
    setBrowserOpen(true);
    await loadPath(connectionId, currentPath);
  };

  const selectBrowserEntry = async (entry: VaultPathEntry) => {
    const connectionId = form.getFieldValue('connectionId');
    if (entry.isFolder) {
      await loadPath(connectionId, entry.path);
      return;
    }
    form.setFieldValue('secretPath', entry.path);
    form.setFieldValue('secretKey', undefined);
    setBrowserOpen(false);
    await loadSecretKeys(connectionId, entry.path);
  };

  const copyVariable = async (variableKey: string) => {
    try {
      await navigator.clipboard.writeText(`{{$vault.${variableKey}}}`);
      message.success(t('Copied'));
    } catch {
      message.error(t('Copy failed'));
    }
  };

  const columns = [
    {
      title: t('Variable Key'),
      dataIndex: 'variableKey',
      key: 'variableKey',
      render: (key: string) => (
        <Space size={4}>
          <code>{`{{$vault.${key}}}`}</code>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            aria-label={t('Copy variable') as string}
            onClick={() => copyVariable(key)}
          />
        </Space>
      ),
    },
    {
      title: t('Connection'),
      key: 'connection',
      width: 140,
      render: (_: unknown, record: VaultSecretMapping) =>
        record.connection?.title || record.connection?.name || record.connectionId,
    },
    {
      title: t('Secret'),
      key: 'secret',
      ellipsis: true,
      render: (_: unknown, record: VaultSecretMapping) => `${record.secretPath} # ${record.secretKey}`,
    },
    {
      title: (
        <Tooltip title={t('Allow resolving this variable from the client for logged-in users')}>{t('Client')}</Tooltip>
      ),
      dataIndex: 'exposeToClient',
      key: 'exposeToClient',
      width: 90,
      render: (v: boolean, record: VaultSecretMapping) => (
        <Switch
          size="small"
          checked={!!v}
          aria-label={t('Expose to client') as string}
          onChange={(checked) => handleToggle(record, 'exposeToClient', checked)}
        />
      ),
    },
    {
      title: (
        <Tooltip title={t('Push value into $env on every sync')}>
          <span>$env</span>
        </Tooltip>
      ),
      dataIndex: 'syncToEnv',
      key: 'syncToEnv',
      width: 80,
      render: (v: boolean, record: VaultSecretMapping) => (
        <Switch
          size="small"
          checked={!!v}
          aria-label={t('Sync to $env') as string}
          onChange={(checked) => handleToggle(record, 'syncToEnv', checked)}
        />
      ),
    },
    {
      title: t('Last Synced'),
      dataIndex: 'lastSyncedAt',
      key: 'lastSyncedAt',
      width: 160,
      render: (v?: string) => (v ? new Date(v).toLocaleString() : '-'),
    },
    {
      title: t('Status'),
      key: 'status',
      width: 100,
      render: (_: unknown, record: VaultSecretMapping) => {
        if (record.lastError) {
          return (
            <Tooltip title={record.lastError}>
              <Tag color="red">{t('Error')}</Tag>
            </Tooltip>
          );
        }
        if (record.lastSyncedAt) {
          return <Tag color="green">{t('Synced')}</Tag>;
        }
        return <Tag>{t('Pending')}</Tag>;
      },
    },
    {
      title: '',
      key: 'actions',
      width: 130,
      render: (_: unknown, record: VaultSecretMapping) => (
        <Space size="small">
          <Button
            size="small"
            onClick={() => {
              setEditing(record);
              form.setFieldsValue(record);
              setModalOpen(true);
            }}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this mapping?')} onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('Delete') as string} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Space>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              form.resetFields();
              setModalOpen(true);
            }}
          >
            {t('Add Mapping')}
          </Button>
          <Button icon={<SyncOutlined />} loading={syncing} onClick={handleSyncNow}>
            {t('Sync now')}
          </Button>
        </Space>
      </div>

      <Table dataSource={mappings} columns={columns} rowKey="id" size="small" loading={loading} pagination={false} />

      <Modal
        title={editing ? t('Edit Mapping') : t('Add Mapping')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={{ exposeToClient: false, syncToEnv: false }}>
          <Form.Item name="connectionId" label={t('Connection')} rules={[{ required: true }]}>
            <Select
              placeholder={t('Select a connection') as string}
              options={connections.map((c) => ({ value: c.id, label: c.title || c.name }))}
              notFoundContent={t('No connection available')}
              onChange={() => {
                form.setFieldValue('secretPath', undefined);
                form.setFieldValue('secretKey', undefined);
                setSecretKeys([]);
              }}
            />
          </Form.Item>
          <Form.Item
            name="variableKey"
            label={t('Variable Key')}
            extra={
              <span>
                {t('Usable as')} <code>{'{{$vault.KEY}}'}</code>
              </span>
            }
            rules={[
              { required: true },
              {
                pattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
                message: t('Use letters, digits and underscores, not starting with a digit') as string,
              },
            ]}
          >
            <Input placeholder="DB_PASSWORD" />
          </Form.Item>
          <Form.Item
            name="secretPath"
            label={t('Secret Path')}
            extra={t('Path under the KV mount, e.g. apps/billing')}
            rules={[{ required: true }]}
          >
            <Input
              placeholder="apps/billing"
              addonAfter={
                <Button
                  type="text"
                  size="small"
                  icon={<FolderOpenOutlined />}
                  aria-label={t('Browse Vault paths') as string}
                  onClick={openPathBrowser}
                >
                  {t('Browse')}
                </Button>
              }
              onBlur={(event) => {
                const connectionId = form.getFieldValue('connectionId');
                if (connectionId && event.target.value) loadSecretKeys(connectionId, event.target.value);
              }}
            />
          </Form.Item>
          <Form.Item name="secretKey" label={t('Secret Key')} rules={[{ required: true }]}>
            <AutoComplete
              showSearch
              placeholder={t('Select or enter a secret key') as string}
              options={secretKeys.map((key) => ({ value: key, label: key }))}
              notFoundContent={keysLoading ? t('Loading') : t('Enter the key manually')}
            />
          </Form.Item>
          <Form.Item
            name="exposeToClient"
            label={t('Expose to client')}
            valuePropName="checked"
            extra={t('Allow resolving this variable from the client for logged-in users')}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="syncToEnv"
            label={t('Sync to $env')}
            valuePropName="checked"
            extra={t('Push value into $env on every sync')}
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('Browse Vault paths')}
        open={browserOpen}
        footer={null}
        onCancel={() => setBrowserOpen(false)}
        width={620}
      >
        <Space style={{ marginBottom: 12 }}>
          <Button
            icon={<ArrowLeftOutlined />}
            disabled={!browserPath || browserLoading}
            onClick={() => {
              const connectionId = form.getFieldValue('connectionId');
              const parentPath = browserPath.split('/').slice(0, -1).join('/');
              loadPath(connectionId, parentPath);
            }}
          >
            {t('Up')}
          </Button>
          <code>/{browserPath}</code>
        </Space>
        <Table<VaultPathEntry>
          rowKey="path"
          size="small"
          loading={browserLoading}
          pagination={false}
          dataSource={browserEntries}
          locale={{ emptyText: t('No paths found') as string }}
          columns={[
            {
              title: t('Name'),
              dataIndex: 'name',
              render: (name: string, entry: VaultPathEntry) => (
                <Button
                  type="link"
                  icon={entry.isFolder ? <FolderOutlined /> : <KeyOutlined />}
                  onClick={() => selectBrowserEntry(entry)}
                >
                  {name}
                  {entry.isFolder ? '/' : ''}
                </Button>
              ),
            },
            {
              title: t('Type'),
              dataIndex: 'isFolder',
              width: 120,
              render: (isFolder: boolean) => (isFolder ? t('Folder') : t('Secret')),
            },
          ]}
        />
      </Modal>
    </div>
  );
};

export default VaultSecretMappings;
