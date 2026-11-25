// SPDX-License-Identifier: Apache-2.0

import {
  ApiOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useState } from 'react';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, SECRET_MASK } from '../../shared/constants';
import type { HaproxyAuthType, HaproxyConnectionPublic } from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/format';

interface ConnectionFormValues {
  name: string;
  title?: string;
  baseUrl: string;
  authType: HaproxyAuthType;
  username?: string;
  password?: string;
  tlsSkipVerify: boolean;
  timeoutMs: number;
  enabled: boolean;
  notes?: string;
}

export const HaproxyConnectionsView: React.FC = () => {
  const t = useT();
  const api = useHaproxyApi();

  const [connections, setConnections] = useState<HaproxyConnectionPublic[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<HaproxyConnectionPublic | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingDraft, setTestingDraft] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  const [form] = Form.useForm<ConnectionFormValues>();
  const watchedAuthType = Form.useWatch('authType', form) ?? 'basic';

  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listConnections();
      setConnections(list);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const openCreateModal = useCallback(() => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      authType: 'basic',
      tlsSkipVerify: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      enabled: true,
    });
    setModalOpen(true);
  }, [form]);

  const openEditModal = useCallback(
    (record: HaproxyConnectionPublic) => {
      setEditing(record);
      form.setFieldsValue({
        name: record.name,
        title: record.title ?? '',
        baseUrl: record.baseUrl,
        authType: record.authType,
        username: record.username ?? '',
        password: '',
        tlsSkipVerify: record.tlsSkipVerify,
        timeoutMs: record.timeoutMs,
        enabled: record.enabled,
        notes: record.notes ?? '',
      });
      setModalOpen(true);
    },
    [form],
  );

  const handleSave = useCallback(async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const payload: Record<string, unknown> = {
        ...values,
        password: values.password ? values.password : editing?.password === SECRET_MASK ? SECRET_MASK : '',
      };
      if (editing) {
        await api.updateConnection(editing.id, payload);
      } else {
        await api.createConnection(payload);
      }
      message.success(t('Connection saved'));
      setModalOpen(false);
      await loadConnections();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [api, editing, form, loadConnections, t]);

  const handleTestDraft = useCallback(async () => {
    try {
      const values = await form.validateFields([
        'baseUrl',
        'authType',
        'username',
        'password',
        'tlsSkipVerify',
        'timeoutMs',
      ]);
      setTestingDraft(true);
      const res = await api.testConnectionDraft({
        ...values,
        id: editing?.id,
        password: values.password ? values.password : editing?.password === SECRET_MASK ? SECRET_MASK : '',
      });
      message.success(
        t('Connection OK — Data Plane {{apiVersion}}, HAProxy {{haproxyVersion}}', {
          apiVersion: res.apiInfo.apiVersion ?? 'v3',
          haproxyVersion: res.processInfo.version ?? 'unknown',
        }),
      );
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        return;
      }
      message.error(getErrorMessage(err, t('Connection test failed')));
    } finally {
      setTestingDraft(false);
    }
  }, [api, editing, form, t]);

  const handleTestExisting = useCallback(
    async (record: HaproxyConnectionPublic) => {
      setTestingId(record.id);
      try {
        const res = await api.testConnection(record.id);
        message.success(
          t('Connection OK — Data Plane {{apiVersion}}, HAProxy {{haproxyVersion}}', {
            apiVersion: res.apiInfo.apiVersion ?? 'v3',
            haproxyVersion: res.processInfo.version ?? 'unknown',
          }),
        );
        await loadConnections();
      } catch (err) {
        message.error(getErrorMessage(err, t('Connection test failed')));
        await loadConnections();
      } finally {
        setTestingId(null);
      }
    },
    [api, loadConnections, t],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await api.deleteConnection(id);
        message.success(t('Connection deleted'));
        await loadConnections();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, loadConnections, t],
  );

  const columns: ColumnsType<HaproxyConnectionPublic> = [
    {
      title: t('Name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row: HaproxyConnectionPublic) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.title || name}</Typography.Text>
          {row.title && <Typography.Text type="secondary">{name}</Typography.Text>}
        </Space>
      ),
    },
    {
      title: t('Base URL'),
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      render: (url: string) => <Typography.Text code>{url}</Typography.Text>,
    },
    {
      title: t('Auth Type'),
      dataIndex: 'authType',
      key: 'authType',
      render: (authType: HaproxyAuthType, row: HaproxyConnectionPublic) =>
        authType === 'basic' ? `${t('Basic Auth')}${row.username ? ` (${row.username})` : ''}` : t('No Auth'),
    },
    {
      title: t('Status'),
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean) =>
        enabled ? (
          <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
            {t('Enabled')}
          </Tag>
        ) : (
          <Tag icon={<StopOutlined aria-hidden="true" />} color="default">
            {t('Disabled')}
          </Tag>
        ),
    },
    {
      title: t('HAProxy Version'),
      key: 'versions',
      render: (_v: unknown, row: HaproxyConnectionPublic) => {
        if (row.lastError) {
          return <Typography.Text type="danger">{row.lastError}</Typography.Text>;
        }
        if (!row.lastHaproxyVersion && !row.lastApiVersion) {
          return '—';
        }
        return `HAProxy ${row.lastHaproxyVersion ?? '?'} / API ${row.lastApiVersion ?? 'v3'}`;
      },
    },
    {
      title: t('Last Check'),
      dataIndex: 'lastCheckAt',
      key: 'lastCheckAt',
      render: (val: string | null) => (val ? new Date(val).toLocaleString() : '—'),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_v: unknown, row: HaproxyConnectionPublic) => (
        <Space size={6} wrap>
          <Button
            htmlType="button"
            size="small"
            icon={<ApiOutlined aria-hidden="true" />}
            loading={testingId === row.id}
            aria-label={`${t('Test')} ${row.name}`}
            onClick={() => handleTestExisting(row)}
          >
            {t('Test')}
          </Button>
          <Button
            htmlType="button"
            size="small"
            icon={<EditOutlined aria-hidden="true" />}
            aria-label={`${t('Edit')} ${row.name}`}
            onClick={() => openEditModal(row)}
          >
            {t('Edit')}
          </Button>
          <Popconfirm
            title={t('Delete this connection?')}
            okText={t('Delete')}
            cancelText={t('Cancel')}
            onConfirm={() => handleDelete(row.id)}
          >
            <Button
              htmlType="button"
              size="small"
              danger
              icon={<DeleteOutlined aria-hidden="true" />}
              aria-label={`${t('Delete')} ${row.name}`}
            >
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('Data Plane API v3 Connections')}
      extra={
        <Space>
          <Button
            htmlType="button"
            icon={<ReloadOutlined aria-hidden="true" />}
            loading={loading}
            onClick={loadConnections}
          >
            {t('Refresh')}
          </Button>
          <Button htmlType="button" type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={openCreateModal}>
            {t('Add Connection')}
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t('Supports {{$env.VAR}} environment references. Base URL may point to root or /v3.')}
      />

      <Table<HaproxyConnectionPublic>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={connections}
        scroll={{ x: 900 }}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
      />

      <Modal
        open={modalOpen}
        title={editing ? `${t('Edit Connection')}: ${editing.name}` : t('Add Connection')}
        width={600}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        footer={
          <Space>
            <Button htmlType="button" onClick={() => setModalOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button htmlType="button" loading={testingDraft} onClick={handleTestDraft}>
              {t('Test Draft')}
            </Button>
            <Button htmlType="button" type="primary" loading={saving} onClick={handleSave}>
              {t('Save')}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t('Name')}
            rules={[{ required: true, message: t('Please enter a connection identifier') }]}
          >
            <Input
              placeholder={t('Identifier (e.g. prod-lb-01)')}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Form.Item>
          <Form.Item name="title" label={t('Title')}>
            <Input placeholder={t('Display title (e.g. Production LB 01)')} />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label={t('Base URL')}
            rules={[{ required: true, message: t('Please enter the Data Plane API Base URL') }]}
          >
            <Input placeholder="http://haproxy-node:5555" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
          </Form.Item>
          <Form.Item name="authType" label={t('Auth Type')}>
            <Radio.Group
              options={[
                { value: 'basic', label: t('Basic Auth') },
                { value: 'none', label: t('No Auth') },
              ]}
            />
          </Form.Item>
          {watchedAuthType === 'basic' && (
            <>
              <Form.Item name="username" label={t('Username')}>
                <Input autoComplete="username" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
              </Form.Item>
              <Form.Item
                name="password"
                label={t('Password')}
                extra={editing ? t('Leave blank to keep existing password') : undefined}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </>
          )}
          <Form.Item
            name="tlsSkipVerify"
            label={t('Skip TLS Verification')}
            valuePropName="checked"
            extra={t('Allow self-signed certificates on internal HTTPS endpoints')}
          >
            <Switch />
          </Form.Item>
          <Form.Item name="timeoutMs" label={t('Request Timeout (ms)')}>
            <InputNumber min={MIN_TIMEOUT_MS} max={MAX_TIMEOUT_MS} step={1000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="notes" label={t('Notes')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default HaproxyConnectionsView;
