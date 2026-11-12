// SPDX-License-Identifier: Apache-2.0

import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import {
  Alert,
  AutoComplete,
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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

const PAGE_SIZE = 50;

interface SftpgoConnectionOption {
  id: number;
  name: string;
  title?: string;
  authMethod?: 'admin' | 'apikey';
}

interface SftpgoUserOption {
  username: string;
}

interface SftpgoApiKey {
  id: string;
  name: string;
  key?: string;
  keyStorageWarning?: boolean;
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
  const connectionIdRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const pageRef = useRef(0);
  const usersRequestIdRef = useRef(0);
  const modalIdRef = useRef(0);
  const modalConnectionIdRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const [apiKeys, setApiKeys] = useState<SftpgoApiKey[]>([]);
  const [apiKeysConnectionId, setApiKeysConnectionId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [userOptions, setUserOptions] = useState<SftpgoUserOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<SftpgoApiKey | null>(null);
  const [revealKeys, setRevealKeys] = useState<{ key: string; storageWarning: boolean }[]>([]);
  const revealKey = revealKeys[0];
  const [form] = Form.useForm<ApiKeyFormValues>();
  const scope = Form.useWatch('scope', form);

  const selectConnection = useCallback((id: number) => {
    connectionIdRef.current = id;
    requestIdRef.current += 1;
    pageRef.current = 0;
    usersRequestIdRef.current += 1;
    modalIdRef.current += 1;
    modalConnectionIdRef.current = null;
    setConnectionId(id);
    setApiKeys([]);
    setApiKeysConnectionId(null);
    setPage(0);
    setHasNextPage(false);
    setUserOptions([]);
    setUsersLoading(false);
    setUsersError(false);
    setLoading(false);
    setError(null);
    setModalOpen(false);
    setEditing(null);
  }, []);

  const selectPage = useCallback((nextPage: number) => {
    pageRef.current = nextPage;
    requestIdRef.current += 1;
    setPage(nextPage);
    setApiKeys([]);
    setApiKeysConnectionId(null);
    setHasNextPage(false);
    setLoading(true);
    setError(null);
  }, []);

  const loadConnections = useCallback(async () => {
    const res = await api.request({
      url: 'sftpgoConnections:list',
      params: {
        filter: { enabled: true },
        fields: ['id', 'name', 'title', 'authMethod'],
        paginate: false,
        sort: ['id'],
      },
    });
    const list = (res?.data?.data || []) as SftpgoConnectionOption[];
    setConnections(list);
    const firstCompatible = list.find((connection) => connection.authMethod !== 'apikey');
    if (connectionIdRef.current === null && firstCompatible) selectConnection(firstCompatible.id);
  }, [api, selectConnection]);

  useEffect(() => {
    loadConnections().catch(() => undefined);
  }, [loadConnections]);

  const loadApiKeys = useCallback(
    async (connId: number, pageNumber: number) => {
      if (connId !== connectionIdRef.current || pageNumber !== pageRef.current) return;
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.request({
          url: 'sftpgoApiKeys:list',
          params: { connectionId: connId, limit: PAGE_SIZE + 1, offset: pageNumber * PAGE_SIZE },
        });
        if (
          requestIdRef.current === requestId &&
          connectionIdRef.current === connId &&
          pageRef.current === pageNumber
        ) {
          const items = (res?.data?.data || []) as SftpgoApiKey[];
          if (items.length === 0 && pageNumber > 0) {
            selectPage(pageNumber - 1);
            return;
          }
          setApiKeys(items.slice(0, PAGE_SIZE));
          setHasNextPage(items.length > PAGE_SIZE);
          setApiKeysConnectionId(connId);
        }
      } catch (err) {
        if (requestIdRef.current === requestId && connectionIdRef.current === connId) {
          setError(getErrorMessage(err, t('Failed to load API keys') as string));
          setApiKeys([]);
          setApiKeysConnectionId(null);
          setHasNextPage(false);
        }
      } finally {
        if (requestIdRef.current === requestId && connectionIdRef.current === connId) setLoading(false);
      }
    },
    [api, selectPage, t],
  );

  useEffect(() => {
    if (connectionId) loadApiKeys(connectionId, page).catch(() => undefined);
    else setApiKeys([]);
  }, [connectionId, loadApiKeys, page]);

  const loadUserOptions = useCallback(
    async (connId: number) => {
      if (connId !== connectionIdRef.current) return;
      const requestId = ++usersRequestIdRef.current;
      setUsersLoading(true);
      setUsersError(false);
      try {
        const res = await api.request({ url: 'sftpgoUsers:list', params: { connectionId: connId, limit: 500 } });
        const data = res?.data?.data as unknown;
        if (usersRequestIdRef.current === requestId && connectionIdRef.current === connId) {
          setUserOptions(Array.isArray(data) ? (data as SftpgoUserOption[]) : []);
        }
      } catch {
        if (usersRequestIdRef.current === requestId && connectionIdRef.current === connId) {
          setUserOptions([]);
          setUsersError(true);
        }
      } finally {
        if (usersRequestIdRef.current === requestId && connectionIdRef.current === connId) setUsersLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (scope === 2 && connectionId) {
      loadUserOptions(connectionId).catch(() => undefined);
      return () => {
        usersRequestIdRef.current += 1;
      };
    }
    usersRequestIdRef.current += 1;
    setUserOptions([]);
    setUsersLoading(false);
    setUsersError(false);
  }, [connectionId, loadUserOptions, scope]);

  const handleSave = async () => {
    const targetConnectionId = modalConnectionIdRef.current;
    const modalId = modalIdRef.current;
    if (!targetConnectionId || targetConnectionId !== connectionIdRef.current || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      let values: ApiKeyFormValues;
      try {
        values = await form.validateFields();
      } catch {
        return;
      }
      if (targetConnectionId !== connectionIdRef.current || modalId !== modalIdRef.current) return;
      const payload: Record<string, unknown> = {
        name: values.name,
        description: values.description,
        scope: values.scope,
        ...(values.scope === 1 ? { admin: values.admin } : { user: values.user ?? '' }),
        expires_at: values.expires_at ?? 0,
      };
      if (editing && values.scope === editing.scope) {
        const bindingUnchanged =
          values.scope === 2
            ? (values.user ?? '') === (editing.user ?? '')
            : (values.admin ?? '') === (editing.admin ?? '');
        if (bindingUnchanged) {
          delete payload.scope;
          if (values.scope === 2) delete payload.user;
          else delete payload.admin;
        }
      }
      if (editing) {
        await api.request({
          url: 'sftpgoApiKeys:update',
          method: 'post',
          params: { connectionId: targetConnectionId, filterByTk: editing.id },
          data: payload,
        });
        message.success(t('API key updated'));
      } else {
        const res = await api.request({
          url: 'sftpgoApiKeys:create',
          method: 'post',
          params: { connectionId: targetConnectionId },
          data: payload,
        });
        const created = res?.data?.data as SftpgoApiKey | undefined;
        message.success(t('API key added'));
        if (created?.key) {
          const key = created.key;
          setRevealKeys((current) => [...current, { key, storageWarning: !!created.keyStorageWarning }]);
        }
      }
      if (modalId === modalIdRef.current) {
        setModalOpen(false);
        setEditing(null);
        form.resetFields();
      }
      await loadApiKeys(targetConnectionId, pageRef.current);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, targetConnectionId: number | null) => {
    if (!targetConnectionId || targetConnectionId !== connectionIdRef.current) return;
    try {
      await api.request({
        url: 'sftpgoApiKeys:destroy',
        method: 'post',
        params: { connectionId: targetConnectionId, filterByTk: id },
      });
      message.success(t('Deleted'));
      await loadApiKeys(targetConnectionId, pageRef.current);
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
              if (!apiKeysConnectionId || apiKeysConnectionId !== connectionIdRef.current) return;
              modalIdRef.current += 1;
              modalConnectionIdRef.current = apiKeysConnectionId;
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
          <Popconfirm title={t('Delete this API key?')} onConfirm={() => handleDelete(record.id, apiKeysConnectionId)}>
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
          onChange={selectConnection}
          options={connections.map((c) => ({
            value: c.id,
            disabled: c.authMethod === 'apikey',
            title:
              c.authMethod === 'apikey'
                ? (t('API key management requires an admin-authenticated connection') as string)
                : c.title || c.name,
            label:
              c.authMethod === 'apikey'
                ? `${c.title || c.name} — ${t('API key management requires an admin-authenticated connection')}`
                : c.title || c.name,
          }))}
          notFoundContent={t('No connection available')}
        />
        {connectionId && (
          <>
            <Button icon={<ReloadOutlined />} onClick={() => loadApiKeys(connectionId, pageRef.current)}>
              {t('Refresh')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                modalIdRef.current += 1;
                modalConnectionIdRef.current = connectionId;
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

      {!connectionId && connections.length > 0 && (
        <Alert
          type="info"
          showIcon
          message={t('API key management requires an admin-authenticated connection')}
          style={{ marginBottom: 16 }}
        />
      )}

      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />}

      <Table dataSource={apiKeys} columns={columns} rowKey="id" size="small" loading={loading} pagination={false} />

      {connectionId && (
        <Space style={{ marginTop: 16 }}>
          <Button disabled={loading || page === 0} onClick={() => selectPage(page - 1)}>
            {t('Previous')}
          </Button>
          <span aria-live="polite">{t('Page {{number}}', { number: page + 1 })}</span>
          <Button disabled={loading || !hasNextPage} onClick={() => selectPage(page + 1)}>
            {t('Next')}
          </Button>
        </Space>
      )}

      <Modal
        title={editing ? t('Edit API Key') : t('Add API Key')}
        open={modalOpen}
        onOk={handleSave}
        confirmLoading={saving}
        onCancel={() => {
          modalIdRef.current += 1;
          modalConnectionIdRef.current = null;
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
              rules={[{ required: !editing || editing.scope !== 2 || !!editing.user }]}
            >
              <AutoComplete
                filterOption={(input, option) =>
                  String(option?.value || '')
                    .toLowerCase()
                    .includes(input.toLowerCase())
                }
                placeholder={t('Select or enter a username') as string}
                notFoundContent={t(
                  usersLoading ? 'Loading' : usersError ? 'Failed to load users' : 'No users available',
                )}
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
        onCancel={() => setRevealKeys((current) => current.slice(1))}
        width={520}
        footer={[
          <Button key="close" type="primary" onClick={() => setRevealKeys((current) => current.slice(1))}>
            {t('Close')}
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message={t(
              revealKey?.storageWarning
                ? 'API key created, but it could not be stored locally. Copy it now.'
                : 'Copy this key now. SFTPGo will not show it again.',
            )}
          />
          <Typography.Text code copyable style={{ wordBreak: 'break-all' }}>
            {revealKey?.key}
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  );
};

export default SftpgoApiKeys;
