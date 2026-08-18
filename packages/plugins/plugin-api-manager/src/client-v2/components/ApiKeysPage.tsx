import { Button, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import dayjs, { Dayjs } from 'dayjs';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { ApiKeyCreatedModal } from './ApiKeyCreatedModal';

interface ApiKeyRow {
  id: number;
  name: string;
  partnerId?: number | null;
  keyPrefix: string;
  scopes?: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  enabled: boolean;
}

interface PartnerOption {
  id: number;
  name: string;
}

interface CreateFormValues {
  name: string;
  partnerId?: number | null;
  scopes: string[];
  expiresAt?: Dayjs | null;
}

const SCOPE_OPTIONS = ['inbound', 'outbound'];

export const ApiKeysPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [rows, setRows] = useState<ApiKeyRow[]>([]);
  const [partners, setPartners] = useState<PartnerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ name: string; apiKey: string } | null>(null);
  const [form] = Form.useForm<CreateFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [keysRes, partnersRes] = await Promise.all([
        api.request({ url: 'apiManagerApiKeys:list', params: { paginate: false, sort: ['-createdAt'] } }),
        api.request({ url: 'apiPartners:list', params: { paginate: false } }),
      ]);
      setRows((keysRes?.data?.data ?? []) as ApiKeyRow[]);
      setPartners((partnersRes?.data?.data ?? []) as PartnerOption[]);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load API keys') as string));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ scopes: ['inbound', 'outbound'] });
    setModalOpen(true);
  };

  const onSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.request({
        url: 'apiManagerApiKeys:create',
        method: 'post',
        data: {
          name: values.name,
          partnerId: values.partnerId ?? null,
          scopes: values.scopes,
          expiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
        },
      });
      const data = (res?.data?.data ?? {}) as { apiKey?: string; name?: string };
      setModalOpen(false);
      if (data.apiKey) {
        setCreatedKey({ name: data.name ?? values.name, apiKey: data.apiKey });
      }
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to create API key') as string));
    } finally {
      setSaving(false);
    }
  };

  const onRevoke = async (record: ApiKeyRow) => {
    try {
      await api.request({ url: 'apiManagerApiKeys:revoke', method: 'post', params: { filterByTk: record.id } });
      message.success(t('API key revoked') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to revoke API key') as string));
    }
  };

  const onDelete = async (id: number) => {
    try {
      await api.request({ url: 'apiManagerApiKeys:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('API key deleted') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete API key') as string));
    }
  };

  const partnerName = (id?: number | null) => partners.find((p) => p.id === id)?.name ?? '-';

  const columns = [
    { title: t('Name') as string, dataIndex: 'name', key: 'name' },
    {
      title: t('Key Prefix') as string,
      dataIndex: 'keyPrefix',
      key: 'keyPrefix',
      render: (prefix: string) => <code>{prefix}…</code>,
    },
    {
      title: t('Partner') as string,
      key: 'partner',
      render: (_: unknown, record: ApiKeyRow) => partnerName(record.partnerId),
    },
    {
      title: t('Scopes') as string,
      dataIndex: 'scopes',
      key: 'scopes',
      render: (scopes?: string[]) =>
        (scopes ?? []).map((s) => (
          <Tag key={s} color="blue">
            {s}
          </Tag>
        )),
    },
    {
      title: t('Expires At') as string,
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      render: (v?: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: t('Last Used') as string,
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      render: (v?: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: t('Status') as string,
      key: 'status',
      render: (_: unknown, record: ApiKeyRow) =>
        record.revokedAt ? (
          <Tag color="red">{t('Revoked')}</Tag>
        ) : record.enabled ? (
          <Tag color="green">{t('Active')}</Tag>
        ) : (
          <Tag>{t('Disabled')}</Tag>
        ),
    },
    {
      title: t('Actions') as string,
      key: 'actions',
      render: (_: unknown, record: ApiKeyRow) => (
        <Space>
          {!record.revokedAt && (
            <Popconfirm title={t('Revoke this API key?') as string} onConfirm={() => onRevoke(record)}>
              <Button size="small" danger>
                {t('Revoke')}
              </Button>
            </Popconfirm>
          )}
          <Popconfirm title={t('Delete') + '?'} onConfirm={() => onDelete(record.id)}>
            <Button size="small" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Create API Key')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={load}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={false} />
      <Modal
        title={t('Create API Key') as string}
        open={modalOpen}
        onOk={onSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText={t('Save') as string}
        cancelText={t('Cancel') as string}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name') as string} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="partnerId" label={t('Partner') as string}>
            <Select allowClear options={partners.map((p) => ({ value: p.id, label: p.name }))} />
          </Form.Item>
          <Form.Item
            name="scopes"
            label={t('Scopes') as string}
            tooltip={t('Bare scopes allow all routes; use inbound:<route> or outbound:<route> to restrict') as string}
            rules={[{ required: true, message: t('Select at least one scope') as string }]}
          >
            <Select
              mode="tags"
              options={SCOPE_OPTIONS.map((s) => ({ value: s, label: s }))}
              placeholder={t('e.g. inbound, outbound, outbound:orders') as string}
            />
          </Form.Item>
          <Form.Item name="expiresAt" label={t('Expires At') as string}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <ApiKeyCreatedModal value={createdKey} onClose={() => setCreatedKey(null)} />
    </div>
  );
};

export default ApiKeysPage;
