import { CheckCircleOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import {
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
  Tag,
  Tooltip,
  message,
} from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';

const MASK = '••••••••';

interface VaultConnection {
  id: number;
  name: string;
  title?: string;
  address: string;
  namespace?: string;
  authMethod: 'token' | 'approle';
  token?: string;
  roleId?: string;
  secretId?: string;
  kvVersion: number;
  mount: string;
  enabled: boolean;
  lastCheckAt?: string;
  lastError?: string;
}

interface ConnectionFormValues {
  name: string;
  title?: string;
  address: string;
  namespace?: string;
  authMethod: 'token' | 'approle';
  token?: string;
  roleId?: string;
  secretId?: string;
  kvVersion: number;
  mount: string;
  enabled: boolean;
}

function getErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { errors?: { message?: string }[] } }; message?: string };
  return e?.response?.data?.errors?.[0]?.message || e?.message || fallback;
}

export const VaultConnections: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const [connections, setConnections] = useState<VaultConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<VaultConnection | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [form] = Form.useForm<ConnectionFormValues>();
  const authMethod = Form.useWatch('authMethod', form);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'vaultConnections:list',
        params: { pageSize: 100, sort: ['id'] },
      });
      setConnections(res?.data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadConnections().catch(() => undefined);
  }, [loadConnections]);

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editing) {
      if (!values.token || values.token === MASK) delete values.token;
      if (!values.secretId || values.secretId === MASK) delete values.secretId;
    }
    try {
      if (editing) {
        await api.request({
          url: 'vaultConnections:update',
          method: 'post',
          params: { filterByTk: editing.id },
          data: values,
        });
        message.success(t('Connection updated'));
      } else {
        await api.request({ url: 'vaultConnections:create', method: 'post', data: values });
        message.success(t('Connection added'));
      }
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      await loadConnections();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const handleDelete = async (id: number) => {
    await api.request({ url: 'vaultConnections:destroy', method: 'post', params: { filterByTk: id } });
    message.success(t('Deleted'));
    await loadConnections();
  };

  const handleTest = async (record: VaultConnection) => {
    setTestingId(record.id);
    try {
      const res = await api.request({
        url: 'vaultConnections:testConnection',
        method: 'post',
        params: { filterByTk: record.id },
      });
      const version = res?.data?.data?.version;
      message.success(
        version ? `${t('Connection successful')} (Vault ${version})` : (t('Connection successful') as string),
      );
    } catch (err) {
      message.error(getErrorMessage(err, t('Connection failed') as string));
    } finally {
      setTestingId(null);
      await loadConnections();
    }
  };

  const handleToggleEnabled = async (record: VaultConnection, checked: boolean) => {
    try {
      await api.request({
        url: 'vaultConnections:update',
        method: 'post',
        params: { filterByTk: record.id },
        data: { enabled: checked },
      });
      await loadConnections();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    { title: t('Address'), dataIndex: 'address', key: 'address', ellipsis: true },
    {
      title: t('Auth Method'),
      dataIndex: 'authMethod',
      key: 'authMethod',
      width: 110,
      render: (v: string) => (v === 'approle' ? 'AppRole' : 'Token'),
    },
    {
      title: t('KV'),
      key: 'kv',
      width: 120,
      render: (_: unknown, record: VaultConnection) => `v${record.kvVersion} / ${record.mount}`,
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (v: boolean, record: VaultConnection) => (
        <Switch
          size="small"
          checked={!!v}
          aria-label={t('Enabled') as string}
          onChange={(checked) => handleToggleEnabled(record, checked)}
        />
      ),
    },
    {
      title: t('Status'),
      key: 'status',
      width: 120,
      render: (_: unknown, record: VaultConnection) => {
        if (record.lastError) {
          return (
            <Tooltip title={record.lastError}>
              <Tag color="red">{t('Error')}</Tag>
            </Tooltip>
          );
        }
        if (record.lastCheckAt) {
          return (
            <Tooltip title={new Date(record.lastCheckAt).toLocaleString()}>
              <Tag color="green">{t('Connected')}</Tag>
            </Tooltip>
          );
        }
        return <Tag>{t('Unknown')}</Tag>;
      },
    },
    {
      title: '',
      key: 'actions',
      width: 220,
      render: (_: unknown, record: VaultConnection) => (
        <Space size="small">
          <Button
            size="small"
            icon={<CheckCircleOutlined />}
            loading={testingId === record.id}
            onClick={() => handleTest(record)}
          >
            {t('Test')}
          </Button>
          <Button
            size="small"
            onClick={() => {
              setEditing(record);
              form.setFieldsValue({ ...record, token: '', secretId: '' });
              setModalOpen(true);
            }}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this connection?')} onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('Delete') as string} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t('Add Connection')}
        </Button>
      </div>

      <Table dataSource={connections} columns={columns} rowKey="id" size="small" loading={loading} pagination={false} />

      <Modal
        title={editing ? t('Edit Connection') : t('Add Connection')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ authMethod: 'token', kvVersion: 2, mount: 'secret', enabled: true }}
        >
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input placeholder="prod-vault" />
          </Form.Item>
          <Form.Item name="title" label={t('Title')}>
            <Input placeholder={t('Optional display name') as string} />
          </Form.Item>
          <Form.Item
            name="address"
            label={t('Vault Address')}
            rules={[
              { required: true },
              { pattern: /^https?:\/\//, message: t('Address must start with http:// or https://') as string },
            ]}
          >
            <Input placeholder="https://vault.example.com:8200" />
          </Form.Item>
          <Form.Item name="namespace" label={t('Namespace')} extra={t('Vault Enterprise namespace (optional)')}>
            <Input placeholder="admin/team-a" />
          </Form.Item>
          <Form.Item name="authMethod" label={t('Auth Method')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'token', label: 'Token' },
                { value: 'approle', label: 'AppRole' },
              ]}
            />
          </Form.Item>
          {authMethod !== 'approle' && (
            <Form.Item name="token" label={t('Token')} rules={editing ? [] : [{ required: true }]}>
              <Input.Password placeholder={editing ? (t('Leave empty to keep current') as string) : 'hvs.xxxx...'} />
            </Form.Item>
          )}
          {authMethod === 'approle' && (
            <>
              <Form.Item name="roleId" label={t('Role ID')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="secretId" label={t('Secret ID')} rules={editing ? [] : [{ required: true }]}>
                <Input.Password placeholder={editing ? (t('Leave empty to keep current') as string) : undefined} />
              </Form.Item>
            </>
          )}
          <Form.Item name="kvVersion" label={t('KV Version')} rules={[{ required: true }]}>
            <InputNumber min={1} max={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="mount" label={t('KV Mount')} rules={[{ required: true }]}>
            <Input placeholder="secret" />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default VaultConnections;
