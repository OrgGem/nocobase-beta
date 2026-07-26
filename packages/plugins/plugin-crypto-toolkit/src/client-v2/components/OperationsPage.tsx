import { Alert, Button, Form, Input, InputNumber, Select, Space, message } from 'antd';
import React, { useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { KeyInput, type KeyInputValue } from './KeyInput';
import { OperationResult, type OperationResultProps } from './OperationResult';
import { RecentOperations } from './RecentOperations';

interface KeyListItem {
  id: number;
  name: string;
  kind: string;
  direction: 'own' | 'partner';
  publicFormat: string;
  privateEnvVar?: string | null;
}

interface CommonPayloadFormValues {
  payload: KeyInputValue;
  outputFilename?: string;
  storageId?: number;
}

const ENCRYPT_ALGOS = [
  { value: 'pgp', label: 'PGP' },
  { value: 'aes-256-gcm', label: 'AES-256-GCM' },
];

const DECRYPT_ALGOS = [
  { value: 'pgp', label: 'PGP' },
  { value: 'aes-256-gcm', label: 'AES-256-GCM' },
];

const SIGN_ALGOS = [
  { value: 'rsa-pss-sha256', label: 'RSA-PSS SHA-256' },
  { value: 'ed25519', label: 'Ed25519' },
  { value: 'pgp-detached', label: 'PGP detached' },
];

const VERIFY_ALGOS = [
  { value: 'rsa-pss-sha256', label: 'RSA-PSS SHA-256' },
  { value: 'ed25519', label: 'Ed25519' },
  { value: 'pgp-detached', label: 'PGP detached' },
];

async function loadKeyList(api: { request: ApiRequest }): Promise<KeyListItem[]> {
  const res = await api.request({
    url: 'cryptoKeys:list',
    params: { paginate: false, filter: { enabled: true } },
  });
  return (res?.data?.data as KeyListItem[] | undefined) ?? [];
}

interface ApiRequest {
  (opts: { url: string; method?: string; data?: unknown; params?: Record<string, unknown> }): Promise<{
    data?: { data?: unknown };
  }>;
}

// ── Encrypt ──────────────────────────────────────────────────────
interface EncryptFormValues extends CommonPayloadFormValues {
  algorithm: 'pgp' | 'aes-256-gcm';
  recipientKeyIds?: number[];
  signerEnvVar?: string;
  passphrase?: string;
  secret?: KeyInputValue;
}

const EncryptForm: React.FC<{ onResult: (r: OperationResultProps | null) => void; refresh: () => void }> = ({
  onResult,
  refresh,
}) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient as unknown as { request: ApiRequest };
  const [form] = Form.useForm<EncryptFormValues>();
  const algorithm = Form.useWatch('algorithm', form);
  const [keys, setKeys] = useState<KeyListItem[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadKeyList(api)
      .then(setKeys)
      .catch(() => setKeys([]));
  }, [api]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.request({
        url: 'crypto:encrypt',
        method: 'post',
        data: values,
      });
      const data = (res?.data?.data ?? res?.data) as OperationResultProps;
      onResult(data);
      message.success(t('Encrypted') as string);
      refresh();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to encrypt') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form<EncryptFormValues>
      form={form}
      layout="vertical"
      onFinish={submit}
      initialValues={{ algorithm: 'pgp', payload: { mode: 'attachment', attachmentId: null } }}
    >
      <Form.Item name="algorithm" label={t('Algorithm')} rules={[{ required: true }]}>
        <Select options={ENCRYPT_ALGOS} />
      </Form.Item>
      <Form.Item label={t('File to encrypt')} required>
        <Form.Item name="payload" noStyle rules={[{ required: true, message: 'payload is required' }]}>
          <KeyInput acceptPrivate={false} />
        </Form.Item>
      </Form.Item>
      {algorithm === 'pgp' && (
        <>
          <Form.Item
            name="recipientKeyIds"
            label={t('Recipient key(s)')}
            rules={[{ required: true, message: 'recipientKeyIds is required' }]}
          >
            <Select
              mode="multiple"
              placeholder={t('Select recipient key(s)') as string}
              options={keys
                .filter((k) => k.direction === 'partner' && k.publicFormat === 'openpgp')
                .map((k) => ({ value: k.id, label: k.name }))}
            />
          </Form.Item>
          <Form.Item name="signerEnvVar" label={t('Signer env var (own private key)')}>
            <Input placeholder="CRYPTO_TOOLKIT_MY_PGP_KEY_PRIVATE" />
          </Form.Item>
          <Form.Item name="passphrase" label={t('Passphrase for the private key env var')}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </>
      )}
      {algorithm === 'aes-256-gcm' && (
        <Form.Item
          name="secret"
          label={t('AES secret (env var or text)')}
          rules={[{ required: true, message: 'secret is required' }]}
        >
          <KeyInput acceptPrivate />
        </Form.Item>
      )}
      <Form.Item name="outputFilename" label={t('Output filename')}>
        <Input placeholder="encrypted.bin" />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>
          {t('Encrypt')}
        </Button>
      </Space>
    </Form>
  );
};

