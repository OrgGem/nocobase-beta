import React, { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select, Space, Switch, message } from 'antd';
import { useAPIClient, useRequest } from '../adapters';
import { useCarboneTranslation } from '../locale';
import { COLLECTION, SUPPORTED_OUTPUT_FORMATS } from '../../shared/constants';

interface SettingsForm {
  endpoint: string;
  apiToken?: string;
  apiTokenSet?: boolean;
  carboneVersion: string;
  timeoutMs: number;
  maxRetries: number;
  defaultOutputFormat: string;
  enableCache: boolean;
  cacheTTL: number;
  enableMonitoring: boolean;
  monitoringRetentionDays: number;
  rateLimitPerMinute: number;
  outputStorageId?: number | null;
  cacheStorageId?: number | null;
  backupStorageId?: number | null;
}

/**
 * Connection settings form. Loads the singleton config row, lets the admin
 * edit it and ping the Carbone server.
 */
export const ConnectionSettings: React.FC = () => {
  const { t } = useCarboneTranslation();
  const api = useAPIClient();
  const [form] = Form.useForm<SettingsForm>();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data, loading, refresh } = useRequest<{ data: SettingsForm }>(
    () =>
      api
        .resource(COLLECTION.settings)
        .get()
        .then((r: any) => r.data),
    { refreshDeps: [] },
  );

  useEffect(() => {
    if (data?.data) form.setFieldsValue(data.data);
  }, [data, form]);

  const onSave = async () => {
    const values = await form.validateFields();
    // Don't overwrite the stored token with an empty string when the field is left blank.
    if (!values.apiToken) delete values.apiToken;
    await api.resource(COLLECTION.settings).save({ values });
    message.success(t('Settings saved'));
    refresh();
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const values = form.getFieldsValue();
      const res: any = await api.resource(COLLECTION.settings).testConnection({ values });
      const body = res?.data?.data || res?.data;
      setTestResult({
        ok: !!body?.ok,
        message: body?.ok
          ? t('Connected to Carbone successfully')
          : `${t('Connection failed')}: ${typeof body?.error === 'string' ? body.error : JSON.stringify(body?.error)}`,
      });
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message ?? String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Form form={form} layout="vertical" disabled={loading}>
      <Form.Item label={t('Endpoint')} name="endpoint" rules={[{ required: true }]}>
        <Input placeholder="http://carbone:4000" />
      </Form.Item>

      <Form.Item
        label={t('API token')}
        name="apiToken"
        extra={data?.data?.apiTokenSet ? t('A token is already saved. Leave blank to keep it.') : undefined}
      >
        <Input.Password placeholder={data?.data?.apiTokenSet ? '••••••••' : ''} autoComplete="off" />
      </Form.Item>

      <Space size="large" wrap>
        <Form.Item label={t('Carbone version')} name="carboneVersion">
          <Input style={{ width: 100 }} />
        </Form.Item>
        <Form.Item label={t('Timeout (ms)')} name="timeoutMs">
          <InputNumber min={1000} step={1000} />
        </Form.Item>
        <Form.Item label={t('Max retries')} name="maxRetries">
          <InputNumber min={0} max={10} />
        </Form.Item>
        <Form.Item label={t('Default output format')} name="defaultOutputFormat">
          <Select
            style={{ width: 140 }}
            options={SUPPORTED_OUTPUT_FORMATS.map((f) => ({ label: f.toUpperCase(), value: f }))}
          />
        </Form.Item>
      </Space>

      <Space size="large" wrap>
        <Form.Item label={t('Enable cache')} name="enableCache" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label={t('Cache TTL (s)')} name="cacheTTL">
          <InputNumber min={0} step={60} />
        </Form.Item>
        <Form.Item label={t('Enable monitoring')} name="enableMonitoring" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label={t('Log retention (days)')} name="monitoringRetentionDays">
          <InputNumber min={1} max={365} />
        </Form.Item>
        <Form.Item label={t('Rate limit (req/min)')} name="rateLimitPerMinute">
          <InputNumber min={0} />
        </Form.Item>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('File storage')}
        description={t(
          'Pick any storage registered in the File Manager plugin (local, S3, SFTP, OSS …) for output, cache and template backups. Leave blank to use the file-manager default storage.',
        )}
      />

      <Space size="large" wrap>
        <Form.Item label={t('Output storage')} name="outputStorageId">
          <StorageSelect />
        </Form.Item>
        <Form.Item label={t('Cache storage')} name="cacheStorageId">
          <StorageSelect />
        </Form.Item>
        <Form.Item label={t('Backup storage')} name="backupStorageId">
          <StorageSelect />
        </Form.Item>
      </Space>

      <Space>
        <Button type="primary" onClick={onSave}>
          {t('Save')}
        </Button>
        <Button loading={testing} onClick={onTest}>
          {t('Test connection')}
        </Button>
      </Space>

      {testResult && (
        <Alert
          style={{ marginTop: 16 }}
          type={testResult.ok ? 'success' : 'error'}
          message={testResult.message}
          showIcon
        />
      )}
    </Form>
  );
};

/**
 * Dropdown that lists storages registered by `plugin-file-manager`.
 * Only id+title+name are needed; we go through the public `storages:list` action.
 */
const StorageSelect: React.FC<{ value?: number | null; onChange?: (v: number | null) => void }> = ({
  value,
  onChange,
}) => {
  const api = useAPIClient();
  const { data, loading } = useRequest<{ data: Array<{ id: number; title: string; name: string }> }>(
    () =>
      api
        .resource('storages')
        .list({ pageSize: 200, fields: ['id', 'title', 'name'] })
        .then((r: any) => r.data),
    { refreshDeps: [] },
  );
  return (
    <Select
      allowClear
      loading={loading}
      style={{ width: 240 }}
      value={value ?? undefined}
      onChange={(v) => onChange?.(v ?? null)}
      options={(data?.data || []).map((s) => ({
        label: `${s.title || s.name} (#${s.id})`,
        value: s.id,
      }))}
    />
  );
};

export default ConnectionSettings;
