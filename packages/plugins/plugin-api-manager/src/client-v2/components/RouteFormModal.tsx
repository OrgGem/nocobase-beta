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
  kind?: string;
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
  authMode: 'both' | 'api-key' | 'role';
  encryptionMode: 'none' | 'aes-256-gcm' | 'pgp' | 'rsa-oaep';
  wireFormat: 'binary' | 'json';
  aesSecret?: string;
  aesSecretEnvVar?: string;
  aesKeyName?: string;
  pgpEncryptKeyName?: string;
  pgpDecryptKeyName?: string;
  pgpSignKeyName?: string;
  pgpVerifyKeyName?: string;
  rsaEncryptKeyName?: string;
  rsaDecryptKeyName?: string;
  requestEncrypted?: boolean;
  responseEncrypted?: boolean;
  hmacSignEnabled?: boolean;
  hmacVerifyEnabled?: boolean;
  hmacSecret?: string;
  hmacSecretEnvVar?: string;
  hmacToleranceSec?: number;
  jwtSignEnabled?: boolean;
  jwtSignAlgorithm?: 'RS256' | 'HS256';
  jwtSignKeyName?: string;
  jwtVerifyEnabled?: boolean;
  jwtVerifyKeyName?: string;
  jwtSecret?: string;
  jwtSecretEnvVar?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  jwtExpiresInSec?: number;
  rateLimitEnabled?: boolean;
  rateLimitMax?: number;
  rateLimitWindowSec?: number;
  ipAllowlist?: string[];
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  maxBodyMb: number;
  logPayloads: boolean;
  forwardHeaders?: string[];
  forwardResponseHeaders?: string[];
  staticHeaders?: { name: string; value: string }[];
}

