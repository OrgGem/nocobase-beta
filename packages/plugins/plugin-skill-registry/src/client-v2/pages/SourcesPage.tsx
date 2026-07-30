import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
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
import { useSkillRegistryPermissions } from '../permissions';
import { type NocoBaseListBody, type NocoBaseResponse, unwrapRecords } from './api';

type RegistrySource = {
  id: string;
  name: string;
  providerType: 'skill-hub' | 'git-manager';
  namespace: string;
  status: string;
  enabled: boolean;
  syncPolicy: 'manual' | 'interval';
  syncIntervalMinutes?: number;
  enabled: boolean;
  updatedAt?: string;
  providerConfig?: Record<string, unknown>;
};

interface SourceFormValues {
  namespace: string;
  providerConfigText: string;
  name: string;
  providerType: 'skill-hub' | 'git-manager';
  syncPolicy: 'manual' | 'interval';
  syncIntervalMinutes?: number;
}

export default function SourcesPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canSync, canManage } = useSkillRegistryPermissions();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RegistrySource | null>(null);
  const [activeOperations, setActiveOperations] = useState<Record<string, 'discover' | 'sync'>>({});
  const [form] = Form.useForm<SourceFormValues>();
  const syncPolicy = Form.useWatch('syncPolicy', form);
  const request = useRequest(() =>
    ctx.api.request<NocoBaseListBody<RegistrySource>>({ url: 'skillRegistrySources:list', method: 'get' }),
  );
  const sources = unwrapRecords<RegistrySource>(request.data);
  const refreshRunningOperations = useCallback(async () => {
    const response = await ctx.api.request<NocoBaseListBody<{ sourceId: string }>>({
      url: 'skillRegistrySyncRuns:list',
      method: 'get',
      params: { filter: { status: 'running' }, pageSize: 100 },
    });
    const running = unwrapRecords<{ sourceId: string }>(response);
    setActiveOperations(Object.fromEntries(running.map((run) => [String(run.sourceId), 'sync' as const])));
  }, [ctx.api]);

  useEffect(() => {
    refreshRunningOperations().catch(() => undefined);
  }, [refreshRunningOperations]);

  useEffect(() => {
    if (!Object.keys(activeOperations).length) {
      return undefined;
    }
    const timer = window.setInterval(async () => {
      try {
        await Promise.all([request.refreshAsync(), refreshRunningOperations()]);
      } catch {
        // Keep controls disabled until a later poll can confirm completion.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeOperations, refreshRunningOperations, request]);
  const columns: TableColumnsType<RegistrySource> = [
    { title: t('Name'), key: 'name', render: (_, record) => record.name },
    { title: t('Provider'), key: 'providerType', render: (_, record) => record.providerType },
    { title: t('Namespace'), key: 'namespace', render: (_, record) => record.namespace },
    { title: t('Status'), key: 'status', render: (_, record) => <Tag>{record.status}</Tag> },
    {
      title: t('Sync policy'),
      key: 'syncPolicy',
      render: (_, record) => (record.syncPolicy === 'interval' ? t('Interval') : t('Manual')),
    },
    { title: t('Updated'), key: 'updatedAt', render: (_, record) => record.updatedAt || '\u2014' },
  ];

  if (canManage) {
    columns.push({
      title: t('Edit'),
      key: 'edit',
      render: (_, record) => (
        <Button onClick={() => openEdit(record)} disabled={Boolean(activeOperations[record.id])}>
          {t('Edit')}
        </Button>
      ),
    });
  }

  if (canSync) {
    columns.push({
      title: t('Run'),
      key: 'run',
      render: (_, record) => (
        <Space>
          <Button
            onClick={() => discoverSource(record.id)}
            disabled={!record.enabled || Boolean(activeOperations[record.id])}
            loading={activeOperations[record.id] === 'discover'}
          >
            {t('Discover')}
          </Button>
          <Button
            onClick={() => syncSource(record.id)}
            disabled={!record.enabled || Boolean(activeOperations[record.id])}
            loading={activeOperations[record.id] === 'sync'}
          >
            {t('Sync')}
          </Button>
        </Space>
      ),
    });
  }

  const syncSource = async (sourceId: string) => {
    if (!canSync) {
      return;
    }
    setActiveOperations((current) => ({ ...current, [sourceId]: 'sync' }));
    try {
      await ctx.api.request<NocoBaseResponse<{ runId: string; status: string }>>({
        url: 'skillRegistryAdmin:sync',
        method: 'post',
        data: { sourceId },
      });
      ctx.message.success(t('Sync started'));
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
      setActiveOperations((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
    }
  };

  const discoverSource = async (sourceId: string) => {
    if (!canSync) {
      return;
    }
    setActiveOperations((current) => ({ ...current, [sourceId]: 'discover' }));
    try {
      const response = await ctx.api.request<NocoBaseResponse<NocoBaseResponse<{ candidates?: unknown[] }>>>({
        url: 'skillRegistryAdmin:discover',
        method: 'post',
        data: { sourceId },
      });
      // Axios data -> NocoBase envelope -> action body.
      const actionBody = response.data?.data;
      const candidates = actionBody?.candidates;
      const count = Array.isArray(candidates) ? candidates.length : 0;
      ctx.message.success(t('Discovery completed ({{count}} candidates)', { count }));
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setActiveOperations((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
    }
  };

  const openEdit = (source: RegistrySource) => {
    setEditing(source);
    form.setFieldsValue({
      name: source.name,
      providerType: source.providerType,
      namespace: source.namespace,
      providerConfigText: JSON.stringify(source.providerConfig || {}, null, 2),
      syncPolicy: source.syncPolicy,
      syncIntervalMinutes: source.syncIntervalMinutes,
      enabled: source.enabled,
    });
    setOpen(true);
  };

  const saveSource = async () => {
    if (!canManage) {
      return;
    }
    try {
      const values = await form.validateFields();
      const providerConfig = JSON.parse(values.providerConfigText || '{}') as Record<string, unknown>;
      const sourceValues = {
        name: values.name,
        providerType: values.providerType,
        namespace: values.namespace,
        providerConfig,
        enabled: editing ? values.enabled : true,
        syncPolicy: values.syncPolicy,
        ...(values.syncPolicy === 'interval' ? { syncIntervalMinutes: values.syncIntervalMinutes } : {}),
      };
      await ctx.api.request<NocoBaseResponse<Record<string, never>>>({
        url: editing ? 'skillRegistrySources:update' : 'skillRegistrySources:create',
        method: 'post',
        params: editing ? { filterByTk: editing.id } : undefined,
        data: sourceValues,
      });
      ctx.message.success(t(editing ? 'Source updated' : 'Source created'));
      setOpen(false);
      setEditing(null);
      form.resetFields();
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  return (
    <Card
      title={t('Sources')}
      extra={
        <Space>
          <Button onClick={() => request.refresh()} loading={request.loading}>
            {t('Refresh')}
          </Button>
          {canManage ? (
            <Button
              type="primary"
              onClick={() => {
                setEditing(null);
                form.resetFields();
                setOpen(true);
              }}
            >
              {t('Create source')}
            </Button>
          ) : null}
        </Space>
      }
    >
      <Table
        aria-label={t('Sources')}
        rowKey="id"
        loading={request.loading}
        dataSource={sources}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
        columns={columns}
      />
      {canManage ? (
        <Modal
          title={t(editing ? 'Edit source' : 'Create source')}
          open={open}
          onCancel={() => {
            setOpen(false);
            setEditing(null);
          }}
          onOk={saveSource}
          okText={t('Save')}
          cancelText={t('Cancel')}
        >
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              name: '',
              ['providerType']: 'skill-hub',
              ['namespace']: '',
              ['providerConfigText']: '{}',
              ['syncPolicy']: 'manual',
              ['syncIntervalMinutes']: undefined,
              ['enabled']: true,
            }}
          >
            <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
              <Input autoFocus />
            </Form.Item>
            <Form.Item name="providerType" label={t('Provider')} rules={[{ required: true }]}>
              <Select
                disabled={Boolean(editing)}
                options={[
                  { value: 'skill-hub', label: t('Skill Hub') },
                  { value: 'git-manager', label: t('Git Manager') },
                ]}
              />
            </Form.Item>
            <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="namespace" label={t('Namespace')} rules={[{ required: true }]}>
              <Input placeholder="acme" />
            </Form.Item>
            <Form.Item
              name="providerConfigText"
              label={t('Provider configuration (JSON)')}
              rules={[{ required: true }]}
            >
              <Input.TextArea rows={6} />
            </Form.Item>
            <Form.Item name="syncPolicy" label={t('Sync policy')} rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'manual', label: t('Manual') },
                  { value: 'interval', label: t('Interval') },
                ]}
              />
            </Form.Item>
            {syncPolicy === 'interval' ? (
              <Form.Item
                name="syncIntervalMinutes"
                label={t('Sync interval (minutes)')}
                rules={[{ required: true, message: t('Sync interval is required') }]}
              >
                <InputNumber min={1} max={1440} style={{ width: '100%' }} />
              </Form.Item>
            ) : null}
          </Form>
        </Modal>
      ) : null}
    </Card>
  );
}
