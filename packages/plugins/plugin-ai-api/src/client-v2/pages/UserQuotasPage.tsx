import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
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
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';

interface UserSummary {
  id: string | number;
  nickname?: string;
  username?: string;
  email?: string;
}

interface QuotaPolicy {
  id: string | number;
  userId: string | number;
  user?: UserSummary;
  enabled: boolean;
  periodType: 'daily' | 'monthly';
  timezone: string;
  requestLimit?: string;
  totalTokenLimit?: string;
  costLimit?: string;
  currency: string;
  rejectUnpricedModel: boolean;
  missingUsageBehavior: 'allow' | 'use_reserved';
}

export default function UserQuotasPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<QuotaPolicy>();
  const [rows, setRows] = useState<QuotaPolicy[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<QuotaPolicy>();
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [policiesResponse, usersResponse] = await Promise.all([
        ctx.api.request({
          url: 'aiApiUserQuotaPolicies:list',
          method: 'get',
          params: { pageSize: 200, appends: ['user'], sort: '-updatedAt' },
        }),
        ctx.api.request({ url: 'users:list', method: 'get', params: { pageSize: 200 } }),
      ]);
      setRows(unwrapData<QuotaPolicy[]>(policiesResponse, []));
      setUsers(unwrapData<UserSummary[]>(usersResponse, []));
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [ctx.api]);

  useEffect(() => {
    load();
  }, [load]);

  const showCreate = () => {
    setEditing(undefined);
    form.setFieldsValue({
      enabled: true,
      periodType: 'monthly',
      timezone: 'UTC',
      currency: 'USD',
      rejectUnpricedModel: true,
      missingUsageBehavior: 'use_reserved',
    } as QuotaPolicy);
    setOpen(true);
  };

  const showEdit = (record: QuotaPolicy) => {
    setEditing(record);
    form.setFieldsValue(record);
    setOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await ctx.api.request({
        url: editing ? `aiApiUserQuotaPolicies:update/${editing.id}` : 'aiApiUserQuotaPolicies:create',
        method: 'post',
        data: values,
      });
      message.success(t('Saved successfully'));
      setOpen(false);
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (record: QuotaPolicy) => {
    try {
      await ctx.api.request({
        url: `aiApiUserQuotaPolicies:destroy/${record.id}`,
        method: 'post',
      });
      message.success(t('Deleted successfully'));
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const userLabel = (user?: UserSummary) => user?.nickname || user?.username || user?.email || String(user?.id ?? '');
  const columns: ColumnsType<QuotaPolicy> = [
    {
      title: t('User'),
      key: 'user',
      width: 180,
      render: (_, record) => userLabel(record.user) || String(record.userId),
    },
    { title: t('Period'), dataIndex: 'periodType', key: 'periodType', width: 100 },
    {
      title: t('Request limit'),
      dataIndex: 'requestLimit',
      key: 'requestLimit',
      width: 130,
      render: (value) => value ?? t('Unlimited'),
    },
    {
      title: t('Token limit'),
      dataIndex: 'totalTokenLimit',
      key: 'totalTokenLimit',
      width: 130,
      render: (value) => value ?? t('Unlimited'),
    },
    {
      title: t('Cost limit'),
      dataIndex: 'costLimit',
      key: 'costLimit',
      width: 120,
      render: (value, record) => (value == null ? t('Unlimited') : `${value} ${record.currency}`),
    },
    { title: t('Timezone'), dataIndex: 'timezone', key: 'timezone', width: 140 },
    {
      title: t('Status'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'default'}>{enabled ? t('Enabled') : t('Disabled')}</Tag>
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space size={0}>
          <Button type="link" onClick={() => showEdit(record)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this quota?')} onConfirm={() => remove(record)}>
            <Button type="link" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('User quotas')}
      extra={
        <Button type="primary" onClick={showCreate}>
          {t('Add quota')}
        </Button>
      }
    >
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} scroll={{ x: 1100 }} />
      <Modal
        title={editing ? t('Edit quota') : t('Add quota')}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="userId" label={t('User')} rules={[{ required: true }]}>
            <Select
              disabled={Boolean(editing)}
              showSearch
              optionFilterProp="label"
              options={users.map((user) => ({ label: userLabel(user), value: user.id }))}
            />
          </Form.Item>
          <Form.Item name="periodType" label={t('Period')} rules={[{ required: true }]}>
            <Select
              options={[
                { label: t('Daily'), value: 'daily' },
                { label: t('Monthly'), value: 'monthly' },
              ]}
            />
          </Form.Item>
          <Form.Item name="timezone" label={t('Timezone')} rules={[{ required: true }]}>
            <Input placeholder="UTC" />
          </Form.Item>
          <Form.Item name="requestLimit" label={t('Request limit')}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="totalTokenLimit" label={t('Token limit')}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="costLimit" label={t('Cost limit')}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="currency" label={t('Currency')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="rejectUnpricedModel" label={t('Reject unpriced models')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="missingUsageBehavior" label={t('Missing usage behavior')} rules={[{ required: true }]}>
            <Select
              options={[
                { label: t('Use reserved estimate'), value: 'use_reserved' },
                { label: t('Allow without token charge'), value: 'allow' },
              ]}
            />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
