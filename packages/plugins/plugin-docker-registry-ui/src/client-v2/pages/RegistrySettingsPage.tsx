import React from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { ApiOutlined, SaveOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import type { RegistrySettingsInput } from '../../shared/types';
import { registryApi } from '../api';
import { useT } from '../locale';
import { type DockerRegistryPageProps, useDockerRegistryPermissions } from '../permissions';
import { isRegistryUrl } from '../validation';

interface RegistrySettingsFormValues {
  displayName?: RegistrySettingsInput['displayName'];
  registryUrl?: RegistrySettingsInput['registryUrl'];
  publicRegistryHost?: RegistrySettingsInput['publicRegistryHost'];
  credentialMode?: RegistrySettingsInput['credentialMode'];
  username?: RegistrySettingsInput['username'];
  password?: RegistrySettingsInput['password'];
  bearerToken?: RegistrySettingsInput['bearerToken'];
  verifyTls?: RegistrySettingsInput['verifyTls'];
  allowInsecureHttp?: RegistrySettingsInput['allowInsecureHttp'];
  caCertificate?: RegistrySettingsInput['caCertificate'];
  clientCertificate?: RegistrySettingsInput['clientCertificate'];
  clientPrivateKey?: RegistrySettingsInput['clientPrivateKey'];
  clientPrivateKeyPassphrase?: RegistrySettingsInput['clientPrivateKeyPassphrase'];
  requestTimeoutMs?: RegistrySettingsInput['requestTimeoutMs'];
  catalogPageSize?: RegistrySettingsInput['catalogPageSize'];
  maxConcurrentRequests?: RegistrySettingsInput['maxConcurrentRequests'];
  autoRefreshSeconds?: RegistrySettingsInput['autoRefreshSeconds'];
  deleteEnabled?: RegistrySettingsInput['deleteEnabled'];
  rawManifestEnabled?: RegistrySettingsInput['rawManifestEnabled'];
  showLegacySchema1?: RegistrySettingsInput['showLegacySchema1'];
  maxTransferSizeMb?: RegistrySettingsInput['maxTransferSizeMb'];
  uploadChunkSizeMb?: RegistrySettingsInput['uploadChunkSizeMb'];
  transferTimeoutMs?: RegistrySettingsInput['transferTimeoutMs'];
  maxDownloadSpeedKbps?: RegistrySettingsInput['maxDownloadSpeedKbps'];
  maxUploadSpeedKbps?: RegistrySettingsInput['maxUploadSpeedKbps'];
  clearPassword?: RegistrySettingsInput['clearPassword'];
  clearBearerToken?: RegistrySettingsInput['clearBearerToken'];
  clearClientPrivateKey?: RegistrySettingsInput['clearClientPrivateKey'];
  clearClientPrivateKeyPassphrase?: RegistrySettingsInput['clearClientPrivateKeyPassphrase'];
}

export default function RegistrySettingsPage({ permissions }: DockerRegistryPageProps) {
  const ctx = useFlowContext();
  const t = useT();
  const aclPermissions = useDockerRegistryPermissions();
  const { canConfigure } = permissions ?? aclPermissions;
  const [form] = Form.useForm<RegistrySettingsFormValues>();
  const {
    data: settings,
    loading,
    mutate: setSettings,
  } = useRequest(() => registryApi.getSettings(ctx), {
    ready: canConfigure,
    onSuccess(value) {
      form.setFieldsValue(value);
    },
  });
  const {
    runAsync: save,
    loading: saving,
    error: saveError,
  } = useRequest(
    async (values: RegistrySettingsInput) => {
      const result = await registryApi.updateSettings(ctx, values);
      setSettings(result);
      form.setFieldsValue(result);
      form.resetFields([
        'password',
        'bearerToken',
        'clientPrivateKey',
        'clientPrivateKeyPassphrase',
        'clearPassword',
        'clearBearerToken',
        'clearClientPrivateKey',
        'clearClientPrivateKeyPassphrase',
      ]);
      ctx.message.success(t('Settings saved'));
      return result;
    },
    { manual: true },
  );
  const {
    runAsync: testConnection,
    data: connection,
    loading: testing,
    error: testError,
  } = useRequest((values: RegistrySettingsInput) => registryApi.testConnectionDraft(ctx, values), { manual: true });

  const handleSave = async () => {
    try {
      await save(await form.validateFields());
    } catch {
      // useRequest exposes the error below the form.
    }
  };

  const handleTestConnection = async () => {
    try {
      await testConnection(await form.validateFields());
    } catch {
      // useRequest exposes the error below the form.
    }
  };

  if (!canConfigure) {
    return (
      <Alert type="error" showIcon message={t('You do not have permission to manage Docker Registry settings.')} />
    );
  }

  return (
    <Card
      title={
        <Space>
          <ApiOutlined />
          {t('Docker Registry settings')}
        </Space>
      }
      loading={loading}
      style={{ maxWidth: 920 }}
    >
      <Alert
        type="info"
        showIcon
        message={t('The NocoBase server connects to the Registry. Credentials never return to your browser.')}
        style={{ marginBottom: 24 }}
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          credentialMode: 'anonymous',
          verifyTls: true,
          requestTimeoutMs: 10000,
          catalogPageSize: 100,
          maxConcurrentRequests: 5,
          maxDownloadSpeedKbps: 0,
          maxUploadSpeedKbps: 0,
          autoRefreshSeconds: 0,
          deleteEnabled: false,
          rawManifestEnabled: true,
        }}
      >
        <Typography.Title level={4}>{t('Connection')}</Typography.Title>
        <Alert
          type="info"
          showIcon
          message={t('Private Registry mode')}
          description={t(
            'Leave blank for private mode. It only enables generated Docker CLI commands and never controls network exposure.',
          )}
          style={{ marginBottom: 16 }}
        />
        <Form.Item
          label={t('Display name')}
          name="displayName"
          rules={[{ required: true, message: t('Please enter a display name') }]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label={t('Internal Registry URL')}
          name="registryUrl"
          rules={[
            { required: true, message: t('Please enter the Registry URL') },
            {
              validator: async (_, value: unknown) => {
                if (!value || isRegistryUrl(value)) return;
                throw new Error(t('Please enter a valid URL'));
              },
            },
          ]}
          extra={t('Example: http://registry:5000 for a Registry container on the same Docker network.')}
        >
          <Input placeholder="https://registry.example.com" autoComplete="off" />
        </Form.Item>
        <Form.Item
          label={t('External Registry host (optional)')}
          name="publicRegistryHost"
          extra={t(
            'Leave blank for private mode. It only enables generated Docker CLI commands and never controls network exposure.',
          )}
        >
          <Input placeholder="registry.example.com" autoComplete="off" />
        </Form.Item>
        <Form.Item label={t('Allow insecure HTTP')} name="allowInsecureHttp" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Divider />
        <Typography.Title level={4}>{t('Authentication')}</Typography.Title>
        <Form.Item label={t('Credential mode')} name="credentialMode">
          <Select
            options={[
              { value: 'anonymous', label: t('Anonymous') },
              { value: 'basic', label: t('Username and password') },
              { value: 'bearer', label: t('Static Bearer token') },
            ]}
          />
        </Form.Item>
        <Form.Item label={t('Username')} name="username">
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item
          label={t('Password')}
          name="password"
          extra={
            settings?.hasPassword ? t('A password is already stored. Leave this field blank to keep it.') : undefined
          }
        >
          <Input.Password autoComplete="new-password" placeholder={settings?.hasPassword ? '••••••••' : undefined} />
        </Form.Item>
        {settings?.hasPassword && (
          <Form.Item name="clearPassword" valuePropName="checked">
            <Checkbox>{t('Clear stored password')}</Checkbox>
          </Form.Item>
        )}
        <Form.Item
          label={t('Bearer token')}
          name="bearerToken"
          extra={
            settings?.hasBearerToken
              ? t('A Bearer token is already stored. Leave this field blank to keep it.')
              : undefined
          }
        >
          <Input.Password autoComplete="new-password" placeholder={settings?.hasBearerToken ? '••••••••' : undefined} />
        </Form.Item>
        {settings?.hasBearerToken && (
          <Form.Item name="clearBearerToken" valuePropName="checked">
            <Checkbox>{t('Clear stored Bearer token')}</Checkbox>
          </Form.Item>
        )}
        <Divider />
        <Typography.Title level={4}>{t('TLS and mTLS')}</Typography.Title>
        <Form.Item label={t('Verify TLS certificate')} name="verifyTls" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label={t('Custom CA certificate')} name="caCertificate">
          <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder="-----BEGIN CERTIFICATE-----" />
        </Form.Item>
        <Form.Item label={t('Client certificate')} name="clientCertificate">
          <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder="-----BEGIN CERTIFICATE-----" />
        </Form.Item>
        <Form.Item
          label={t('Client private key')}
          name="clientPrivateKey"
          extra={
            settings?.hasClientPrivateKey
              ? t('A private key is already stored. Leave this field blank to keep it.')
              : undefined
          }
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {settings?.hasClientPrivateKey && (
          <Form.Item name="clearClientPrivateKey" valuePropName="checked">
            <Checkbox>{t('Clear stored private key')}</Checkbox>
          </Form.Item>
        )}
        <Form.Item
          label={t('Client private key passphrase')}
          name="clientPrivateKeyPassphrase"
          extra={
            settings?.hasClientPrivateKeyPassphrase
              ? t('A passphrase is already stored. Leave this field blank to keep it.')
              : undefined
          }
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {settings?.hasClientPrivateKeyPassphrase && (
          <Form.Item name="clearClientPrivateKeyPassphrase" valuePropName="checked">
            <Checkbox>{t('Clear stored private key passphrase')}</Checkbox>
          </Form.Item>
        )}
        <Divider />
        <Typography.Title level={4}>{t('Behavior')}</Typography.Title>
        <Space size="large" wrap>
          <Form.Item label={t('Request timeout (ms)')} name="requestTimeoutMs">
            <InputNumber min={1000} max={120000} />
          </Form.Item>
          <Form.Item label={t('Catalog page size')} name="catalogPageSize">
            <InputNumber min={1} max={1000} />
          </Form.Item>
          <Form.Item label={t('Maximum concurrent requests')} name="maxConcurrentRequests">
            <InputNumber min={1} max={20} />
          </Form.Item>
          <Form.Item label={t('Auto refresh (seconds)')} name="autoRefreshSeconds">
            <InputNumber min={0} max={86400} />
          </Form.Item>
        </Space>
        <Typography.Title level={4}>{t('Image transfer')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t(
            'Uploads are validated on bounded temporary disk. Registry blobs are transferred in chunks and downloads are streamed.',
          )}
        </Typography.Paragraph>
        <Space size="large" wrap>
          <Form.Item label={t('Maximum transfer size (MB)')} name="maxTransferSizeMb">
            <InputNumber min={1} max={102400} />
          </Form.Item>
          <Form.Item label={t('Registry upload chunk size (MB)')} name="uploadChunkSizeMb">
            <InputNumber min={1} max={64} />
          </Form.Item>
          <Form.Item label={t('Transfer timeout (ms)')} name="transferTimeoutMs">
            <InputNumber min={10000} max={3600000} />
          </Form.Item>
          <Form.Item
            label={t('Maximum download speed (kbps)')}
            name="maxDownloadSpeedKbps"
            extra={t('0 means unlimited bandwidth.')}
          >
            <InputNumber min={0} max={1000000} />
          </Form.Item>
          <Form.Item
            label={t('Maximum upload speed (kbps)')}
            name="maxUploadSpeedKbps"
            extra={t('0 means unlimited bandwidth.')}
          >
            <InputNumber min={0} max={1000000} />
          </Form.Item>
        </Space>
        <Form.Item
          label={t('Enable manifest delete')}
          name="deleteEnabled"
          valuePropName="checked"
          extra={t('Registry storage must also allow delete. Deletion is always performed by manifest digest.')}
        >
          <Switch />
        </Form.Item>
        <Form.Item label={t('Enable raw manifest view')} name="rawManifestEnabled" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label={t('Show legacy Schema 1 manifests')} name="showLegacySchema1" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Space>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>
            {t('Save')}
          </Button>
          <Button onClick={handleTestConnection} loading={testing}>
            {t('Test connection')}
          </Button>
        </Space>
      </Form>
      {connection && (
        <Alert
          style={{ marginTop: 20 }}
          type={connection.reachable ? (connection.authentication === 'public' ? 'success' : 'warning') : 'error'}
          showIcon
          message={connection.reachable ? t('Registry is reachable') : t('Registry is unavailable')}
          description={`${t('Authentication')}: ${connection.authentication}${
            connection.apiVersion ? ` · ${connection.apiVersion}` : ''
          }`}
        />
      )}
      {testError && (
        <Alert
          style={{ marginTop: 20 }}
          type="error"
          showIcon
          message={t('Connection test failed')}
          description={testError.message}
        />
      )}
      {saveError && (
        <Alert
          style={{ marginTop: 20 }}
          type="error"
          showIcon
          message={t('Unable to save settings')}
          description={saveError.message}
        />
      )}
    </Card>
  );
}
