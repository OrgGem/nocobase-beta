import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, message } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { useSftpgoTabVisibility } from '../hooks/useSftpgoTabVisibility';

interface SftpgoConnectionOption {
  id: number;
  name: string;
  title?: string;
}

interface SftpgoFolder {
  name: string;
  mapped_path?: string;
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
  const [folders, setFolders] = useState<SftpgoFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SftpgoFolder | null>(null);
  const [form] = Form.useForm<FolderFormValues>();

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

  const loadFolders = useCallback(
    async (connId: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.request({ url: 'sftpgoFolders:list', params: { connectionId: connId, limit: 100 } });
        setFolders((res?.data?.data || []) as SftpgoFolder[]);
      } catch (err) {
        setError(getErrorMessage(err, t('Failed to load folders') as string));
        setFolders([]);
      } finally {
        setLoading(false);
      }
    },
    [api, t],
  );

  useEffect(() => {
    if (connectionId) loadFolders(connectionId).catch(() => undefined);
    else setFolders([]);
  }, [connectionId, loadFolders]);

  const handleSave = async () => {
    if (!connectionId) return;
    const values = await form.validateFields();
    try {
      if (editing) {
        await api.request({
          url: 'sftpgoFolders:update',
          method: 'post',
          params: { connectionId, filterByTk: editing.name },
          data: values,
        });
        message.success(t('Folder updated'));
      } else {
        await api.request({ url: 'sftpgoFolders:create', method: 'post', params: { connectionId }, data: values });
        message.success(t('Folder added'));
      }
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      await loadFolders(connectionId);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const handleDelete = async (name: string) => {
    if (!connectionId) return;
    try {
      await api.request({ url: 'sftpgoFolders:destroy', method: 'post', params: { connectionId, filterByTk: name } });
      message.success(t('Deleted'));
      await loadFolders(connectionId);
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
              setEditing(record);
              form.setFieldsValue({ ...record });
              setModalOpen(true);
            }}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this folder?')} onConfirm={() => handleDelete(record.name)}>
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
            <Button icon={<ReloadOutlined />} onClick={() => loadFolders(connectionId)}>
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

      <Modal
        title={editing ? t('Edit Folder') : t('Add Folder')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        width={480}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="mapped_path" label={t('Mapped Path')} rules={[{ required: true }]}>
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
