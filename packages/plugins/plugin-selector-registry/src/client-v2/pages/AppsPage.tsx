import React, { useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  type TableColumnsType,
  Tag,
} from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSelectorRegistryPermissions } from '../permissions';
import { type NocoBaseListBody, type NocoBaseResponse, unwrapRecords } from './api';

type SelectorApp = {
  id: number;
  name: string;
  displayName: string | null;
  baseUrl: string | null;
  urlPatterns: string[] | null;
  environment: string | null;
  dryRun: boolean;
  status: 'active' | 'inactive';
  description: string | null;
  createdAt?: string;
};

interface AppFormValues {
  name: string;
  displayName?: string;
  baseUrl?: string;
  urlPatternsText?: string;
  environment?: string;
  dryRun: boolean;
  status: 'active' | 'inactive';
  description?: string;
}

export default function AppsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canManage } = useSelectorRegistryPermissions();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SelectorApp | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [form] = Form.useForm<AppFormValues>();
  const request = useRequest(() =>
    ctx.api.request<NocoBaseListBody<SelectorApp>>({
      url: 'selectorApps:list',
      method: 'get',
      params: { sort: ['name'], pageSize: 200 },
    }),
  );
  const apps = unwrapRecords<SelectorApp>(request.data);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ dryRun: false, status: 'active' });
    setOpen(true);
  };

  const openEdit = (app: SelectorApp) => {
    setEditing(app);
    form.setFieldsValue({
      name: app.name,
      displayName: app.displayName ?? '',
      baseUrl: app.baseUrl ?? '',
      urlPatternsText: JSON.stringify(app.urlPatterns ?? [], null, 2),
      environment: app.environment ?? '',
      dryRun: app.dryRun,
      status: app.status,
      description: app.description ?? '',
    });
    setOpen(true);
  };

  const closeModal = () => {
    setOpen(false);
    setEditing(null);
  };

  const saveApp = async () => {
    if (!canManage || saving) {
      return;
    }
    setSaving(true);
    try {
      const values = await form.validateFields();
      const parsed: unknown = values.urlPatternsText?.trim() ? JSON.parse(values.urlPatternsText) : [];
      const urlPatterns = Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
      const appValues = {
        name: values.name,
        displayName: values.displayName || null,
        baseUrl: values.baseUrl || null,
        urlPatterns,
        environment: values.environment || null,
        dryRun: values.dryRun,
        status: values.status,
        description: values.description || null,
      };
      await ctx.api.request<NocoBaseResponse<SelectorApp>>({
        url: editing ? 'selectorApps:update' : 'selectorApps:create',
        method: 'post',
        params: editing ? { filterByTk: editing.id } : undefined,
        data: appValues,
      });
      ctx.message.success(t(editing ? 'App updated' : 'App created'));
      closeModal();
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setSaving(false);
    }
  };

  const deleteApp = async (app: SelectorApp) => {
    if (!canManage || deletingId) {
      return;
    }
    setDeletingId(app.id);
    try {
      await ctx.api.request<NocoBaseResponse<unknown>>({
        url: 'selectorApps:destroy',
        method: 'post',
        params: { filterByTk: app.id },
      });
      ctx.message.success(t('App deleted'));
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setDeletingId(null);
    }
  };

  const columns: TableColumnsType<SelectorApp> = [
    { title: t('Name'), key: 'name', render: (_, record) => record.name },
    { title: t('Display Name'), key: 'displayName', render: (_, record) => record.displayName || '—' },
    { title: t('Environment'), key: 'environment', render: (_, record) => record.environment || '—' },
    {
      title: t('Dry Run'),
      key: 'dryRun',
      render: (_, record) => (
        <Tag color={record.dryRun ? 'orange' : 'default'}>{record.dryRun ? t('Yes') : t('No')}</Tag>
      ),
    },
    {
      title: t('Status'),
      key: 'status',
      render: (_, record) => (
        <Tag color={record.status === 'active' ? 'green' : 'default'}>
          {t(record.status === 'active' ? 'Active' : 'Inactive')}
        </Tag>
      ),
    },
    { title: t('Created'), key: 'createdAt', render: (_, record) => record.createdAt || '—' },
  ];

  if (canManage) {
    columns.push({
      title: t('Actions'),
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button onClick={() => openEdit(record)}>{t('Edit')}</Button>
          <Popconfirm
            title={t('Delete')}
            description={t('Are you sure you want to delete this app?')}
            okText={t('Confirm')}
            cancelText={t('Cancel')}
            onConfirm={() => deleteApp(record)}
          >
            <Button danger loading={deletingId === record.id}>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    });
  }

  return (
    <Card
      title={t('Selector Apps')}
      extra={
        <Space>
          <Button onClick={() => request.refresh()} loading={request.loading}>
            {t('Refresh')}
          </Button>
          {canManage ? (
            <Button type="primary" onClick={openCreate}>
              {t('Create')}
            </Button>
          ) : null}
        </Space>
      }
    >
      <Table
        aria-label={t('Selector Apps')}
        rowKey="id"
        loading={request.loading}
        dataSource={apps}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
        columns={columns}
      />
      {canManage ? (
        <Modal
          title={t(editing ? 'Edit' : 'Create')}
          open={open}
          onCancel={closeModal}
          onOk={saveApp}
          confirmLoading={saving}
          okText={t('Save')}
          cancelText={t('Cancel')}
        >
          <Form form={form} layout="vertical" initialValues={{ dryRun: false, status: 'active' }}>
            <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
              <Input autoFocus />
            </Form.Item>
            <Form.Item name="displayName" label={t('Display Name')}>
              <Input />
            </Form.Item>
            <Form.Item name="baseUrl" label={t('Base URL')}>
              <Input placeholder="https://app.example.com" />
            </Form.Item>
            <Form.Item name="environment" label={t('Environment')}>
              <Input placeholder="production" />
            </Form.Item>
            <Form.Item
              name="urlPatternsText"
              label={t('URL Patterns (JSON)')}
              rules={[
                {
                  validator: async (_, value: string | undefined) => {
                    if (!value || !value.trim()) {
                      return;
                    }
                    try {
                      const parsed: unknown = JSON.parse(value);
                      if (!Array.isArray(parsed)) {
                        throw new Error('URL patterns must be a JSON array');
                      }
                    } catch {
                      throw new Error(t('Enter valid JSON'));
                    }
                  },
                },
              ]}
            >
              <Input.TextArea rows={3} placeholder='["/checkout/*"]' />
            </Form.Item>
            <Form.Item name="dryRun" label={t('Dry Run')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="status" label={t('Status')} rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'active', label: t('Active') },
                  { value: 'inactive', label: t('Inactive') },
                ]}
              />
            </Form.Item>
            <Form.Item name="description" label={t('Description')}>
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}
    </Card>
  );
}
