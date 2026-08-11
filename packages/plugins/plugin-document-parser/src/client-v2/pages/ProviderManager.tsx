import React, { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';

const { Text } = Typography;

type JsonValue = Record<string, unknown>;

type Provider = {
  id: string | number;
  title: string;
  enabled: boolean;
  apiEndpoint: string;
  authType: 'bearer' | 'api-key-header' | 'basic' | 'custom-headers' | 'none';
  apiKey?: string;
  authConfig?: {
    headerName?: string;
    username?: string;
    password?: string;
    customHeaders?: Record<string, string>;
  };
  requestFormat: 'multipart' | 'json-base64' | 'url';
  requestConfig?: {
    fileFieldName?: string;
    filenameFieldName?: string;
    mimetypeFieldName?: string;
    extraFields?: Record<string, string>;
    base64FieldPath?: string;
    filenameFieldPath?: string;
    mimetypeFieldPath?: string;
    extraBody?: JsonValue;
    urlFieldPath?: string;
  };
  responseTextPath?: string;
  timeout?: number;
  supportedMimetypes?: string[];
};

type ProviderFormValues = Omit<Provider, 'id' | 'authConfig' | 'requestConfig'> & {
  authConfig?: Omit<NonNullable<Provider['authConfig']>, 'customHeaders'> & { customHeaders?: string };
  requestConfig?: Omit<NonNullable<Provider['requestConfig']>, 'extraFields' | 'extraBody'> & {
    extraFields?: string;
    extraBody?: string;
  };
};

type ProviderManagerProps = {
  onProvidersChanged(providers: Provider[]): void;
};

export function ProviderManager({ onProvidersChanged }: ProviderManagerProps) {
  const ctx = useFlowContext();
  const t = useT();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | number>();
  const [editing, setEditing] = useState<Provider>();
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await ctx.api.request({
        url: 'docParserProviders:list',
        method: 'get',
        params: { pageSize: 200 },
      });
      const data = unwrapData<Provider[]>(response, []);
      setProviders(data);
      onProvidersChanged(data);
    } catch (error) {
      message.error(errorMessage(error, t));
    } finally {
      setLoading(false);
    }
  }, [ctx.api, onProvidersChanged, t]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (id: string | number) => {
    try {
      await ctx.api.request({ url: 'docParserProviders:destroy', method: 'delete', params: { filterByTk: id } });
      message.success(t('Provider deleted'));
      await load();
    } catch (error) {
      message.error(errorMessage(error, t));
    }
  };

  const test = async (provider: Provider) => {
    setTestingId(provider.id);
    try {
      const response = await ctx.api.request({
        url: 'docParserProviders:testConnection',
        method: 'get',
        params: { filterByTk: provider.id },
      });
      const result = unwrapData<{ ok?: boolean; status?: number; message?: string }>(response, {});
      if (result.ok) {
        message.success(`${t('Connection successful')}${result.status ? ` (HTTP ${result.status})` : ''}`);
      } else {
        message.error(`${t('Connection failed')}: ${result.message ?? t('Request failed')}`);
      }
    } catch (error) {
      message.error(`${t('Connection failed')}: ${errorMessage(error, t)}`);
    } finally {
      setTestingId(undefined);
    }
  };

  const columns = [
    {
      title: t('Provider Title'),
      dataIndex: 'title',
      render: (title: string, provider: Provider) => (
        <Space>
          <Badge status={provider.enabled ? 'success' : 'default'} />
          {title}
        </Space>
      ),
    },
    { title: t('API Endpoint'), dataIndex: 'apiEndpoint', ellipsis: true },
    { title: t('Auth Type'), dataIndex: 'authType', render: (value: string) => <Tag>{value}</Tag> },
    {
      title: t('Request Format'),
      dataIndex: 'requestFormat',
      render: (value: string) => <Tag color="blue">{value}</Tag>,
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      render: (enabled: boolean) =>
        enabled ? (
          <CheckCircleOutlined style={{ color: '#52c41a' }} />
        ) : (
          <CloseCircleOutlined style={{ color: '#ccc' }} />
        ),
    },
    {
      title: t('Actions'),
      render: (_: unknown, provider: Provider) => (
        <Space>
          <Tooltip title={t('Test Connection')}>
            <Button
              size="small"
              icon={<ApiOutlined />}
              loading={testingId === provider.id}
              onClick={() => test(provider)}
            />
          </Tooltip>
          <Tooltip title={t('Edit Provider')}>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditing(provider);
                setOpen(true);
              }}
            />
          </Tooltip>
          <Popconfirm
            title={t('Delete Provider')}
            description={t('Confirm provider deletion')}
            onConfirm={() => remove(provider.id)}
          >
            <Tooltip title={t('Delete Provider')}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <CardTitleAction
        onAdd={() => {
          setEditing(undefined);
          setOpen(true);
        }}
        label={t('Add Provider')}
      />
      <Table
        rowKey="id"
        dataSource={providers}
        columns={columns}
        loading={loading}
        pagination={false}
        locale={{ emptyText: t('No providers configured') }}
      />
      <ProviderModal open={open} provider={editing} onClose={() => setOpen(false)} onSaved={load} />
    </>
  );
}

