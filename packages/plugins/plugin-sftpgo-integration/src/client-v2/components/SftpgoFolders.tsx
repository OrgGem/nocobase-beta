// SPDX-License-Identifier: Apache-2.0

import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, message } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

const PAGE_SIZE = 50;

interface SftpgoConnectionOption {
  id: number;
  name: string;
  title?: string;
}

interface SftpgoFolder {
  name: string;
  mapped_path?: string;
  filesystem?: { provider?: number };
  description?: string;
  used_quota_size?: number;
  used_quota_files?: number;
}

interface FolderFormValues {
  name: string;
  mapped_path?: string;
  description?: string;
}

export const SftpgoFolders: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const [connections, setConnections] = useState<SftpgoConnectionOption[]>([]);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const connectionIdRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const pageRef = useRef(0);
  const modalIdRef = useRef(0);
  const modalConnectionIdRef = useRef<number | null>(null);
  const [folders, setFolders] = useState<SftpgoFolder[]>([]);
  const [foldersConnectionId, setFoldersConnectionId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SftpgoFolder | null>(null);
  const [form] = Form.useForm<FolderFormValues>();
  const provider = editing?.filesystem?.provider ?? 0;
  const requiresMappedPath = !editing || provider === 0 || provider === 4;

  const selectConnection = useCallback((id: number) => {
    connectionIdRef.current = id;
    requestIdRef.current += 1;
    pageRef.current = 0;
    modalIdRef.current += 1;
    modalConnectionIdRef.current = null;
    setConnectionId(id);
    setFolders([]);
    setFoldersConnectionId(null);
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
    setFolders([]);
    setFoldersConnectionId(null);
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

  const loadFolders = useCallback(
    async (connId: number, pageNumber: number) => {
      if (connId !== connectionIdRef.current || pageNumber !== pageRef.current) return;
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.request({
          url: 'sftpgoFolders:list',
          params: { connectionId: connId, limit: PAGE_SIZE + 1, offset: pageNumber * PAGE_SIZE },
        });
        if (
          requestIdRef.current === requestId &&
          connectionIdRef.current === connId &&
          pageRef.current === pageNumber
        ) {
          const items = (res?.data?.data || []) as SftpgoFolder[];
          if (items.length === 0 && pageNumber > 0) {
            selectPage(pageNumber - 1);
            return;
          }
          setFolders(items.slice(0, PAGE_SIZE));
          setHasNextPage(items.length > PAGE_SIZE);
          setFoldersConnectionId(connId);
        }
      } catch (err) {
        if (requestIdRef.current === requestId && connectionIdRef.current === connId) {
          setError(getErrorMessage(err, t('Failed to load folders') as string));
          setFolders([]);
          setFoldersConnectionId(null);
          setHasNextPage(false);
        }
      } finally {
        if (requestIdRef.current === requestId && connectionIdRef.current === connId) setLoading(false);
      }
    },
    [api, selectPage, t],
  );

  useEffect(() => {
    if (connectionId) loadFolders(connectionId, page).catch(() => undefined);
    else setFolders([]);
  }, [connectionId, loadFolders, page]);

  const handleSave = async () => {
    const targetConnectionId = modalConnectionIdRef.current;
    const modalId = modalIdRef.current;
    if (!targetConnectionId || targetConnectionId !== connectionIdRef.current) return;
    let values: FolderFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (targetConnectionId !== connectionIdRef.current || modalId !== modalIdRef.current) return;
    if (editing && values.mapped_path === (editing.mapped_path ?? '')) delete values.mapped_path;
    try {
      if (editing) {
        await api.request({
          url: 'sftpgoFolders:update',
          method: 'post',
          params: { connectionId: targetConnectionId, filterByTk: editing.name },
          data: values,
        });
        message.success(t('Folder updated'));
      } else {
        await api.request({
          url: 'sftpgoFolders:create',
          method: 'post',
          params: { connectionId: targetConnectionId },
          data: values,
        });
        message.success(t('Folder added'));
      }
      if (modalId === modalIdRef.current) {
        setModalOpen(false);
        setEditing(null);
        form.resetFields();
      }
      await loadFolders(targetConnectionId, pageRef.current);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const handleDelete = async (name: string, targetConnectionId: number | null) => {
    if (!targetConnectionId || targetConnectionId !== connectionIdRef.current) return;
    try {
      await api.request({
        url: 'sftpgoFolders:destroy',
        method: 'post',
        params: { connectionId: targetConnectionId, filterByTk: name },
      });
      message.success(t('Deleted'));
      await loadFolders(targetConnectionId, pageRef.current);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete') as string));
    }
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    { title: t('Mapped Path'), dataIndex: 'mapped_path', key: 'mapped_path', ellipsis: true },
    { title: t('Description'), dataIndex: 'description', key: 'description', ellipsis: true },
    {
      title: '',
      key: 'actions',
      width: 160,
      render: (_: unknown, record: SftpgoFolder) => (
        <Space size="small">
          <Button
            size="small"
            onClick={() => {
              if (!foldersConnectionId || foldersConnectionId !== connectionIdRef.current) return;
              modalIdRef.current += 1;
              modalConnectionIdRef.current = foldersConnectionId;
              setEditing(record);
              form.resetFields();
              form.setFieldsValue({
                name: record.name,
                mapped_path: record.mapped_path ?? '',
                description: record.description ?? '',
              });
              setModalOpen(true);
            }}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this folder?')} onConfirm={() => handleDelete(record.name, foldersConnectionId)}>
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
            <Button icon={<ReloadOutlined />} onClick={() => loadFolders(connectionId, pageRef.current)}>
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
              {t('Add Folder')}
            </Button>
          </>
        )}
      </Space>

      {!connectionId && connections.length === 0 && (
        <Alert
          type="info"
          showIcon
          message={t('No enabled connection yet')}
          description={t('Go to the Connections tab to create and enable one before managing folders.')}
          style={{ marginBottom: 16 }}
        />
      )}

      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />}

      <Table dataSource={folders} columns={columns} rowKey="name" size="small" loading={loading} pagination={false} />

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
        title={editing ? t('Edit Folder') : t('Add Folder')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          modalIdRef.current += 1;
          modalConnectionIdRef.current = null;
          setModalOpen(false);
          setEditing(null);
        }}
        width={480}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="mapped_path" label={t('Mapped Path')} rules={[{ required: requiresMappedPath }]}>
            <Input placeholder="/srv/sftpgo/shared" />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default SftpgoFolders;
