import { Form, Input, InputNumber, Modal, Select, Switch } from 'antd';
import React, { useEffect } from 'react';
import { MASK } from '../../constants';
import { useT } from '../locale';

export interface RouteOption {
  id: number;
  name: string;
}

export interface CryptoKeyOption {
  name: string;
  direction: 'own' | 'partner';
}

export interface RouteFormValues {
  name: string;
  direction: 'inbound' | 'outbound';
  method: string;
  inboundPath?: string;
  targetUrl: string;
  partnerId?: number | null;
  description?: string;
  enabled: boolean;
  encryptionMode: 'none' | 'aes-256-gcm' | 'pgp';
  wireFormat: 'binary' | 'json';
  aesSecret?: string;
  aesSecretEnvVar?: string;
  pgpEncryptKeyName?: string;
  pgpDecryptKeyName?: string;
  pgpSignKeyName?: string;
  pgpVerifyKeyName?: string;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  maxBodyMb: number;
  logPayloads: boolean;
  forwardHeaders?: string[];
  staticHeaders?: { name: string; value: string }[];
}

interface InternalFormValues extends Omit<RouteFormValues, 'forwardHeaders' | 'staticHeaders'> {
  forwardHeadersText?: string;
  staticHeadersText?: string;
}

interface RouteFormModalProps {
  open: boolean;
  initial: Partial<RouteFormValues> | null;
  partners: RouteOption[];
  cryptoKeys: CryptoKeyOption[];
  saving: boolean;
  onSubmit: (values: RouteFormValues) => void;
  onCancel: () => void;
}

