import { Alert, Button, Form, Input, InputNumber, Modal, Space, message } from 'antd';
import React, { useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { KeyInput, type KeyInputValue } from './KeyInput';
import { OperationResult, type OperationResultProps } from './OperationResult';
import { RecentOperations } from './RecentOperations';

interface CsrFormValues {
  commonName: string;
  organization?: string;
  organizationalUnit?: string;
  country?: string;
  state?: string;
  locality?: string;
  email?: string;
  dnsNames?: string;
  ipAddresses?: string;
  emails?: string;
  privateEnvVar: string;
  passphrase?: string;
  outputFilename?: string;
}

interface SelfSignedFormValues extends CsrFormValues {
  validDays: number;
}

interface InspectFormValues {
  cert: KeyInputValue;
}

const CERT_ACTIONS = ['createCsr', 'createSelfSigned', 'inspect'];

const parseList = (raw?: string): string[] => {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
};

// ── CreateCsrModal ────────────────────────────────────────────────
export const CreateCsrModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onResult: (r: OperationResultProps | null) => void;
  refresh: () => void;
}> = ({ open, onClose, onResult, refresh }) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [form] = Form.useForm<CsrFormValues>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const subject: Record<string, string> = { commonName: values.commonName };
      if (values.organization) subject.organization = values.organization;
      if (values.organizationalUnit) subject.organizationalUnit = values.organizationalUnit;
      if (values.country) subject.country = values.country;
      if (values.state) subject.state = values.state;
      if (values.locality) subject.locality = values.locality;
      if (values.email) subject.email = values.email;

      const san: Record<string, string[]> = {};
      const dns = parseList(values.dnsNames);
      const ip = parseList(values.ipAddresses);
      const em = parseList(values.emails);
      if (dns.length) san.dns = dns;
      if (ip.length) san.ip = ip;
      if (em.length) san.email = em;

      const payload: Record<string, unknown> = {
        subject,
        privateEnvVar: values.privateEnvVar,
      };
      if (Object.keys(san).length) payload.san = san;
      if (values.passphrase) payload.passphrase = values.passphrase;
      if (values.outputFilename) payload.outputFilename = values.outputFilename;

      const res = await api.request({ url: 'crypto:createCsr', method: 'post', data: payload });
      const data = (res?.data?.data ?? res?.data) as OperationResultProps;
      onResult(data);
      message.success(t('CSR generated') as string);
      refresh();
      onClose();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to create CSR') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('Create CSR')}
      onCancel={onClose}
      onOk={submit}
      okText={t('Generate')}
      cancelText={t('Cancel')}
      confirmLoading={saving}
      width={640}
      destroyOnClose
    >
      <Form<CsrFormValues> form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="commonName"
          label={t('Common Name (CN)')}
          rules={[{ required: true, message: 'CN is required' }]}
        >
          <Input placeholder="example.com" />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="organization" label={t('Organization (O)')} style={{ flex: 1 }}>
            <Input placeholder="Acme Inc." />
          </Form.Item>
          <Form.Item name="organizationalUnit" label={t('Organizational Unit (OU)')} style={{ flex: 1, marginLeft: 8 }}>
            <Input placeholder="IT" />
          </Form.Item>
        </Space.Compact>
        <Space.Compact block>
          <Form.Item name="country" label={t('Country (C)')} style={{ flex: 1 }}>
            <Input placeholder="US" maxLength={2} />
          </Form.Item>
          <Form.Item name="state" label={t('State (ST)')} style={{ flex: 1, marginLeft: 8 }}>
            <Input placeholder="California" />
          </Form.Item>
          <Form.Item name="locality" label={t('Locality (L)')} style={{ flex: 1, marginLeft: 8 }}>
            <Input placeholder="San Francisco" />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="email" label={t('Email (E)')}>
          <Input placeholder="admin@example.com" />
        </Form.Item>
        <Form.Item name="dnsNames" label={t('Subject Alternative Names')} extra={t('DNS names (one per line)')}>
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="example.com\n*.example.com" />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="ipAddresses" label={t('IP addresses (one per line)')} style={{ flex: 1 }}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="10.0.0.1" />
          </Form.Item>
          <Form.Item name="emails" label={t('Emails (one per line)')} style={{ flex: 1, marginLeft: 8 }}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="admin@example.com" />
          </Form.Item>
        </Space.Compact>
        <Form.Item
          name="privateEnvVar"
          label={t('Own private key env var')}
          rules={[{ required: true, message: 'privateEnvVar is required' }]}
        >
          <Input placeholder="CRYPTO_TOOLKIT_MY_TLS_KEY_PRIVATE" />
        </Form.Item>
        <Form.Item name="passphrase" label={t('Passphrase')}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="outputFilename" label={t('Output filename')}>
          <Input placeholder="request.csr" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

