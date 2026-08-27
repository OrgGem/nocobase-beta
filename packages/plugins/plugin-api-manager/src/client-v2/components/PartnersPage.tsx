import {
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import dayjs, { Dayjs } from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { ApiKeyCreatedModal } from './ApiKeyCreatedModal';

interface PartnerRow {
  id: number;
  name: string;
  contactEmail?: string;
  notes?: string;
  enabled: boolean;
}

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

interface CreateKeyFormValues {
  name: string;
  scopes: string[];
  expiresAt?: Dayjs | null;
}

const SCOPE_OPTIONS = ['inbound', 'outbound'];

export const PartnersPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);
  const [partnerSearch, setPartnerSearch] = useState('');
  const [keySearch, setKeySearch] = useState('');

  const [partnersLoading, setPartnersLoading] = useState(false);
  const [keysLoading, setKeysLoading] = useState(false);

  const [partnerModalOpen, setPartnerModalOpen] = useState(false);
  const [editingPartner, setEditingPartner] = useState<PartnerRow | null>(null);
  const [partnerSaving, setPartnerSaving] = useState(false);
  const [partnerForm] = Form.useForm();

  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ name: string; apiKey: string } | null>(null);
  const [keyForm] = Form.useForm<CreateKeyFormValues>();

  const selectedPartner = useMemo(
    () => partners.find((p) => p.id === selectedPartnerId) ?? null,
    [partners, selectedPartnerId],
  );

  const loadPartners = useCallback(async () => {
    setPartnersLoading(true);
    try {
      const res = await api.request({ url: 'apiPartners:list', params: { paginate: false, sort: ['name'] } });
      const data = (res?.data?.data ?? []) as PartnerRow[];
      setPartners(Array.isArray(data) ? data : []);
      setSelectedPartnerId((current) => {
        if (current != null && data.some((p) => p.id === current)) return current;
        return data[0]?.id ?? null;
      });
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load partners') as string));
    } finally {
      setPartnersLoading(false);
    }
  }, [api, t]);

  const loadApiKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const res = await api.request({
        url: 'apiManagerApiKeys:list',
        params: { paginate: false, sort: ['-createdAt'] },
      });
      setApiKeys((res?.data?.data ?? []) as ApiKeyRow[]);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load API keys') as string));
    } finally {
      setKeysLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    loadPartners();
  }, [loadPartners]);

  useEffect(() => {
    loadApiKeys();
  }, [loadApiKeys]);

  const filteredPartners = useMemo(() => {
    const q = partnerSearch.trim().toLowerCase();
    if (!q) return partners;
    return partners.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.contactEmail ?? '').toLowerCase().includes(q) ||
        (p.notes ?? '').toLowerCase().includes(q),
    );
  }, [partners, partnerSearch]);

  const selectedPartnerKeys = useMemo(() => {
    const q = keySearch.trim().toLowerCase();
    return apiKeys.filter((k) => {
      if (k.partnerId !== selectedPartnerId) return false;
      if (!q) return true;
      return (
        k.name.toLowerCase().includes(q) ||
        k.keyPrefix.toLowerCase().includes(q) ||
        (k.scopes ?? []).some((s) => s.toLowerCase().includes(q))
      );
    });
  }, [apiKeys, selectedPartnerId, keySearch]);

  const openCreatePartner = () => {
    setEditingPartner(null);
    partnerForm.resetFields();
    partnerForm.setFieldsValue({ enabled: true });
    setPartnerModalOpen(true);
  };

  const openEditPartner = (record: PartnerRow) => {
    setEditingPartner(record);
    partnerForm.setFieldsValue(record);
    setPartnerModalOpen(true);
  };

  const onSavePartner = async () => {
    const values = await partnerForm.validateFields();
    setPartnerSaving(true);
    try {
      if (editingPartner) {
        await api.request({
          url: 'apiPartners:update',
          method: 'post',
          params: { filterByTk: editingPartner.id },
          data: values,
        });
      } else {
        await api.request({ url: 'apiPartners:create', method: 'post', data: values });
      }
      message.success(t('Partner saved') as string);
      setPartnerModalOpen(false);
      loadPartners();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save partner') as string));
    } finally {
      setPartnerSaving(false);
    }
  };

  const onDeletePartner = async (id: number) => {
    try {
      await api.request({ url: 'apiPartners:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('Partner deleted') as string);
      if (selectedPartnerId === id) setSelectedPartnerId(null);
      loadPartners();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save partner') as string));
    }
  };

  const onTogglePartnerEnabled = async (record: PartnerRow, enabled: boolean) => {
    try {
      await api.request({
        url: 'apiPartners:update',
        method: 'post',
        params: { filterByTk: record.id },
        data: { enabled },
      });
      loadPartners();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save partner') as string));
    }
  };

  const openCreateKey = () => {
    keyForm.resetFields();
    keyForm.setFieldsValue({ scopes: ['inbound', 'outbound'] });
    setKeyModalOpen(true);
  };

  const onSaveKey = async () => {
    if (selectedPartnerId == null) return;
    const values = await keyForm.validateFields();
    setKeySaving(true);
    try {
      const res = await api.request({
        url: 'apiManagerApiKeys:create',
        method: 'post',
        data: {
          name: values.name,
          partnerId: selectedPartnerId,
          scopes: values.scopes,
          expiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
        },
      });
      const data = (res?.data?.data ?? {}) as { apiKey?: string; name?: string };
      setKeyModalOpen(false);
      if (data.apiKey) {
        setCreatedKey({ name: data.name ?? values.name, apiKey: data.apiKey });
      }
      loadApiKeys();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to create API key') as string));
    } finally {
      setKeySaving(false);
    }
  };

  const onRevokeKey = async (record: ApiKeyRow) => {
    try {
      await api.request({ url: 'apiManagerApiKeys:revoke', method: 'post', params: { filterByTk: record.id } });
      message.success(t('API key revoked') as string);
      loadApiKeys();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to revoke API key') as string));
    }
  };

  const onDeleteKey = async (id: number) => {
    try {
      await api.request({ url: 'apiManagerApiKeys:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('API key deleted') as string);
      loadApiKeys();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete API key') as string));
    }
  };

  const partnerColumns = [
    {
      title: t('Name') as string,
      dataIndex: 'name',
      key: 'name',
      sorter: (a: PartnerRow, b: PartnerRow) => a.name.localeCompare(b.name),
    },
    { title: t('Contact Email') as string, dataIndex: 'contactEmail', key: 'contactEmail' },
    {
      title: t('Enabled') as string,
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean, record: PartnerRow) => (
        <Switch size="small" checked={enabled} onChange={(v) => onTogglePartnerEnabled(record, v)} />
      ),
    },
    {
      title: t('Actions') as string,
      key: 'actions',
      render: (_: unknown, record: PartnerRow) => (
        <Space>
          <Button size="small" onClick={() => openEditPartner(record)}>
            {t('Edit Partner')}
          </Button>
          <Popconfirm title={t('Delete') + '?'} onConfirm={() => onDeletePartner(record.id)}>
            <Button size="small" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const keyColumns = [
    { title: t('Name') as string, dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: t('Key Prefix') as string,
      dataIndex: 'keyPrefix',
      key: 'keyPrefix',
      ellipsis: true,
      render: (prefix: string) => <code>{prefix}…</code>,
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
            <Popconfirm title={t('Revoke this API key?') as string} onConfirm={() => onRevokeKey(record)}>
              <Button size="small" danger>
                {t('Revoke')}
              </Button>
            </Popconfirm>
          )}
          <Popconfirm title={t('Delete') + '?'} onConfirm={() => onDeleteKey(record.id)}>
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
      <Card
        size="small"
        title={t('Partners') as string}
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder={t('Search partners') as string}
              style={{ width: 240 }}
              value={partnerSearch}
              onChange={(e) => setPartnerSearch(e.target.value)}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreatePartner}>
              {t('Create Partner')}
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                loadPartners();
                loadApiKeys();
              }}
            />
          </Space>
        }
      >
        <Table
          rowKey="id"
          size="small"
          columns={partnerColumns}
          dataSource={filteredPartners}
          loading={partnersLoading}
          pagination={false}
          rowSelection={{
            type: 'radio',
            selectedRowKeys: selectedPartnerId == null ? [] : [selectedPartnerId],
            onChange: (keys) => setSelectedPartnerId((keys[0] as number) ?? null),
          }}
        />
      </Card>

      <Card
        size="small"
        style={{ marginTop: 16 }}
        title={selectedPartner ? `${t('API Keys') as string} — ${selectedPartner.name}` : (t('API Keys') as string)}
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder={t('Search API keys') as string}
              style={{ width: 240 }}
              value={keySearch}
              onChange={(e) => setKeySearch(e.target.value)}
            />
            <Button type="primary" icon={<KeyOutlined />} disabled={selectedPartnerId == null} onClick={openCreateKey}>
              {t('Create API Key')}
            </Button>
          </Space>
        }
      >
        {selectedPartnerId == null ? (
          <div style={{ color: '#888' }}>{t('Select a partner to manage its API keys')}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table
              rowKey="id"
              size="small"
              columns={keyColumns}
              dataSource={selectedPartnerKeys}
              loading={keysLoading}
              pagination={false}
              scroll={{ x: 900 }}
            />
          </div>
        )}
      </Card>

      <Modal
        title={editingPartner ? (t('Edit Partner') as string) : (t('Create Partner') as string)}
        open={partnerModalOpen}
        onOk={onSavePartner}
        onCancel={() => setPartnerModalOpen(false)}
        confirmLoading={partnerSaving}
        okText={t('Save') as string}
        cancelText={t('Cancel') as string}
      >
        <Form form={partnerForm} layout="vertical">
          <Form.Item name="name" label={t('Name') as string} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="contactEmail" label={t('Contact Email') as string}>
            <Input />
          </Form.Item>
          <Form.Item name="notes" label={t('Notes') as string}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled') as string} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('Create API Key') as string}
        open={keyModalOpen}
        onOk={onSaveKey}
        onCancel={() => setKeyModalOpen(false)}
        confirmLoading={keySaving}
        okText={t('Save') as string}
        cancelText={t('Cancel') as string}
      >
        <Form form={keyForm} layout="vertical">
          <Form.Item label={t('Partner') as string}>
            <Input value={selectedPartner?.name ?? ''} disabled />
          </Form.Item>
          <Form.Item name="name" label={t('Name') as string} rules={[{ required: true }]}>
            <Input />
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

export default PartnersPage;