// ── Decrypt ──────────────────────────────────────────────────────
interface DecryptFormValues extends CommonPayloadFormValues {
  algorithm: 'pgp' | 'aes-256-gcm';
  privateEnvVar?: string;
  passphrase?: string;
  secret?: KeyInputValue;
  verifyKeyIds?: number[];
}

const DecryptForm: React.FC<{ onResult: (r: OperationResultProps | null) => void; refresh: () => void }> = ({
  onResult,
  refresh,
}) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient as unknown as { request: ApiRequest };
  const [form] = Form.useForm<DecryptFormValues>();
  const algorithm = Form.useWatch('algorithm', form);
  const [keys, setKeys] = useState<KeyListItem[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadKeyList(api)
      .then(setKeys)
      .catch(() => setKeys([]));
  }, [api]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.request({
        url: 'crypto:decrypt',
        method: 'post',
        data: values,
      });
      const data = (res?.data?.data ?? res?.data) as OperationResultProps;
      onResult(data);
      message.success(t('Decrypted') as string);
      refresh();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to decrypt') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form<DecryptFormValues>
      form={form}
      layout="vertical"
      onFinish={submit}
      initialValues={{ algorithm: 'pgp', payload: { mode: 'attachment', attachmentId: null } }}
    >
      <Form.Item name="algorithm" label={t('Algorithm')} rules={[{ required: true }]}>
        <Select options={DECRYPT_ALGOS} />
      </Form.Item>
      <Form.Item label={t('Encrypted file')} required>
        <Form.Item name="payload" noStyle rules={[{ required: true, message: 'payload is required' }]}>
          <KeyInput acceptPrivate={false} />
        </Form.Item>
      </Form.Item>
      {algorithm === 'pgp' && (
        <Form.Item
          name="privateEnvVar"
          label={t('Private key env var (own)')}
          rules={[{ required: true, message: 'privateEnvVar is required' }]}
        >
          <Input placeholder="CRYPTO_TOOLKIT_MY_PGP_KEY_PRIVATE" />
        </Form.Item>
      )}
      {algorithm === 'pgp' && (
        <Form.Item name="passphrase" label={t('Passphrase for the private key env var')}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      )}
      {algorithm === 'pgp' && (
        <Form.Item name="verifyKeyIds" label={t('Verification key')}>
          <Select
            mode="multiple"
            allowClear
            placeholder={t('Select recipient key(s)') as string}
            options={keys.filter((k) => k.publicFormat === 'openpgp').map((k) => ({ value: k.id, label: k.name }))}
          />
        </Form.Item>
      )}
      {algorithm === 'aes-256-gcm' && (
        <Form.Item
          name="secret"
          label={t('AES secret (env var or text)')}
          rules={[{ required: true, message: 'secret is required' }]}
        >
          <KeyInput acceptPrivate />
        </Form.Item>
      )}
      <Form.Item name="outputFilename" label={t('Output filename')}>
        <Input placeholder="decrypted.bin" />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>
          {t('Decrypt')}
        </Button>
      </Space>
    </Form>
  );
};