export const RouteFormModal: React.FC<RouteFormModalProps> = ({
  open,
  initial,
  partners,
  cryptoKeys,
  saving,
  onSubmit,
  onCancel,
}) => {
  const t = useT();
  const [form] = Form.useForm<InternalFormValues>();
  const encryptionMode = Form.useWatch('encryptionMode', form);
  const direction = Form.useWatch('direction', form);

  useEffect(() => {
    if (!open) return;
    const base: InternalFormValues = {
      name: initial?.name ?? '',
      direction: initial?.direction ?? 'outbound',
      method: initial?.method ?? 'POST',
      inboundPath: initial?.inboundPath ?? '',
      targetUrl: initial?.targetUrl ?? '',
      partnerId: initial?.partnerId ?? null,
      description: initial?.description ?? '',
      enabled: initial?.enabled ?? true,
      encryptionMode: initial?.encryptionMode ?? 'none',
      wireFormat: initial?.wireFormat ?? 'binary',
      aesSecret: initial?.aesSecret ?? '',
      aesSecretEnvVar: initial?.aesSecretEnvVar ?? '',
      pgpEncryptKeyName: initial?.pgpEncryptKeyName ?? undefined,
      pgpDecryptKeyName: initial?.pgpDecryptKeyName ?? undefined,
      pgpSignKeyName: initial?.pgpSignKeyName ?? undefined,
      pgpVerifyKeyName: initial?.pgpVerifyKeyName ?? undefined,
      timeoutMs: initial?.timeoutMs ?? 30000,
      retryCount: initial?.retryCount ?? 0,
      retryDelayMs: initial?.retryDelayMs ?? 1000,
      maxBodyMb: initial?.maxBodyMb ?? 10,
      logPayloads: initial?.logPayloads ?? false,
      forwardHeadersText: (initial?.forwardHeaders ?? []).join(', '),
      staticHeadersText: initial?.staticHeaders?.length ? JSON.stringify(initial.staticHeaders, null, 2) : '',
    };
    form.setFieldsValue(base);
  }, [open, initial, form]);

  const partnerKeys = cryptoKeys.filter((k) => k.direction === 'partner');
  const ownKeys = cryptoKeys.filter((k) => k.direction === 'own');

  const handleOk = async () => {
    const values = await form.validateFields();
    const forwardHeaders = (values.forwardHeadersText ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    let staticHeaders: { name: string; value: string }[] = [];
    const staticText = (values.staticHeadersText ?? '').trim();
    if (staticText) {
      try {
        const parsed = JSON.parse(staticText);
        if (Array.isArray(parsed)) staticHeaders = parsed;
      } catch {
        staticHeaders = [];
      }
    }
    const { forwardHeadersText, staticHeadersText, ...rest } = values;
    onSubmit({ ...rest, forwardHeaders, staticHeaders });
  };

  return (
    <Modal
      title={initial?.name ? (t('Edit Route') as string) : (t('Create Route') as string)}
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      confirmLoading={saving}
      width={720}
      okText={t('Save') as string}
      cancelText={t('Cancel') as string}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label={t('Name') as string} rules={[{ required: true }]}>
          <Input disabled={Boolean(initial?.name)} />
        </Form.Item>
        <Form.Item name="direction" label={t('Direction') as string} rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'inbound', label: t('Inbound') as string },
              { value: 'outbound', label: t('Outbound') as string },
            ]}
          />
        </Form.Item>
        <Form.Item name="method" label={t('Method') as string} rules={[{ required: true }]}>
          <Select options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }))} />
        </Form.Item>
        {direction === 'inbound' && (
          <Form.Item
            name="inboundPath"
            label={t('Inbound Path') as string}
            tooltip={t('Sub-path under /api/apim/inbound/, e.g. orders') as string}
            rules={[{ required: true, message: t('Inbound path is required for inbound routes') as string }]}
          >
            <Input />
          </Form.Item>
        )}
        <Form.Item
          name="targetUrl"
          label={t('Target URL') as string}
          tooltip={t('URL the proxy forwards to (partner URL for outbound, internal backend for inbound)') as string}
          rules={[
            { required: true },
            {
              pattern: /^https?:\/\//i,
              message: t('Target URL must start with http:// or https://') as string,
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item name="partnerId" label={t('Partner') as string}>
          <Select allowClear options={partners.map((p) => ({ value: p.id, label: p.name }))} />
        </Form.Item>
        <Form.Item name="description" label={t('Description') as string}>
          <Input.TextArea rows={2} />
        </Form.Item>

        <Form.Item name="encryptionMode" label={t('Encryption') as string} rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'none', label: t('None') as string },
              { value: 'aes-256-gcm', label: 'AES-256-GCM' },
              { value: 'pgp', label: 'PGP' },
            ]}
          />
        </Form.Item>

        {encryptionMode !== 'none' && (
          <Form.Item name="wireFormat" label={t('Wire Format') as string} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'binary', label: t('Binary') as string },
                { value: 'json', label: t('JSON') as string },
              ]}
            />
          </Form.Item>
        )}

        {encryptionMode === 'aes-256-gcm' && (
          <>
            <Form.Item
              name="aesSecret"
              label={t('AES Secret') as string}
              tooltip={t('Shared secret: 32-byte base64 key or any passphrase') as string}
            >
              <Input.Password autoComplete="new-password" placeholder={MASK} />
            </Form.Item>
            <Form.Item
              name="aesSecretEnvVar"
              label={t('AES Secret Env Variable') as string}
              tooltip={t('Env variable takes precedence over the stored secret') as string}
            >
              <Input />
            </Form.Item>
          </>
        )}

        {encryptionMode === 'pgp' && (
          <>
            <Form.Item
              name="pgpEncryptKeyName"
              label={t('PGP Encrypt Key') as string}
              tooltip={t('Public key of the recipient (cryptoToolkit key name)') as string}
            >
              <Select allowClear options={partnerKeys.map((k) => ({ value: k.name, label: k.name }))} />
            </Form.Item>
            <Form.Item
              name="pgpDecryptKeyName"
              label={t('PGP Decrypt Key') as string}
              tooltip={t('Own key whose private material decrypts incoming payloads') as string}
            >
              <Select allowClear options={ownKeys.map((k) => ({ value: k.name, label: k.name }))} />
            </Form.Item>
            <Form.Item name="pgpSignKeyName" label={t('PGP Sign Key') as string}>
              <Select allowClear options={ownKeys.map((k) => ({ value: k.name, label: k.name }))} />
            </Form.Item>
            <Form.Item name="pgpVerifyKeyName" label={t('PGP Verify Key') as string}>
              <Select allowClear options={partnerKeys.map((k) => ({ value: k.name, label: k.name }))} />
            </Form.Item>
          </>
        )}

        <Form.Item name="timeoutMs" label={t('Timeout (ms)') as string}>
          <InputNumber min={100} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="retryCount" label={t('Retry Count') as string}>
          <InputNumber min={0} max={5} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="retryDelayMs" label={t('Retry Delay (ms)') as string}>
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="maxBodyMb" label={t('Max Body (MB)') as string}>
          <InputNumber min={1} max={100} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="logPayloads"
          label={t('Log Payloads') as string}
          tooltip={t('Store full request/response payloads in logs for this route') as string}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="forwardHeadersText"
          label={t('Forward Headers') as string}
          tooltip={t('Comma-separated header names to pass through') as string}
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="staticHeadersText"
          label={t('Static Headers') as string}
          tooltip={t('JSON array of {name, value} added to forwarded requests') as string}
        >
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item name="enabled" label={t('Enabled') as string} valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default RouteFormModal;
