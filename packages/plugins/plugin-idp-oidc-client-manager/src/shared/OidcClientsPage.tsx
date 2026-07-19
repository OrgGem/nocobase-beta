import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Form, Input, message, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { BookOutlined, CopyOutlined, DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons';
import IntegrationGuide from './IntegrationGuide';
import type { GuideProviderInfo } from './IntegrationGuide';

type ApiResponse = { data?: { data?: unknown } };
export type ApiClientLike = {
  request(options: { url: string; method?: string; data?: unknown }): Promise<ApiResponse>;
};
export type ClientRecord = {
  id: number;
  name: string;
  clientId: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  clientType: 'confidential' | 'public';
  allowDynamicLoopbackPort: boolean;
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
  autoApprove: boolean;
  enabled: boolean;
};
type FormValues = Omit<ClientRecord, 'id' | 'redirectUris' | 'postLogoutRedirectUris'> & {
  redirectUrisText: string;
  postLogoutRedirectUrisText?: string;
};
type Props = { api: ApiClientLike; t: (key: string) => string };

function readPayload(response: ApiResponse): unknown {
  return response.data?.data;
}
function isClientRecord(value: unknown): value is ClientRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ClientRecord>;
  return typeof record.id === 'number' && typeof record.clientId === 'string' && Array.isArray(record.redirectUris);
}
function lines(value?: string) {
  return (value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function OidcClientsPage({ api, t }: Props) {
  const [form] = Form.useForm<FormValues>();
  const selectedClientType = Form.useWatch('clientType', form) || 'confidential';
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ClientRecord | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
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
      tokenEndpointAuthMethod: 'client_secret_basic',
      scopes: ['openid', 'profile', 'email'],
      clientType: 'confidential',
      allowDynamicLoopbackPort: false,
      autoApprove: false,
      enabled: true,
    });
    setFormOpen(true);
  };
  const openEdit = (record: ClientRecord) => {
    setEditing(record);
    form.setFieldsValue({
      ...record,
      redirectUrisText: record.redirectUris.join('\n'),
      postLogoutRedirectUrisText: record.postLogoutRedirectUris.join('\n'),
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
      tokenEndpointAuthMethod: values.tokenEndpointAuthMethod,
      scopes: values.scopes,
      clientType: values.clientType,
      allowDynamicLoopbackPort: values.allowDynamicLoopbackPort,
      autoApprove: values.autoApprove,
      enabled: values.enabled,
    };
    const response = await api.request({
      url: editing ? `oidcClientManager:update/${editing.id}` : 'oidcClientManager:create',
      method: 'post',
      data,
    });
    const payload = readPayload(response);
    if (
      !editing &&
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { clientSecret?: unknown }).clientSecret === 'string'
    )
      setSecret((payload as { clientSecret: string }).clientSecret);
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
  const resetSecret = (record: ClientRecord) =>
    Modal.confirm({
      title: t('Reset client secret?'),
      content: t('The current secret will stop working immediately.'),
      onOk: async () => {
        const response = await api.request({ url: `oidcClientManager:resetSecret/${record.id}`, method: 'post' });
        const payload = readPayload(response);
        if (
          payload &&
          typeof payload === 'object' &&
          typeof (payload as { clientSecret?: unknown }).clientSecret === 'string'
        )
          setSecret((payload as { clientSecret: string }).clientSecret);
      },
    });
  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    message.success(t('Copied'));
  };

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
              render: (value: ClientRecord['clientType']) => t(value === 'public' ? 'Public' : 'Confidential'),
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
              width: 220,
              render: (_value, record) => (
                <Space>
                  <Button aria-label={t('Edit')} icon={<EditOutlined />} onClick={() => openEdit(record)} />
                  <Button
                    aria-label={t('Integration guide')}
                    icon={<BookOutlined />}
                    onClick={() => setGuideClient(record)}
                  />
                  {record.clientType !== 'public' ? (
                    <Button aria-label={t('Reset secret')} icon={<KeyOutlined />} onClick={() => resetSecret(record)} />
                  ) : null}
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
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="clientId" label={t('Client ID')} rules={[{ required: true }]}>
            <Input disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item name="clientType" label={t('Client type')} rules={[{ required: true }]}>
            <Select
              disabled={Boolean(editing)}
              options={[
                { value: 'confidential', label: t('Confidential — uses client secret') },
                { value: 'public', label: t('Public / native — PKCE without client secret') },
              ]}
            />
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
          {selectedClientType === 'confidential' ? (
            <Form.Item
              name="tokenEndpointAuthMethod"
              label={t('Token endpoint authentication')}
              rules={[{ required: true }]}
            >
              <Select
                options={[
                  { value: 'client_secret_basic', label: 'client_secret_basic' },
                  { value: 'client_secret_post', label: 'client_secret_post' },
                ]}
              />
            </Form.Item>
          ) : (
            <Form.Item label={t('Token endpoint authentication')}>
              <Input value="none" disabled />
            </Form.Item>
          )}
          {selectedClientType === 'public' ? (
            <Form.Item
              name="allowDynamicLoopbackPort"
              label={t('Allow dynamic loopback redirect port')}
              extra={t('The actual redirect URI may use any port, but its loopback host and path must match exactly.')}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          ) : null}
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
          <Form.Item
            name="autoApprove"
            label={t('Skip consent confirmation')}
            extra={t('After login, immediately redirect to the callback without asking the user to confirm access.')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
      <IntegrationGuide client={guideClient} provider={providerInfo} t={t} onClose={() => setGuideClient(null)} />
      <Modal
        title={t('Client secret')}
        open={Boolean(secret)}
        onCancel={() => setSecret(null)}
        footer={
          <Button type="primary" onClick={() => setSecret(null)}>
            {t('I have saved the secret')}
          </Button>
        }
      >
        <Typography.Paragraph type="warning">
          {t('This secret is shown only once. Store it in the application secret manager now.')}
        </Typography.Paragraph>
        <Input
          value={secret || ''}
          readOnly
          suffix={
            <Button type="text" aria-label={t('Copy')} icon={<CopyOutlined />} onClick={() => secret && copy(secret)} />
          }
        />
      </Modal>
    </Space>
  );
}

export default OidcClientsPage;
