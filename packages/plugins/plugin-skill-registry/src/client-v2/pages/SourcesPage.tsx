import React, { useState } from 'react';
import { Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, type TableColumnsType, Tag } from 'antd';
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
  updatedAt?: string;
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
  const [form] = Form.useForm<SourceFormValues>();
  const syncPolicy = Form.useWatch('syncPolicy', form);
  const request = useRequest(() =>
    ctx.api.request<NocoBaseListBody<RegistrySource>>({ url: 'skillRegistrySources:list', method: 'get' }),
  );
  const sources = unwrapRecords<RegistrySource>(request.data);
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

  if (canSync) {
    columns.push({
      title: t('Run'),
      key: 'run',
      render: (_, record) => (
        <Space>
          <Button onClick={() => discoverSource(record.id)} disabled={!record.enabled}>
            {t('Discover')}
          </Button>
          <Button onClick={() => syncSource(record.id)} disabled={!record.enabled}>
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
    }
  };

  const discoverSource = async (sourceId: string) => {
    if (!canSync) {
      return;
    }
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
    }
  };

  const createSource = async () => {
    if (!canManage) {
      return;
    }
    try {
      const values = await form.validateFields();
      const providerConfig = JSON.parse(values.providerConfigText || '{}') as Record<string, unknown>;
      await ctx.api.request<NocoBaseResponse<Record<string, never>>>({
        url: 'skillRegistrySources:create',
        method: 'post',
        data: {
          name: values.name,
          providerType: values.providerType,
          namespace: values.namespace,
          providerConfig,
          enabled: true,
          syncPolicy: values.syncPolicy,
          ...(values.syncPolicy === 'interval' ? { syncIntervalMinutes: values.syncIntervalMinutes } : {}),
        },
      });
      ctx.message.success(t('Source created'));
      setOpen(false);
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
            <Button type="primary" onClick={() => setOpen(true)}>
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
          title={t('Create source')}
          open={open}
          onCancel={() => setOpen(false)}
          onOk={createSource}
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
            }}
          >
            <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
              <Input autoFocus />
            </Form.Item>
            <Form.Item name="providerType" label={t('Provider')} rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'skill-hub', label: t('Skill Hub') },
                  { value: 'git-manager', label: t('Git Manager') },
                ]}
              />
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
