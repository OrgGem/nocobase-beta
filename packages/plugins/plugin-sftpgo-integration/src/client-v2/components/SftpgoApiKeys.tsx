import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { useSftpgoTabVisibility } from '../hooks/useSftpgoTabVisibility';

interface SftpgoConnectionOption {
  id: number;
  name: string;
  title?: string;
}

interface SftpgoUserOption {
  username: string;
}

interface SftpgoApiKey {
  id: string;
  name: string;
  key?: string;
  maskedKey?: string | null;
  scope: number;
  admin?: string;
  user?: string;
  description?: string;
  expires_at?: number;
  last_use_at?: number;
}

interface ApiKeyFormValues {
  name: string;
  scope: number;
  admin?: string;
  user?: string;
  description?: string;
  expires_at?: number;
}

export const SftpgoApiKeys: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const [connections, setConnections] = useState<SftpgoConnectionOption[]>([]);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [apiKeys, setApiKeys] = useState<SftpgoApiKey[]>([]);
  const [userOptions, setUserOptions] = useState<SftpgoUserOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SftpgoApiKey | null>(null);
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const [form] = Form.useForm<ApiKeyFormValues>();
  const scope = Form.useWatch('scope', form);

  useSftpgoTabVisibility();

  const loadConnections = useCallback(async () => {
    const res = await api.request({
      url: 'sftpgoConnections:list',
      params: { filter: { enabled: true }, pageSize: 100, sort: ['id'] },
    });
    const list = (res?.data?.data || []) as SftpgoConnectionOption[];
    setConnections(list);
    setConnectionId((current) => current ?? list[0]?.id ?? null);
  }, [api]);

  useEffect(() => {
    loadConnections().catch(() => undefined);
  }, [loadConnections]);

  const loadApiKeys = useCallback(
    async (connId: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.request({ url: 'sftpgoApiKeys:list', params: { connectionId: connId, limit: 100 } });
        setApiKeys((res?.data?.data || []) as SftpgoApiKey[]);
      } catch (err) {
        setError(getErrorMessage(err, t('Failed to load API keys') as string));
        setApiKeys([]);
      } finally {
        setLoading(false);
      }
    },
    [api, t],
  );

  useEffect(() => {
    if (connectionId) loadApiKeys(connectionId).catch(() => undefined);
    else setApiKeys([]);
  }, [connectionId, loadApiKeys]);

  const loadUserOptions = useCallback(
    async (connId: number) => {
      setUsersLoading(true);
      setUsersError(false);
      try {
        const res = await api.request({ url: 'sftpgoUsers:list', params: { connectionId: connId, limit: 500 } });
        const data = res?.data?.data as unknown;
        setUserOptions(Array.isArray(data) ? (data as SftpgoUserOption[]) : []);
      } catch {
        setUserOptions([]);
        setUsersError(true);
      } finally {
        setUsersLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (scope === 2 && connectionId) {
      loadUserOptions(connectionId).catch(() => undefined);
      return;
    }
    setUserOptions([]);
    setUsersError(false);
  }, [connectionId, loadUserOptions, scope]);

  const handleSave = async () => {
    if (!connectionId) return;
    const values = await form.validateFields();
    const payload: Record<string, unknown> = {
      name: values.name,
      description: values.description,
      scope: values.scope,
      admin: values.scope === 1 ? values.admin : undefined,
      user: values.scope === 2 ? values.user : undefined,
      expires_at: values.expires_at ?? 0,
    };
    try {
      if (editing) {
        await api.request({
          url: 'sftpgoApiKeys:update',
          method: 'post',
          params: { connectionId, filterByTk: editing.id },
          data: payload,
        });
        message.success(t('API key updated'));
        setModalOpen(false);
        setEditing(null);
        form.resetFields();
      } else {
        const res = await api.request({
          url: 'sftpgoApiKeys:create',
          method: 'post',
          params: { connectionId },
          data: payload,
        });
        const created = res?.data?.data as SftpgoApiKey | undefined;
        setModalOpen(false);
        setEditing(null);
        form.resetFields();
        message.success(t('API key added'));
        if (created?.key) setRevealKey(created.key);
      }
      await loadApiKeys(connectionId);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const handleDelete = async (id: string) => {
    if (!connectionId) return;
    try {
      await api.request({ url: 'sftpgoApiKeys:destroy', method: 'post', params: { connectionId, filterByTk: id } });
      message.success(t('Deleted'));
      await loadApiKeys(connectionId);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete') as string));
    }
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    {
      title: t('Stored API Key'),
      dataIndex: 'maskedKey',
      key: 'maskedKey',
      render: (value?: string | null) => value || '-',
    },
    { title: t('Description'), dataIndex: 'description', key: 'description', ellipsis: true },
    {
      title: t('Scope'),
      dataIndex: 'scope',
      key: 'scope',
      width: 90,
      render: (v: number) => (v === 1 ? t('Admin') : t('User')),
    },
    {
      title: t('Target'),
      key: 'target',
      render: (_: unknown, record: SftpgoApiKey) => record.admin || record.user || '-',
    },
    {
      title: t('Expires At'),
      dataIndex: 'expires_at',
      key: 'expires_at',
      render: (v?: number) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : t('Never')),
    },
    {
      title: t('Last Used'),
      dataIndex: 'last_use_at',
      key: 'last_use_at',
      render: (v?: number) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '',
      key: 'actions',
      width: 160,
      render: (_: unknown, record: SftpgoApiKey) => (
        <Space size="small">
          <Button
            size="small"
            onClick={() => {
              setEditing(record);
              form.setFieldsValue({
                name: record.name,
                scope: record.scope,
                admin: record.admin,
                user: record.user,
                description: record.description,
                expires_at: record.expires_at,
              });
              setModalOpen(true);
            }}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this API key?')} onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('Delete') as string} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select
          style={{ width: 240 }}
          placeholder={t('Select a connection')}
          value={connectionId ?? undefined}
          onChange={(value) => setConnectionId(value)}
          options={connections.map((c) => ({ value: c.id, label: c.title || c.name }))}
          notFoundContent={t('No connection available')}
        />
        {connectionId && (
          <>
            <Button icon={<ReloadOutlined />} onClick={() => loadApiKeys(connectionId)}>
              {t('Refresh')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                form.resetFields();
                setModalOpen(true);
              }}
            >
              {t('Add API Key')}
            </Button>
          </>
        )}
      </Space>

      {!connectionId && connections.length === 0 && (
        <Alert
          type="info"
          showIcon
          message={t('No enabled connection yet')}
          description={t('Go to the Connections tab to create and enable one before managing API keys.')}
          style={{ marginBottom: 16 }}
        />
      )}

      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />}

      <Table dataSource={apiKeys} columns={columns} rowKey="id" size="small" loading={loading} pagination={false} />

      <Modal
        title={editing ? t('Edit API Key') : t('Add API Key')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        width={480}
      >
        <Form form={form} layout="vertical" initialValues={{ scope: 1 }}>
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input />
          </Form.Item>
          <Form.Item name="scope" label={t('Scope')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 1, label: t('Admin') },
                { value: 2, label: t('User') },
              ]}
            />
          </Form.Item>
          {scope === 2 ? (
            <Form.Item
              name="user"
              label={t('User')}
              extra={t('Bind this key to a specific SFTPGo user')}
              rules={[{ required: true }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                loading={usersLoading}
                placeholder={t('Select a user')}
                notFoundContent={t(usersError ? 'Failed to load users' : 'No users available')}
                options={userOptions.map((item) => ({ value: item.username, label: item.username }))}
              />
            </Form.Item>
          ) : (
            <Form.Item name="admin" label={t('Admin')} extra={t('Leave empty to bind this key to any admin')}>
              <Input placeholder="admin" />
            </Form.Item>
          )}
          <Form.Item
            name="expires_at"
            label={t('Expires At')}
            getValueProps={(value?: number) => ({ value: value ? dayjs(value) : undefined })}
            normalize={(value: dayjs.Dayjs | null) => (value ? value.valueOf() : 0)}
            extra={t('Leave empty for a key that never expires')}
          >
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('API Key Created')}
        open={!!revealKey}
        onCancel={() => setRevealKey(null)}
        width={520}
        footer={[
          <Button key="close" type="primary" onClick={() => setRevealKey(null)}>
            {t('Close')}
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="warning" showIcon message={t('Copy this key now. SFTPGo will not show it again.')} />
          <Typography.Text code copyable style={{ wordBreak: 'break-all' }}>
            {revealKey}
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  );
};

export default SftpgoApiKeys;
