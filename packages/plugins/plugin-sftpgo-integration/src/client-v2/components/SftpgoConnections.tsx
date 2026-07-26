import { CheckCircleOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip, message } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { EnvInput, type EnvVariableOption } from './EnvInput';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { notifySftpgoConnectionsChanged, useSftpgoTabVisibility } from '../hooks/useSftpgoTabVisibility';

const MASK = '••••••••';

interface SftpgoConnection {
  id: number;
  name: string;
  title?: string;
  baseUrl: string;
  authMethod: 'admin' | 'apikey';
  username?: string;
  password?: string;
  apiKey?: string;
  enabled: boolean;
  lastCheckAt?: string;
  lastError?: string;
}

interface ConnectionFormValues {
  name: string;
  title?: string;
  baseUrl: string;
  authMethod: 'admin' | 'apikey';
  username?: string;
  password?: string;
  apiKey?: string;
  enabled: boolean;
}

export const SftpgoConnections: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [connections, setConnections] = useState<SftpgoConnection[]>([]);
  const [envVariables, setEnvVariables] = useState<EnvVariableOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SftpgoConnection | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [form] = Form.useForm<ConnectionFormValues>();
  const authMethod = Form.useWatch('authMethod', form);

  useSftpgoTabVisibility();

  const loadEnvVariables = useCallback(async () => {
    try {
      const res = await api.request({
        url: 'environmentVariables?paginate=false',
        skipNotify: true,
      });
      const list = (res?.data?.data || []) as EnvVariableOption[];
      setEnvVariables(Array.isArray(list) ? list : []);
    } catch {
      setEnvVariables([]);
    }
  }, [api]);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'sftpgoConnections:list',
        params: { pageSize: 100, sort: ['id'] },
      });
      setConnections(res?.data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadConnections().catch(() => undefined);
    loadEnvVariables().catch(() => undefined);
  }, [loadConnections, loadEnvVariables]);

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editing) {
      if (!values.password || values.password === MASK) delete values.password;
      if (!values.apiKey || values.apiKey === MASK) delete values.apiKey;
    }
    try {
      if (editing) {
        await api.request({
          url: 'sftpgoConnections:update',
          method: 'post',
          params: { filterByTk: editing.id },
          data: values,
        });
        message.success(t('Connection updated'));
      } else {
        await api.request({ url: 'sftpgoConnections:create', method: 'post', data: values });
        message.success(t('Connection added'));
      }
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      await loadConnections();
      notifySftpgoConnectionsChanged(app);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.request({ url: 'sftpgoConnections:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('Deleted'));
      await loadConnections();
      notifySftpgoConnectionsChanged(app);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete') as string));
    }
  };

  const handleTest = async (record: SftpgoConnection) => {
    setTestingId(record.id);
    try {
      await api.request({
        url: 'sftpgoConnections:testConnection',
        method: 'post',
        params: { filterByTk: record.id },
      });
      message.success(t('Connection successful'));
    } catch (err) {
      message.error(getErrorMessage(err, t('Connection failed') as string));
    } finally {
      setTestingId(null);
      await loadConnections();
      notifySftpgoConnectionsChanged(app);
    }
  };

  const handleToggleEnabled = async (record: SftpgoConnection, checked: boolean) => {
    try {
      await api.request({
        url: 'sftpgoConnections:update',
        method: 'post',
        params: { filterByTk: record.id },
        data: { enabled: checked },
      });
      await loadConnections();
      notifySftpgoConnectionsChanged(app);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save') as string));
    }
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    { title: t('Base URL'), dataIndex: 'baseUrl', key: 'baseUrl', ellipsis: true },
    {
      title: t('Auth Method'),
      dataIndex: 'authMethod',
      key: 'authMethod',
      width: 110,
      render: (v: string) => (v === 'apikey' ? t('API Key') : t('Admin')),
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (v: boolean, record: SftpgoConnection) => (
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
      render: (_: unknown, record: SftpgoConnection) => {
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
      render: (_: unknown, record: SftpgoConnection) => (
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
              form.setFieldsValue({ ...record, password: '', apiKey: '' });
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
        <Form form={form} layout="vertical" initialValues={{ authMethod: 'admin', enabled: true }}>
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input placeholder="prod-sftpgo" />
          </Form.Item>
          <Form.Item name="title" label={t('Title')}>
            <Input placeholder={t('Optional display name') as string} />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label={t('Base URL')}
            rules={[
              { required: true },
              {
                pattern: /^(https?:\/\/|\{\{\s*\$env\.)/,
                message: t('Address must start with http:// or https:// or environment variable') as string,
              },
            ]}
          >
            <EnvInput envVariables={envVariables} placeholder="https://sftpgo.example.com:8080" />
          </Form.Item>
          <Form.Item name="authMethod" label={t('Auth Method')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'admin', label: t('Admin (username/password)') },
                { value: 'apikey', label: t('API Key') },
              ]}
            />
          </Form.Item>
          {authMethod !== 'apikey' && (
            <>
              <Form.Item name="username" label={t('Username')} rules={[{ required: true }]}>
                <EnvInput envVariables={envVariables} placeholder="admin" />
              </Form.Item>
              <Form.Item name="password" label={t('Password')} rules={editing ? [] : [{ required: true }]}>
                <EnvInput
                  isPassword
                  envVariables={envVariables}
                  placeholder={editing ? (t('Leave empty to keep current') as string) : undefined}
                />
              </Form.Item>
            </>
          )}
          {authMethod === 'apikey' && (
            <>
              <Form.Item name="apiKey" label={t('API Key')} rules={editing ? [] : [{ required: true }]}>
                <EnvInput
                  isPassword
                  envVariables={envVariables}
                  placeholder={editing ? (t('Leave empty to keep current') as string) : undefined}
                />
              </Form.Item>
              <Form.Item
                name="username"
                label={t('Impersonate User')}
                extra={t('Only needed if the API key is not bound to a specific admin or user')}
              >
                <EnvInput envVariables={envVariables} placeholder={t('Optional') as string} />
              </Form.Item>
            </>
          )}
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default SftpgoConnections;
