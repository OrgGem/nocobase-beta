// SPDX-License-Identifier: Apache-2.0

import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  message,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

const PAGE_SIZE = 50;

interface SftpgoConnectionOption {
  id: number;
  name: string;
  title?: string;
}

interface SftpgoUser {
  username: string;
  status: number;
  email?: string;
  home_dir?: string;
  permissions?: Record<string, string[]>;
  quota_size?: number;
  quota_files?: number;
  max_sessions?: number;
  description?: string;
}

interface UserFormValues {
  username: string;
  password?: string;
  status: number;
  email?: string;
  home_dir?: string;
  permissions?: string[];
  quota_size?: number;
  quota_files?: number;
  max_sessions?: number;
  description?: string;
}

export const SftpgoUsers: React.FC = () => {
  const t = useT();
  const permissionOptions = useMemo(
    () => [
      { value: '*', label: t('All') },
      { value: 'list', label: t('List') },
      { value: 'download', label: t('Download') },
      { value: 'upload', label: t('Upload') },
      { value: 'overwrite', label: t('Overwrite') },
      { value: 'delete', label: t('Delete') },
      { value: 'rename', label: t('Rename') },
      { value: 'create_dirs', label: t('Create dirs') },
      { value: 'create_symlinks', label: t('Create symlinks') },
      { value: 'chmod', label: t('Chmod') },
      { value: 'chown', label: t('Chown') },
      { value: 'chtimes', label: t('Chtimes') },
    ],
    [t],
  );
  const api = useApp().apiClient;
  const [connections, setConnections] = useState<SftpgoConnectionOption[]>([]);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const connectionIdRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const pageRef = useRef(0);
  const modalIdRef = useRef(0);
  const modalConnectionIdRef = useRef<number | null>(null);
  const [users, setUsers] = useState<SftpgoUser[]>([]);
  const [usersConnectionId, setUsersConnectionId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SftpgoUser | null>(null);
  const [form] = Form.useForm<UserFormValues>();

  const selectConnection = useCallback((id: number) => {
    connectionIdRef.current = id;
    requestIdRef.current += 1;
    pageRef.current = 0;
    modalIdRef.current += 1;
    modalConnectionIdRef.current = null;
    setConnectionId(id);
    setUsers([]);
    setUsersConnectionId(null);
    setPage(0);
    setHasNextPage(false);
    setLoading(false);
    setError(null);
    setModalOpen(false);
    setEditing(null);
  }, []);

  const selectPage = useCallback((nextPage: number) => {
    pageRef.current = nextPage;
    requestIdRef.current += 1;
    setPage(nextPage);
    setUsers([]);
    setUsersConnectionId(null);
    setHasNextPage(false);
    setLoading(true);
    setError(null);
  }, []);

  const loadConnections = useCallback(async () => {
    const res = await api.request({
      url: 'sftpgoConnections:list',
      params: { filter: { enabled: true }, pageSize: 100, sort: ['id'] },
    });
    const list = (res?.data?.data || []) as SftpgoConnectionOption[];
    setConnections(list);
    if (connectionIdRef.current === null && list[0]) selectConnection(list[0].id);
  }, [api, selectConnection]);

  useEffect(() => {
    loadConnections().catch(() => undefined);
  }, [loadConnections]);

  const loadUsers = useCallback(
    async (connId: number, pageNumber: number) => {
      if (connId !== connectionIdRef.current || pageNumber !== pageRef.current) return;
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.request({
          url: 'sftpgoUsers:list',
          params: { connectionId: connId, limit: PAGE_SIZE + 1, offset: pageNumber * PAGE_SIZE },
        });
        if (
          requestIdRef.current === requestId &&
          connectionIdRef.current === connId &&
          pageRef.current === pageNumber
        ) {
          const items = (res?.data?.data || []) as SftpgoUser[];
          if (items.length === 0 && pageNumber > 0) {
            selectPage(pageNumber - 1);
            return;
          }
          setUsers(items.slice(0, PAGE_SIZE));
          setHasNextPage(items.length > PAGE_SIZE);
          setUsersConnectionId(connId);
        }
      } catch (err) {
        if (requestIdRef.current === requestId && connectionIdRef.current === connId) {
          setError(getErrorMessage(err, t('Failed to load users') as string));
          setUsers([]);
          setUsersConnectionId(null);
          setHasNextPage(false);
        }
      } finally {
        if (requestIdRef.current === requestId && connectionIdRef.current === connId) setLoading(false);
      }
    },
    [api, selectPage, t],
  );

  useEffect(() => {
    if (connectionId) loadUsers(connectionId, page).catch(() => undefined);
    else setUsers([]);
  }, [connectionId, loadUsers, page]);

  const handleSave = async () => {
    const targetConnectionId = modalConnectionIdRef.current;
    const modalId = modalIdRef.current;
    if (!targetConnectionId || targetConnectionId !== connectionIdRef.current) return;
    const values = await form.validateFields();
    if (targetConnectionId !== connectionIdRef.current || modalId !== modalIdRef.current) return;
    const rootPermissions = values.permissions ?? ['*'];
    const previousRootPermissions = editing?.permissions?.['/'] ?? ['*'];
    const payload: Record<string, unknown> = { ...values };
    if (
      !editing ||
      rootPermissions.length !== previousRootPermissions.length ||
      rootPermissions.some((permission, index) => permission !== previousRootPermissions[index])
    ) {
      payload.permissions = { ...editing?.permissions, '/': rootPermissions };
    } else {
      delete payload.permissions;
    }
    if (!values.password) delete payload.password;
    try {
      if (editing) {
        await api.request({
          url: 'sftpgoUsers:update',
          method: 'post',
          params: { connectionId: targetConnectionId, filterByTk: editing.username },
          data: payload,
        });
        message.success(t('User updated'));
      } else {
        await api.request({
          url: 'sftpgoUsers:create',
          method: 'post',
          params: { connectionId: targetConnectionId },
          data: payload,
        });
        message.success(t('User added'));
      }
      if (modalId === modalIdRef.current) {
        setModalOpen(false);
        setEditing(null);
        form.resetFields();
      }
      await loadUsers(targetConnectionId, pageRef.current);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const handleDelete = async (username: string, targetConnectionId: number | null) => {
    if (!targetConnectionId || targetConnectionId !== connectionIdRef.current) return;
    try {
      await api.request({
        url: 'sftpgoUsers:destroy',
        method: 'post',
        params: { connectionId: targetConnectionId, filterByTk: username },
      });
      message.success(t('Deleted'));
      await loadUsers(targetConnectionId, pageRef.current);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete') as string));
    }
  };

  const columns = [
    { title: t('Username'), dataIndex: 'username', key: 'username' },
    { title: t('Email'), dataIndex: 'email', key: 'email' },
    { title: t('Home Dir'), dataIndex: 'home_dir', key: 'home_dir', ellipsis: true },
    {
      title: t('Enabled'),
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: number) => (v === 1 ? t('Yes') : t('No')),
    },
    {
      title: '',
      key: 'actions',
      width: 160,
      render: (_: unknown, record: SftpgoUser) => (
        <Space size="small">
          <Button
            size="small"
            onClick={() => {
              if (!usersConnectionId || usersConnectionId !== connectionIdRef.current) return;
              modalIdRef.current += 1;
              modalConnectionIdRef.current = usersConnectionId;
              setEditing(record);
              form.setFieldsValue({ ...record, password: '', permissions: record.permissions?.['/'] ?? ['*'] });
              setModalOpen(true);
            }}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this user?')} onConfirm={() => handleDelete(record.username, usersConnectionId)}>
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
          options={connections.map((c) => ({ value: c.id, label: c.title || c.name }))}
          notFoundContent={t('No connection available')}
        />
        {connectionId && (
          <>
            <Button icon={<ReloadOutlined />} onClick={() => loadUsers(connectionId, pageRef.current)}>
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
              {t('Add User')}
            </Button>
          </>
        )}
      </Space>

      {!connectionId && connections.length === 0 && (
        <Alert
          type="info"
          showIcon
          message={t('No enabled connection yet')}
          description={t('Go to the Connections tab to create and enable one before managing users.')}
          style={{ marginBottom: 16 }}
        />
      )}

      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />}

      <Table dataSource={users} columns={columns} rowKey="username" size="small" loading={loading} pagination={false} />

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
        title={editing ? t('Edit User') : t('Add User')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          modalIdRef.current += 1;
          modalConnectionIdRef.current = null;
          setModalOpen(false);
          setEditing(null);
        }}
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={{ status: 1, permissions: ['*'] }}>
          <Form.Item name="username" label={t('Username')} rules={[{ required: true }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="password" label={t('Password')} rules={editing ? [] : [{ required: true }]}>
            <Input.Password placeholder={editing ? (t('Leave empty to keep current') as string) : undefined} />
          </Form.Item>
          <Form.Item name="email" label={t('Email')}>
            <Input />
          </Form.Item>
          <Form.Item name="home_dir" label={t('Home Dir')}>
            <Input placeholder="/srv/sftpgo/data/username" />
          </Form.Item>
          <Form.Item name="permissions" label={t('Permissions (root path)')}>
            <Select mode="multiple" options={permissionOptions} />
          </Form.Item>
          <Form.Item name="quota_size" label={t('Quota Size (bytes, 0 = unlimited)')}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="max_sessions" label={t('Max Sessions (0 = unlimited)')}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item
            name="status"
            label={t('Enabled')}
            valuePropName="checked"
            getValueProps={(value: number) => ({ checked: value === 1 })}
            normalize={(checked: boolean) => (checked ? 1 : 0)}
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default SftpgoUsers;
