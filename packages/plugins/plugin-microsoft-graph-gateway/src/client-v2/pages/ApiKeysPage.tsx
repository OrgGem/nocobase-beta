import { CopyOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { Button, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { actionData, ActionResponse, ApiEnvelope, errorMessage } from './shared';

interface ApiKey {
  id: number;
  name: string;
  keyPrefix: string;
  scopes: string[];
  enabled: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  apiKey?: string;
}
const scopes = ['email:read', 'email:write', 'lists:read', 'lists:write', 'drive:read', 'drive:write'];
export default function ApiKeysPage() {
  const api = useFlowContext().api;
  const t = useT();
  const [rows, setRows] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState('');
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.request<ActionResponse<ApiEnvelope<ApiKey[]>>>({
        url: 'msGraphGateway:listApiKeys',
      });
      setRows(actionData(response.data).data);
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    load().catch((error) => message.error(errorMessage(error, t('Load failed'))));
  }, [load, t]);
  const create = async () => {
    try {
      const values = await form.validateFields();
      const response = await api.request<ActionResponse<ApiEnvelope<ApiKey>>>({
        url: 'msGraphGateway:createApiKey',
        method: 'post',
        data: { ...values, expiresAt: values.expiresAt?.toISOString() },
      });
      setCreated(actionData(response.data).data.apiKey || '');
      setOpen(false);
      form.resetFields();
      await load();
    } catch (error) {
      message.error(errorMessage(error, t('Create failed')));
    }
  };
  const revoke = async (id: number) => {
    await api.request({ url: 'msGraphGateway:revokeApiKey', method: 'post', data: { id } });
    message.success(t('API key revoked'));
    await load();
  };
  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          {t('Create API key')}
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 900 }}
        columns={[
          { title: t('Name'), dataIndex: 'name', width: 180 },
          { title: t('Prefix'), dataIndex: 'keyPrefix', width: 140, render: (v: string) => <code>{v}</code> },
          {
            title: t('Scopes'),
            dataIndex: 'scopes',
            width: 320,
            render: (v: string[]) => v.map((scope) => <Tag key={scope}>{scope}</Tag>),
          },
          {
            title: t('Status'),
            dataIndex: 'enabled',
            width: 100,
            render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? t('Active') : t('Revoked')}</Tag>,
          },
          {
            title: t('Last used'),
            dataIndex: 'lastUsedAt',
            width: 180,
            render: (v?: string) => (v ? new Date(v).toLocaleString() : '-'),
          },
          {
            title: '',
            width: 100,
            render: (_: unknown, row: ApiKey) =>
              row.enabled && (
                <Popconfirm title={t('Revoke this API key?')} onConfirm={() => revoke(row.id)}>
                  <Button danger size="small" icon={<StopOutlined />}>
                    {t('Revoke')}
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
      <Modal title={t('Create API key')} open={open} onOk={create} onCancel={() => setOpen(false)}>
        <Form form={form} layout="vertical" initialValues={{ scopes: ['email:read'] }}>
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="scopes" label={t('Scopes')} rules={[{ required: true }]}>
            <Select mode="multiple" options={scopes.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="expiresAt" label={t('Expires at')}>
            <DatePicker showTime />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('API key created')}
        open={Boolean(created)}
        onCancel={() => setCreated('')}
        footer={<Button onClick={() => setCreated('')}>{t('Close')}</Button>}
      >
        <p>{t('Copy this key now. It will not be shown again.')}</p>
        <Input
          value={created}
          readOnly
          addonAfter={<CopyOutlined onClick={() => navigator.clipboard.writeText(created)} />}
        />
      </Modal>
    </div>
  );
}
