import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, message, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { BookOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import IntegrationGuide from './IntegrationGuide';
import type { GuideProviderInfo } from './IntegrationGuide';

type ApiResponse = { data?: { data?: unknown } };
export type ApiClientLike = {
  request(options: {
    url: string;
    method?: string;
    data?: unknown;
    params?: Record<string, unknown>;
  }): Promise<ApiResponse>;
};

export type ClientRecord = {
  id: number;
  name: string;
  clientId: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  clientType: 'public';
  allowDynamicLoopbackPort: boolean;
  tokenEndpointAuthMethod: 'none';
  enabled: boolean;
};

type FormValues = {
  name: string;
  clientId: string;
  redirectUrisText: string;
  postLogoutRedirectUrisText?: string;
  scopes: string[];
  allowDynamicLoopbackPort: boolean;
  enabled: boolean;
};

type Props = { api: ApiClientLike; t: (key: string) => string };

function readPayload(response: ApiResponse): unknown {
  return response.data?.data;
}

function isClientRecord(value: unknown): value is ClientRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ClientRecord>;
  return (
    typeof record.id === 'number' &&
    typeof record.clientId === 'string' &&
    record.clientType === 'public' &&
    Array.isArray(record.redirectUris)
  );
}

function lines(value?: string) {
  return (value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function OidcClientsPage({ api, t }: Props) {
  const [form] = Form.useForm<FormValues>();
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ClientRecord | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [guideClient, setGuideClient] = useState<ClientRecord | null>(null);
  const [providerInfo, setProviderInfo] = useState<GuideProviderInfo>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [clientResponse, providerResponse] = await Promise.all([
        api.request({ url: 'oidcClientManager:list' }),
        api.request({ url: 'oidcClientManager:providerInfo' }),
      ]);
      const payload = readPayload(clientResponse);
      setClients(Array.isArray(payload) ? payload.filter(isClientRecord) : []);
      const info = readPayload(providerResponse);
      setProviderInfo(info && typeof info === 'object' ? (info as GuideProviderInfo) : {});
    } catch {
      message.error(t('Failed to load OIDC applications'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      name: '',
      clientId: '',
      redirectUrisText: '',
      postLogoutRedirectUrisText: '',
      scopes: ['openid', 'profile', 'email'],
      allowDynamicLoopbackPort: false,
      enabled: true,
    });
    setFormOpen(true);
  };

  const openEdit = (record: ClientRecord) => {
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      clientId: record.clientId,
      redirectUrisText: record.redirectUris.join('\n'),
      postLogoutRedirectUrisText: record.postLogoutRedirectUris.join('\n'),
      scopes: record.scopes,
      allowDynamicLoopbackPort: record.allowDynamicLoopbackPort,
      enabled: record.enabled,
    });
    setFormOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    const data = {
      name: values.name,
      clientId: values.clientId,
      redirectUris: lines(values.redirectUrisText),
      postLogoutRedirectUris: lines(values.postLogoutRedirectUrisText),
      scopes: values.scopes,
      clientType: 'public' as const,
      allowDynamicLoopbackPort: values.allowDynamicLoopbackPort,
      tokenEndpointAuthMethod: 'none' as const,
      enabled: values.enabled,
    };
    await api.request({
      url: editing ? `oidcClientManager:update/${editing.id}` : 'oidcClientManager:create',
      method: 'post',
      data,
    });
    setFormOpen(false);
    message.success(t(editing ? 'OIDC application updated' : 'OIDC application created'));
    await load();
  };

  const remove = (record: ClientRecord) =>
    Modal.confirm({
      title: t('Delete OIDC application?'),
      content: record.name,
      okButtonProps: { danger: true },
      onOk: async () => {
        await api.request({ url: `oidcClientManager:destroy/${record.id}`, method: 'post' });
        message.success(t('OIDC application deleted'));
        await load();
      },
    });

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={t('Provider information')}>
        <Typography.Text type="secondary">{t('Issuer')}</Typography.Text>
        <Typography.Paragraph copyable>{providerInfo.issuer || '-'}</Typography.Paragraph>
        <Typography.Text type="secondary">{t('Discovery URL')}</Typography.Text>
        <Typography.Paragraph copyable>{providerInfo.discoveryUrl || '-'}</Typography.Paragraph>
        <Typography.Text type="secondary">{t('Supported scopes')}</Typography.Text>
        <Typography.Paragraph>
          {(providerInfo.supportedScopes || []).map((scope) => (
            <Tag key={scope}>{scope}</Tag>
          ))}
        </Typography.Paragraph>
      </Card>
      <Card
        title={t('OIDC applications')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('Add application')}
          </Button>
        }
      >
        <Table<ClientRecord>
          rowKey="id"
          loading={loading}
          dataSource={clients}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: t('Name'), dataIndex: 'name', width: 180 },
            {
              title: t('Client ID'),
              dataIndex: 'clientId',
              width: 220,
              render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
            },
            {
              title: t('Callback URLs'),
              dataIndex: 'redirectUris',
              width: 280,
              render: (values: string[]) =>
                values.map((value) => (
                  <div key={value}>
                    <Typography.Text code>{value}</Typography.Text>
                  </div>
                )),
            },
            {
              title: t('Client type'),
              dataIndex: 'clientType',
              width: 130,
              render: () => t('Public'),
            },
            {
              title: t('Status'),
              dataIndex: 'enabled',
              width: 100,
              render: (enabled: boolean) => (
                <Tag color={enabled ? 'green' : 'default'}>{t(enabled ? 'Enabled' : 'Disabled')}</Tag>
              ),
            },
            {
              title: t('Scopes'),
              dataIndex: 'scopes',
              width: 220,
              render: (values: string[]) => values.map((value) => <Tag key={value}>{value}</Tag>),
            },
            {
              title: t('Actions'),
              key: 'actions',
              fixed: 'right',
              width: 180,
              render: (_value, record) => (
                <Space>
                  <Button aria-label={t('Edit')} icon={<EditOutlined />} onClick={() => openEdit(record)} />
                  <Button
                    aria-label={t('Integration guide')}
                    icon={<BookOutlined />}
                    onClick={() => setGuideClient(record)}
                  />
                  <Button danger aria-label={t('Delete')} icon={<DeleteOutlined />} onClick={() => remove(record)} />
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title={t(editing ? 'Edit OIDC application' : 'Add OIDC application')}
        open={formOpen}
        onOk={save}
        onCancel={() => setFormOpen(false)}
        destroyOnClose
      >
        <Alert type="info" showIcon message={t('Only public clients are supported. Client secrets are disabled.')} />
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="clientId" label={t('Client ID')} rules={[{ required: true }]}>
            <Input disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item label={t('Client type')}>
            <Input value={t('Public')} disabled />
          </Form.Item>
          <Form.Item
            name="redirectUrisText"
            label={t('Callback URLs')}
            extra={t('Enter one exact URL per line. HTTPS is required except for localhost.')}
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item
            name="postLogoutRedirectUrisText"
            label={t('Post logout callback URLs')}
            extra={t('Enter one exact URL per line.')}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label={t('Token endpoint authentication')}>
            <Input value="none" disabled />
          </Form.Item>
          <Form.Item
            name="allowDynamicLoopbackPort"
            label={t('Allow dynamic loopback redirect port')}
            extra={t('The actual redirect URI may use any port, but its loopback host and path must match exactly.')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="scopes"
            label={t('Allowed scopes')}
            extra={t('The application can only request scopes selected here.')}
            rules={[{ required: true }]}
          >
            <Select
              mode="multiple"
              options={(providerInfo.supportedScopes || ['openid', 'profile', 'email', 'offline_access', 'api']).map(
                (scope) => ({ value: scope, label: scope }),
              )}
            />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
      <IntegrationGuide client={guideClient} provider={providerInfo} t={t} onClose={() => setGuideClient(null)} />
    </Space>
  );
}

export default OidcClientsPage;