// ── Sign ─────────────────────────────────────────────────────────
interface SignFormValues extends CommonPayloadFormValues {
  algorithm: 'rsa-pss-sha256' | 'ed25519' | 'pgp-detached';
  privateEnvVar: string;
  passphrase?: string;
}

const SignForm: React.FC<{ onResult: (r: OperationResultProps | null) => void; refresh: () => void }> = ({
  onResult,
  refresh,
}) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient as unknown as { request: ApiRequest };
  const [form] = Form.useForm<SignFormValues>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.request({
        url: 'crypto:sign',
        method: 'post',
        data: values,
      });
      const data = (res?.data?.data ?? res?.data) as OperationResultProps;
      onResult(data);
      message.success(t('Signed') as string);
      refresh();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to sign') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form<SignFormValues>
      form={form}
      layout="vertical"
      onFinish={submit}
      initialValues={{ algorithm: 'rsa-pss-sha256', payload: { mode: 'attachment', attachmentId: null } }}
    >
      <Form.Item name="algorithm" label={t('Algorithm')} rules={[{ required: true }]}>
        <Select options={SIGN_ALGOS} />
      </Form.Item>
      <Form.Item label={t('File to sign')} required>
        <Form.Item name="payload" noStyle rules={[{ required: true, message: 'payload is required' }]}>
          <KeyInput acceptPrivate={false} />
        </Form.Item>
      </Form.Item>
      <Form.Item
        name="privateEnvVar"
        label={t('Private key env var (own)')}
        rules={[{ required: true, message: 'privateEnvVar is required' }]}
      >
        <Input placeholder="CRYPTO_TOOLKIT_MY_KEY_PRIVATE" />
      </Form.Item>
      <Form.Item name="passphrase" label={t('Passphrase')}>
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Form.Item name="outputFilename" label={t('Output filename')}>
        <Input placeholder="file.sig" />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>
          {t('Sign')}
        </Button>
      </Space>
    </Form>
  );
};

// ── Verify ───────────────────────────────────────────────────────
interface VerifyFormValues {
  algorithm: 'rsa-pss-sha256' | 'ed25519' | 'pgp-detached';
  payload: KeyInputValue;
  signature: KeyInputValue;
  verifyKeyId: number;
}

const VerifyForm: React.FC<{ onResult: (r: OperationResultProps | null) => void; refresh: () => void }> = ({
  onResult,
  refresh,
}) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient as unknown as { request: ApiRequest };
  const [form] = Form.useForm<VerifyFormValues>();
  const [keys, setKeys] = useState<KeyListItem[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadKeyList(api)
      .then(setKeys)
      .catch(() => setKeys([]));
  }, [api]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.request({
        url: 'crypto:verify',
        method: 'post',
        data: values,
      });
      const data = (res?.data?.data ?? res?.data) as OperationResultProps;
      onResult(data);
      message.success(t('Verified') as string);
      refresh();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to verify') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form<VerifyFormValues>
      form={form}
      layout="vertical"
      onFinish={submit}
      initialValues={{
        algorithm: 'rsa-pss-sha256',
        payload: { mode: 'attachment', attachmentId: null },
        signature: { mode: 'attachment', attachmentId: null },
      }}
    >
      <Form.Item name="algorithm" label={t('Algorithm')} rules={[{ required: true }]}>
        <Select options={VERIFY_ALGOS} />
      </Form.Item>
      <Form.Item label={t('File to verify')} required>
        <Form.Item name="payload" noStyle rules={[{ required: true, message: 'payload is required' }]}>
          <KeyInput acceptPrivate={false} />
        </Form.Item>
      </Form.Item>
      <Form.Item label={t('Signature file')} required>
        <Form.Item name="signature" noStyle rules={[{ required: true, message: 'signature is required' }]}>
          <KeyInput acceptPrivate={false} />
        </Form.Item>
      </Form.Item>
      <Form.Item
        name="verifyKeyId"
        label={t('Verification key')}
        rules={[{ required: true, message: 'verifyKeyId is required' }]}
      >
        <Select
          showSearch
          optionFilterProp="label"
          placeholder={t('Select recipient key(s)') as string}
          options={keys.map((k) => ({ value: k.id, label: `${k.name} (${k.kind})` }))}
        />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>
          {t('Verify')}
        </Button>
      </Space>
    </Form>
  );
};