// ── CreateSelfSignedModal ────────────────────────────────────────
export const CreateSelfSignedModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onResult: (r: OperationResultProps | null) => void;
  refresh: () => void;
}> = ({ open, onClose, onResult, refresh }) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [form] = Form.useForm<SelfSignedFormValues>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ validDays: 365 });
    }
  }, [open, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const subject: Record<string, string> = { commonName: values.commonName };
      if (values.organization) subject.organization = values.organization;
      if (values.organizationalUnit) subject.organizationalUnit = values.organizationalUnit;
      if (values.country) subject.country = values.country;
      if (values.state) subject.state = values.state;
      if (values.locality) subject.locality = values.locality;
      if (values.email) subject.email = values.email;

      const san: Record<string, string[]> = {};
      const dns = parseList(values.dnsNames);
      const ip = parseList(values.ipAddresses);
      const em = parseList(values.emails);
      if (dns.length) san.dns = dns;
      if (ip.length) san.ip = ip;
      if (em.length) san.email = em;

      const payload: Record<string, unknown> = {
        subject,
        privateEnvVar: values.privateEnvVar,
        validDays: values.validDays,
      };
      if (Object.keys(san).length) payload.san = san;
      if (values.passphrase) payload.passphrase = values.passphrase;
      if (values.outputFilename) payload.outputFilename = values.outputFilename;

      const res = await api.request({ url: 'crypto:createSelfSigned', method: 'post', data: payload });
      const data = (res?.data?.data ?? res?.data) as OperationResultProps;
      onResult(data);
      message.success(t('Self-signed certificate generated') as string);
      refresh();
      onClose();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to create self-signed certificate') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('Create self-signed certificate')}
      onCancel={onClose}
      onOk={submit}
      okText={t('Generate')}
      cancelText={t('Cancel')}
      confirmLoading={saving}
      width={640}
      destroyOnClose
    >
      <Form<SelfSignedFormValues> form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="commonName"
          label={t('Common Name (CN)')}
          rules={[{ required: true, message: 'CN is required' }]}
        >
          <Input placeholder="example.com" />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="organization" label={t('Organization (O)')} style={{ flex: 1 }}>
            <Input />
          </Form.Item>
          <Form.Item name="organizationalUnit" label={t('Organizational Unit (OU)')} style={{ flex: 1, marginLeft: 8 }}>
            <Input />
          </Form.Item>
        </Space.Compact>
        <Space.Compact block>
          <Form.Item name="country" label={t('Country (C)')} style={{ flex: 1 }}>
            <Input maxLength={2} />
          </Form.Item>
          <Form.Item name="state" label={t('State (ST)')} style={{ flex: 1, marginLeft: 8 }}>
            <Input />
          </Form.Item>
          <Form.Item name="locality" label={t('Locality (L)')} style={{ flex: 1, marginLeft: 8 }}>
            <Input />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="email" label={t('Email (E)')}>
          <Input />
        </Form.Item>
        <Form.Item name="dnsNames" label={t('DNS names (one per line)')}>
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="example.com" />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="ipAddresses" label={t('IP addresses (one per line)')} style={{ flex: 1 }}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item name="emails" label={t('Emails (one per line)')} style={{ flex: 1, marginLeft: 8 }}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Space.Compact>
        <Form.Item
          name="privateEnvVar"
          label={t('Own private key env var')}
          rules={[{ required: true, message: 'privateEnvVar is required' }]}
        >
          <Input placeholder="CRYPTO_TOOLKIT_MY_TLS_KEY_PRIVATE" />
        </Form.Item>
        <Form.Item name="passphrase" label={t('Passphrase')}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="validDays"
          label={t('Validity (days)')}
          rules={[{ required: true, message: 'validDays is required' }]}
        >
          <InputNumber min={1} max={3650} style={{ width: 200 }} />
        </Form.Item>
        <Form.Item name="outputFilename" label={t('Output filename')}>
          <Input placeholder="cert.pem" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

// ── InspectModal ─────────────────────────────────────────────────
export const InspectModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onResult: (r: OperationResultProps | null) => void;
  refresh: () => void;
}> = ({ open, onClose, onResult, refresh }) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [form] = Form.useForm<InspectFormValues>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ cert: { mode: 'text', text: '' } });
    }
  }, [open, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.request({ url: 'crypto:inspect', method: 'post', data: values });
      const data = (res?.data?.data ?? res?.data) as OperationResultProps;
      onResult(data);
      message.success(t('Certificate inspected') as string);
      refresh();
      onClose();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to inspect certificate') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('Inspect certificate')}
      onCancel={onClose}
      onOk={submit}
      okText={t('Inspect')}
      cancelText={t('Cancel')}
      confirmLoading={saving}
      width={720}
      destroyOnClose
    >
      <Form<InspectFormValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ cert: { mode: 'text', text: '' } }}
      >
        <Form.Item label={t('Certificate')} required>
          <Form.Item name="cert" noStyle rules={[{ required: true, message: 'cert is required' }]}>
            <KeyInput acceptPrivate={false} />
          </Form.Item>
        </Form.Item>
      </Form>
    </Modal>
  );
};

// ── Page ─────────────────────────────────────────────────────────
export const CertsPage: React.FC = () => {
  const t = useT();
  const [csrOpen, setCsrOpen] = useState(false);
  const [selfOpen, setSelfOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [result, setResult] = useState<OperationResultProps | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" onClick={() => setCsrOpen(true)}>
          {t('Create CSR')}
        </Button>
        <Button onClick={() => setSelfOpen(true)}>{t('Create self-signed certificate')}</Button>
        <Button onClick={() => setInspectOpen(true)}>{t('Inspect certificate')}</Button>
      </Space>
      <Alert
        showIcon
        type="info"
        style={{ marginBottom: 12 }}
        message={t('Private key must be available as a NocoBase environment variable (secret).')}
      />
      {result && (
        <div style={{ marginBottom: 16 }}>
          <OperationResult {...result} />
        </div>
      )}
      <h3 style={{ marginTop: 16 }}>{t('Recent operations')}</h3>
      <RecentOperations refreshKey={refreshKey} actionFilter={[...CERT_ACTIONS]} />

      <CreateCsrModal
        open={csrOpen}
        onClose={() => setCsrOpen(false)}
        onResult={setResult}
        refresh={() => setRefreshKey((k) => k + 1)}
      />
      <CreateSelfSignedModal
        open={selfOpen}
        onClose={() => setSelfOpen(false)}
        onResult={setResult}
        refresh={() => setRefreshKey((k) => k + 1)}
      />
      <InspectModal
        open={inspectOpen}
        onClose={() => setInspectOpen(false)}
        onResult={setResult}
        refresh={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
};

export default CertsPage;