interface InternalFormValues extends Omit<RouteFormValues, 'forwardHeaders' | 'staticHeaders' | 'ipAllowlist'> {
  forwardHeadersText?: string;
  forwardResponseHeadersText?: string;
  staticHeadersText?: string;
  ipAllowlistText?: string;
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
  const responseEncrypted = Form.useWatch('responseEncrypted', form) !== false;
  const requestEncrypted = Form.useWatch('requestEncrypted', form) !== false;
  const hmacSignEnabled = Form.useWatch('hmacSignEnabled', form) === true;
  const hmacVerifyEnabled = Form.useWatch('hmacVerifyEnabled', form) === true;
  const jwtSignEnabled = Form.useWatch('jwtSignEnabled', form) === true;
  const jwtVerifyEnabled = Form.useWatch('jwtVerifyEnabled', form) === true;
  const jwtSignAlgorithm = Form.useWatch('jwtSignAlgorithm', form);
  const rateLimitEnabled = Form.useWatch('rateLimitEnabled', form) === true;

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
      authMode: initial?.authMode ?? 'both',
      encryptionMode: initial?.encryptionMode ?? 'none',
      wireFormat: initial?.wireFormat ?? 'binary',
      aesSecret: initial?.aesSecret ?? '',
      aesSecretEnvVar: initial?.aesSecretEnvVar ?? '',
      aesKeyName: initial?.aesKeyName ?? undefined,
      pgpEncryptKeyName: initial?.pgpEncryptKeyName ?? undefined,
      pgpDecryptKeyName: initial?.pgpDecryptKeyName ?? undefined,
      pgpSignKeyName: initial?.pgpSignKeyName ?? undefined,
      pgpVerifyKeyName: initial?.pgpVerifyKeyName ?? undefined,
      rsaEncryptKeyName: initial?.rsaEncryptKeyName ?? undefined,
      rsaDecryptKeyName: initial?.rsaDecryptKeyName ?? undefined,
      requestEncrypted: initial?.requestEncrypted ?? true,
      responseEncrypted: initial?.responseEncrypted ?? true,
      hmacSignEnabled: initial?.hmacSignEnabled ?? false,
      hmacVerifyEnabled: initial?.hmacVerifyEnabled ?? false,
      hmacSecret: initial?.hmacSecret ?? '',
      hmacSecretEnvVar: initial?.hmacSecretEnvVar ?? '',
      hmacToleranceSec: initial?.hmacToleranceSec ?? 300,
      jwtSignEnabled: initial?.jwtSignEnabled ?? false,
      jwtSignAlgorithm: initial?.jwtSignAlgorithm ?? 'RS256',
      jwtSignKeyName: initial?.jwtSignKeyName ?? undefined,
      jwtVerifyEnabled: initial?.jwtVerifyEnabled ?? false,
      jwtVerifyKeyName: initial?.jwtVerifyKeyName ?? undefined,
      jwtSecret: initial?.jwtSecret ?? '',
      jwtSecretEnvVar: initial?.jwtSecretEnvVar ?? '',
      jwtIssuer: initial?.jwtIssuer ?? '',
      jwtAudience: initial?.jwtAudience ?? '',
      jwtExpiresInSec: initial?.jwtExpiresInSec ?? 300,
      rateLimitEnabled: initial?.rateLimitEnabled ?? false,
      rateLimitMax: initial?.rateLimitMax ?? 60,
      rateLimitWindowSec: initial?.rateLimitWindowSec ?? 60,
      ipAllowlistText: (initial?.ipAllowlist ?? []).join(', '),
      timeoutMs: initial?.timeoutMs ?? 30000,
      retryCount: initial?.retryCount ?? 0,
      retryDelayMs: initial?.retryDelayMs ?? 1000,
      maxBodyMb: initial?.maxBodyMb ?? 10,
      logPayloads: initial?.logPayloads ?? false,
      forwardHeadersText: (initial?.forwardHeaders ?? []).join(', '),
      forwardResponseHeadersText: (initial?.forwardResponseHeaders ?? []).join(', '),
      staticHeadersText: initial?.staticHeaders?.length ? JSON.stringify(initial.staticHeaders, null, 2) : '',
    };
    form.setFieldsValue(base);
  }, [open, initial, form]);

  // Direction filter removed — all PGP/RSA keys shown regardless of direction
  const isRsaKey = (k: CryptoKeyOption) => k.kind?.startsWith('rsa') ?? false;
  const isAesKey = (k: CryptoKeyOption) => k.kind?.startsWith('aes') ?? false;
  const isPgpKey = (k: CryptoKeyOption) => k.kind?.startsWith('pgp') ?? false;
  const allRsaKeys = cryptoKeys.filter(isRsaKey);
  // Show the key's direction as a hint so admins can distinguish own vs partner
  // keys; both directions are selectable for any encrypt/decrypt slot.
  const keyLabel = (k: CryptoKeyOption) => (k.direction === 'own' ? `${k.name} (own)` : `${k.name} (partner)`);
  // allRsaKeys used instead of filtering by direction
  const allPgpKeys = cryptoKeys.filter(isPgpKey);
  const allAesKeys = cryptoKeys.filter(isAesKey);
  // allPgpKeys used instead of filtering by direction

  const handleOk = async () => {
    const values = await form.validateFields();
    const forwardHeaders = (values.forwardHeadersText ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    let staticHeaders: { name: string; value: string }[] = [];
    const staticText = (values.staticHeadersText ?? '').trim();
    if (staticText) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(staticText);
      } catch {
        parsed = undefined;
      }
      const isValid =
        Array.isArray(parsed) &&
        parsed.every(
          (h) =>
            h &&
            typeof h === 'object' &&
            typeof (h as { name?: unknown }).name === 'string' &&
            typeof (h as { value?: unknown }).value === 'string',
        );
      if (!isValid) {
        form.setFields([
          {
            name: 'staticHeadersText',
            errors: [
              t('Static headers must be a JSON array of objects with "name" and "value" string fields') as string,
            ],
          },
        ]);
        return;
      }
      staticHeaders = parsed as { name: string; value: string }[];
    }
    const ipAllowlist = (values.ipAllowlistText ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const forwardResponseHeaders = (values.forwardResponseHeadersText ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const { forwardHeadersText, forwardResponseHeadersText, staticHeadersText, ipAllowlistText, ...rest } = values;
    onSubmit({ ...rest, forwardHeaders, forwardResponseHeaders, staticHeaders, ipAllowlist });
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
        <Form.Item
          name="partnerId"
          label={t('Partner') as string}
          rules={[{ required: true, message: t('Partner is required') as string }]}
        >
          <Select
            options={partners.map((p) => ({ value: p.id, label: p.name }))}
            placeholder={t('Select Partner') as string}
          />
        </Form.Item>
        <Form.Item name="description" label={t('Description') as string}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item
          name="authMode"
          label={t('Auth Mode') as string}
          tooltip={
            t('Choose which credentials may call this route: plugin API keys, app role tokens, or both') as string
          }
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { value: 'both', label: t('API Key + Role') as string },
              { value: 'api-key', label: t('API Key only') as string },
              { value: 'role', label: t('Role (app token) only') as string },
            ]}
          />
        </Form.Item>

        <Form.Item name="encryptionMode" label={t('Encryption') as string} rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'none', label: t('None') as string },
              { value: 'aes-256-gcm', label: 'AES-256-GCM' },
              { value: 'pgp', label: 'PGP' },
              { value: 'rsa-oaep', label: t('RSA-OAEP (hybrid)') as string },
            ]}
          />
        </Form.Item>

        {encryptionMode !== 'none' && (
          <>
            <Form.Item name="wireFormat" label={t('Wire Format') as string} rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'binary', label: t('Binary') as string },
                  { value: 'json', label: t('JSON') as string },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="requestEncrypted"
              label={
                direction === 'inbound'
                  ? (t('Decrypt Request') as string)
                  : (t('Encrypt Request') as string)
              }
              tooltip={
                direction === 'inbound'
                  ? (t('Decrypt incoming payload before forwarding to backend') as string)
                  : (t('Encrypt outgoing payload before forwarding to upstream') as string)
              }
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="responseEncrypted"
              label={
                direction === 'inbound'
                  ? (t('Encrypt Response') as string)
                  : (t('Decrypt Response') as string)
              }
              tooltip={
                direction === 'inbound'
                  ? (t('Encrypt backend response before sending to client') as string)
                  : (t('Decrypt upstream response before returning to client') as string)
              }
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </>
        )}

        {encryptionMode === 'aes-256-gcm' && (
          <>
            <Form.Item
              name="aesKeyName"
              label={t('AES Key (Crypto Toolkit)') as string}
              tooltip={t('Select an AES key from Crypto Toolkit. When set, overrides inline secret and env variable') as string}
            >
              <Select
                allowClear
                placeholder={t('None (use inline secret below)') as string}
                options={allAesKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))}
              />
            </Form.Item>
            <Form.Item
              name="aesSecret"
              label={t('AES Secret') as string}
              tooltip={t('Shared secret: 32-byte base64 key or any passphrase (fallback when no Crypto Toolkit key is selected)') as string}
            >
              <Input.Password autoComplete="new-password" placeholder={MASK} />
            </Form.Item>
            <Form.Item
              name="aesSecretEnvVar"
              label={t('AES Secret Env Variable') as string}
              tooltip={t('Env variable takes precedence over the stored secret (fallback when no Crypto Toolkit key is selected)') as string}
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
              rules={[
                {
                  required: (direction === 'outbound' && requestEncrypted) || (direction === 'inbound' && responseEncrypted),
                  message: t('PGP encrypt key is required') as string,
                },
              ]}
            >
              <Select allowClear options={allPgpKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))} />
            </Form.Item>
            <Form.Item
              name="pgpDecryptKeyName"
              label={t('PGP Decrypt Key') as string}
              tooltip={t('Own key whose private material decrypts incoming payloads') as string}
              rules={[
                {
                  required: (direction === 'inbound' && requestEncrypted) || (direction === 'outbound' && responseEncrypted),
                  message: t('PGP decrypt key is required') as string,
                },
              ]}
            >
              <Select allowClear options={allPgpKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))} />
            </Form.Item>
            <Form.Item name="pgpSignKeyName" label={t('PGP Sign Key') as string}>
              <Select allowClear options={allPgpKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))} />
            </Form.Item>
            <Form.Item name="pgpVerifyKeyName" label={t('PGP Verify Key') as string}>
              <Select allowClear options={allPgpKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))} />
            </Form.Item>
          </>
        )}

        {encryptionMode === 'rsa-oaep' && (
          <>
            <Form.Item
              name="rsaEncryptKeyName"
              label={t('RSA Encrypt Key') as string}
              tooltip={t('Partner RSA public key that encrypts outgoing payloads (Crypto Toolkit key name)') as string}
              rules={[
                {
                  required: (direction === 'outbound' && requestEncrypted) || (direction === 'inbound' && responseEncrypted),
                  message: t('RSA encrypt key is required') as string,
                },
              ]}
            >
              <Select allowClear options={allRsaKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))} />
            </Form.Item>
            <Form.Item
              name="rsaDecryptKeyName"
              label={t('RSA Decrypt Key') as string}
              tooltip={t('Own RSA key whose private material decrypts incoming payloads') as string}
              rules={[
                {
                  required: (direction === 'inbound' && requestEncrypted) || (direction === 'outbound' && responseEncrypted),
                  message: t('RSA decrypt key is required') as string,
                },
              ]}
            >
              <Select allowClear options={allRsaKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))} />
            </Form.Item>
          </>
        )}

        {/* --- HMAC Signing --- */}
        {direction === 'outbound' && (
          <Form.Item name="hmacSignEnabled" label={t('HMAC Sign (Outbound)') as string} valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
        {direction === 'inbound' && (
          <Form.Item name="hmacVerifyEnabled" label={t('HMAC Verify (Inbound)') as string} valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
        {(hmacSignEnabled || hmacVerifyEnabled) && (
          <>
            <Form.Item
              name="hmacSecret"
              label={t('HMAC Secret') as string}
              tooltip={t('Shared HMAC-SHA256 secret') as string}
            >
              <Input.Password autoComplete="new-password" placeholder={MASK} />
            </Form.Item>
            <Form.Item
              name="hmacSecretEnvVar"
              label={t('HMAC Secret Env Variable') as string}
              tooltip={t('Env variable takes precedence over the stored secret') as string}
            >
              <Input />
            </Form.Item>
            {direction === 'inbound' && (
              <Form.Item name="hmacToleranceSec" label={t('HMAC Tolerance (sec)') as string}>
                <InputNumber min={1} max={3600} style={{ width: '100%' }} />
              </Form.Item>
            )}
          </>
        )}

        {/* --- JWT --- */}
        {direction === 'outbound' && (
          <Form.Item name="jwtSignEnabled" label={t('JWT Sign (Outbound)') as string} valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
        {direction === 'inbound' && (
          <Form.Item name="jwtVerifyEnabled" label={t('JWT Verify (Inbound)') as string} valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
        {jwtSignEnabled && (
          <>
            <Form.Item name="jwtSignAlgorithm" label={t('JWT Algorithm') as string} rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'RS256', label: 'RS256' },
                  { value: 'HS256', label: 'HS256' },
                ]}
              />
            </Form.Item>
            {jwtSignAlgorithm === 'RS256' && (
              <Form.Item
                name="jwtSignKeyName"
                label={t('JWT Sign Key') as string}
                tooltip={t('Own RSA key used to sign outbound JWTs') as string}
                rules={[{ required: true, message: t('JWT sign key is required for RS256') as string }]}
              >
                <Select allowClear options={allRsaKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))} />
              </Form.Item>
            )}
            {jwtSignAlgorithm === 'HS256' && (
              <>
                <Form.Item name="jwtSecret" label={t('JWT Secret') as string}>
                  <Input.Password autoComplete="new-password" placeholder={MASK} />
                </Form.Item>
                <Form.Item
                  name="jwtSecretEnvVar"
                  label={t('JWT Secret Env Variable') as string}
                  tooltip={t('Env variable takes precedence over the stored secret') as string}
                >
                  <Input />
                </Form.Item>
              </>
            )}
            <Form.Item name="jwtExpiresInSec" label={t('JWT Expires In (sec)') as string}>
              <InputNumber min={1} max={86400} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}
        {jwtVerifyEnabled && (
          <>
            <Form.Item
              name="jwtVerifyKeyName"
              label={t('JWT Verify Key') as string}
              tooltip={t('Partner RSA public key for RS256 verification (leave empty for HS256)') as string}
            >
              <Select allowClear options={allRsaKeys.map((k) => ({ value: k.name, label: keyLabel(k) }))} />
            </Form.Item>
            <Form.Item name="jwtSecret" label={t('JWT Secret') as string}>
              <Input.Password autoComplete="new-password" placeholder={MASK} />
            </Form.Item>
            <Form.Item
              name="jwtSecretEnvVar"
              label={t('JWT Secret Env Variable') as string}
              tooltip={t('Env variable takes precedence over the stored secret') as string}
            >
              <Input />
            </Form.Item>
          </>
        )}
        {(jwtSignEnabled || jwtVerifyEnabled) && (
          <>
            <Form.Item name="jwtIssuer" label={t('JWT Issuer') as string}>
              <Input />
            </Form.Item>
            <Form.Item name="jwtAudience" label={t('JWT Audience') as string}>
              <Input />
            </Form.Item>
          </>
        )}

        {/* --- Rate Limiting --- */}
        {direction === 'inbound' && (
          <Form.Item name="rateLimitEnabled" label={t('Rate Limiting') as string} valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
        {rateLimitEnabled && direction === 'inbound' && (
          <>
            <Form.Item name="rateLimitMax" label={t('Rate Limit Max Requests') as string}>
              <InputNumber min={1} max={100000} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="rateLimitWindowSec" label={t('Rate Limit Window (sec)') as string}>
              <InputNumber min={1} max={86400} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}

        {/* --- IP Allowlist --- */}
        {direction === 'inbound' && (
          <Form.Item
            name="ipAllowlistText"
            label={t('IP Allowlist') as string}
            tooltip={t('Comma-separated IPs or CIDRs. Empty allows all.') as string}
          >
            <Input placeholder="10.0.0.0/8, 192.168.1.1" />
          </Form.Item>
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
          name="forwardResponseHeadersText"
          label={t('Forward Response Headers') as string}
          tooltip={
            t(
              'Comma-separated upstream response header names to pass through (e.g. content-disposition, etag, content-length, accept-ranges)',
            ) as string
          }
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