function CardTitleAction({ onAdd, label }: { onAdd(): void; label: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
      <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>
        {label}
      </Button>
    </div>
  );
}

function ProviderModal({
  open,
  provider,
  onClose,
  onSaved,
}: {
  open: boolean;
  provider?: Provider;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<ProviderFormValues>();
  const [saving, setSaving] = useState(false);
  const authType = Form.useWatch('authType', form);
  const requestFormat = Form.useWatch('requestFormat', form);

  useEffect(() => {
    if (open) form.setFieldsValue(toFormValues(provider));
  }, [form, open, provider]);

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = normalizeProvider(values);
      if (provider) {
        await ctx.api.request({
          url: 'docParserProviders:update',
          method: 'post',
          params: { filterByTk: provider.id },
          data: payload,
        });
      } else {
        await ctx.api.request({ url: 'docParserProviders:create', method: 'post', data: payload });
      }
      message.success(t('Provider saved'));
      onClose();
      await onSaved();
    } catch (error) {
      message.error(errorMessage(error, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={provider ? t('Edit Provider') : t('Add Provider')}
      onCancel={onClose}
      onOk={save}
      okText={t('Save')}
      cancelText={t('Cancel')}
      confirmLoading={saving}
      width={760}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col span={18}>
            <Form.Item name="title" label={t('Provider Title')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="apiEndpoint" label={t('API Endpoint')} rules={[{ required: true, type: 'url' }]}>
          <Input />
        </Form.Item>
        <Divider orientation="left" plain>
          {t('Auth Type')}
        </Divider>
        <Form.Item name="authType" label={t('Auth Type')}>
          <Select
            options={[
              { label: t('None'), value: 'none' },
              { label: t('Bearer Token'), value: 'bearer' },
              { label: t('API Key Header'), value: 'api-key-header' },
              { label: t('Basic Auth'), value: 'basic' },
              { label: t('Custom Headers'), value: 'custom-headers' },
            ]}
          />
        </Form.Item>
        {authType === 'bearer' || authType === 'api-key-header' ? (
          <Form.Item name="apiKey" label={t('API Key')}>
            <Input.Password />
          </Form.Item>
        ) : null}
        {authType === 'api-key-header' ? (
          <Form.Item name={['authConfig', 'headerName']} label={t('Header Name')}>
            <Input placeholder="X-Api-Key" />
          </Form.Item>
        ) : null}
        {authType === 'basic' ? (
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name={['authConfig', 'username']} label={t('Username')}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name={['authConfig', 'password']} label={t('Password')}>
                <Input.Password />
              </Form.Item>
            </Col>
          </Row>
        ) : null}
        {authType === 'custom-headers' ? (
          <JsonTextArea name={['authConfig', 'customHeaders']} label={t('Custom Headers')} t={t} />
        ) : null}
        <Divider orientation="left" plain>
          {t('Request Format')}
        </Divider>
        <Form.Item name="requestFormat" label={t('Request Format')}>
          <Select
            options={[
              { label: t('Multipart Form Data'), value: 'multipart' },
              { label: t('JSON Base64'), value: 'json-base64' },
              { label: t('URL (provider fetches)'), value: 'url' },
            ]}
          />
        </Form.Item>
        {requestFormat === 'multipart' ? (
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name={['requestConfig', 'fileFieldName']} label={t('Form Field Name')}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name={['requestConfig', 'filenameFieldName']} label={t('Filename Field Path')}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name={['requestConfig', 'mimetypeFieldName']} label={t('Mimetype Field Path')}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
        ) : null}
        {requestFormat === 'json-base64' ? (
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name={['requestConfig', 'base64FieldPath']} label={t('Base64 Field Path')}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name={['requestConfig', 'filenameFieldPath']} label={t('Filename Field Path')}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name={['requestConfig', 'mimetypeFieldPath']} label={t('Mimetype Field Path')}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
        ) : null}
        {requestFormat === 'url' ? (
          <Form.Item name={['requestConfig', 'urlFieldPath']} label={t('URL Field Path')}>
            <Input />
          </Form.Item>
        ) : null}
        <JsonTextArea
          name={['requestConfig', requestFormat === 'multipart' ? 'extraFields' : 'extraBody']}
          label={t('Extra Request Body')}
          t={t}
        />
        <Divider orientation="left" plain>
          {t('Response')}
        </Divider>
        <Row gutter={16}>
          <Col span={16}>
            <Form.Item name="responseTextPath" label={t('Response Text Path')}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="timeout" label={t('Timeout (ms)')}>
              <InputNumber min={1000} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Divider orientation="left" plain>
          {t('Scope')}
        </Divider>
        <Form.Item
          name="supportedMimetypes"
          label={t('Supported MIME Types')}
          extra={t('Leave empty to handle all non-image types')}
        >
          <Select mode="tags" tokenSeparators={[',']} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function JsonTextArea({ name, label, t }: { name: (string | number)[]; label: string; t: (key: string) => string }) {
  return (
    <Form.Item
      name={name}
      label={label}
      rules={[
        {
          validator: (_, value: string | undefined) =>
            isJsonObject(value) ? Promise.resolve() : Promise.reject(new Error(t('Must be valid JSON'))),
        },
      ]}
    >
      <Input.TextArea rows={3} />
    </Form.Item>
  );
}

function toFormValues(provider?: Provider): ProviderFormValues {
  if (!provider)
    return {
      enabled: true,
      authType: 'bearer',
      requestFormat: 'multipart',
      responseTextPath: 'text',
      timeout: 60_000,
      requestConfig: { fileFieldName: 'file' },
      title: '',
      apiEndpoint: '',
    };
  return {
    ...provider,
    authConfig: { ...provider.authConfig, customHeaders: stringify(provider.authConfig?.customHeaders) },
    requestConfig: {
      ...provider.requestConfig,
      extraFields: stringify(provider.requestConfig?.extraFields),
      extraBody: stringify(provider.requestConfig?.extraBody),
    },
  };
}

function normalizeProvider(values: ProviderFormValues): Omit<Provider, 'id'> {
  return {
    ...values,
    authConfig: values.authConfig
      ? { ...values.authConfig, customHeaders: parseJsonStringMap(values.authConfig.customHeaders) }
      : undefined,
    requestConfig: values.requestConfig
      ? {
          ...values.requestConfig,
          extraFields: parseJsonStringMap(values.requestConfig.extraFields),
          extraBody: parseJsonObject(values.requestConfig.extraBody),
        }
      : undefined,
  };
}

function stringify(value: unknown): string | undefined {
  return value && typeof value === 'object' ? JSON.stringify(value, null, 2) : undefined;
}
function isJsonObject(value: string | undefined): boolean {
  try {
    parseJsonObject(value);
    return true;
  } catch {
    return false;
  }
}
function parseJsonObject(value: string | undefined): JsonValue | undefined {
  if (!value?.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('Expected a JSON object.');
  return parsed;
}
function parseJsonStringMap(value: string | undefined): Record<string, string> | undefined {
  const parsed = parseJsonObject(value);
  if (parsed && Object.values(parsed).some((entry) => typeof entry !== 'string'))
    throw new Error('Expected a JSON object with string values.');
  return parsed as Record<string, string> | undefined;
}
function unwrapData<T>(response: unknown, fallback: T): T {
  return isRecord(response) && isRecord(response.data) && 'data' in response.data
    ? (response.data.data as T | undefined) ?? fallback
    : fallback;
}
function errorMessage(error: unknown, t: (key: string) => string): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : t('Request failed');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