// ── Checksum ─────────────────────────────────────────────────────
interface ChecksumFormValues {
  payload: KeyInputValue;
}

const ChecksumForm: React.FC<{ onResult: (r: OperationResultProps | null) => void; refresh: () => void }> = ({
  onResult,
  refresh,
}) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient as unknown as { request: ApiRequest };
  const [form] = Form.useForm<ChecksumFormValues>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.request({
        url: 'crypto:checksum',
        method: 'post',
        data: { ...values, algorithm: 'sha-256' },
      });
      const data = (res?.data?.data ?? res?.data) as OperationResultProps;
      onResult(data);
      message.success(t('Checksummed') as string);
      refresh();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to compute checksum') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form<ChecksumFormValues>
      form={form}
      layout="vertical"
      onFinish={submit}
      initialValues={{ payload: { mode: 'attachment', attachmentId: null } }}
    >
      <Form.Item label={t('File to checksum')} required>
        <Form.Item name="payload" noStyle rules={[{ required: true, message: 'payload is required' }]}>
          <KeyInput acceptPrivate={false} />
        </Form.Item>
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>
          {t('Checksum')}
        </Button>
      </Space>
    </Form>
  );
};

// ── Main page ────────────────────────────────────────────────────
export const OperationsPage: React.FC = () => {
  const t = useT();
  void InputNumber;
  void Alert;
  const [tab, setTab] = useState<string>('encrypt');
  const [result, setResult] = useState<OperationResultProps | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const tabs = [
    { key: 'encrypt', label: t('Encrypt file') },
    { key: 'decrypt', label: t('Decrypt file') },
    { key: 'sign', label: t('Sign file') },
    { key: 'verify', label: t('Verify file') },
    { key: 'checksum', label: t('Checksum file') },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map((tt) => (
          <Button
            key={tt.key}
            type={tab === tt.key ? 'primary' : 'default'}
            onClick={() => {
              setTab(tt.key);
              setResult(null);
            }}
          >
            {tt.label}
          </Button>
        ))}
      </div>
      <div style={{ background: '#fff', border: '1px solid #eee', padding: 16, borderRadius: 6, marginBottom: 16 }}>
        {tab === 'encrypt' && <EncryptForm onResult={setResult} refresh={() => setRefreshKey((k) => k + 1)} />}
        {tab === 'decrypt' && <DecryptForm onResult={setResult} refresh={() => setRefreshKey((k) => k + 1)} />}
        {tab === 'sign' && <SignForm onResult={setResult} refresh={() => setRefreshKey((k) => k + 1)} />}
        {tab === 'verify' && <VerifyForm onResult={setResult} refresh={() => setRefreshKey((k) => k + 1)} />}
        {tab === 'checksum' && <ChecksumForm onResult={setResult} refresh={() => setRefreshKey((k) => k + 1)} />}
      </div>
      {result && <OperationResult {...result} />}
      <h3 style={{ marginTop: 24 }}>{t('Recent operations')}</h3>
      <RecentOperations refreshKey={refreshKey} />
    </div>
  );
};

export default OperationsPage;
