import { Form, Input, Modal, Select, Space, Switch } from 'antd';
import React, { useEffect } from 'react';
import { useT } from '../locale';

export type GenerateKind = 'pgp-rsa4096' | 'pgp-curve25519' | 'rsa-4096' | 'ed25519' | 'ssh-ed25519' | 'ssh-rsa';

export interface KeyGenerateFormValues {
  name: string;
  displayName?: string;
  kind: GenerateKind;
  purpose: 'encrypt' | 'sign' | 'both';
  passphrase?: string;
  saveToEnv: boolean;
  envVarName?: string;
}

const KIND_OPTIONS: { value: GenerateKind; label: string }[] = [
  { value: 'pgp-rsa4096', label: 'PGP (RSA-4096)' },
  { value: 'pgp-curve25519', label: 'PGP (Curve25519)' },
  { value: 'rsa-4096', label: 'RSA-4096 (raw)' },
  { value: 'ed25519', label: 'Ed25519 (raw)' },
  { value: 'ssh-ed25519', label: 'SSH (Ed25519)' },
  { value: 'ssh-rsa', label: 'SSH (RSA)' },
];

export interface KeyGenerateModalProps {
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: (values: KeyGenerateFormValues) => void;
}

export const KeyGenerateModal: React.FC<KeyGenerateModalProps> = ({ open, saving, onClose, onSubmit }) => {
  const t = useT();
  const [form] = Form.useForm<KeyGenerateFormValues>();
  const saveToEnv = Form.useWatch('saveToEnv', form);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ kind: 'pgp-rsa4096', purpose: 'both', saveToEnv: false });
    }
  }, [open, form]);

  return (
    <Modal
      open={open}
      title={t('Generate Key')}
      onCancel={onClose}
      onOk={async () => {
        const values = await form.validateFields();
        onSubmit(values);
      }}
      okText={t('Generate')}
      cancelText={t('Cancel')}
      confirmLoading={saving}
      width={560}
      destroyOnClose
    >
      <Form<KeyGenerateFormValues> form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label={t('Name')} rules={[{ required: true, message: 'name is required' }]}>
          <Input placeholder="my-pgp-key" />
        </Form.Item>
        <Form.Item name="displayName" label={t('Display name')}>
          <Input placeholder={t('Optional display name') as string} />
        </Form.Item>
        <Form.Item name="kind" label={t('Kind')} rules={[{ required: true }]}>
          <Select options={KIND_OPTIONS} />
        </Form.Item>
        <Form.Item name="purpose" label={t('Purpose')}>
          <Select
            options={[
              { value: 'encrypt', label: t('Encrypt') },
              { value: 'sign', label: t('Sign') },
              { value: 'both', label: t('Both') },
            ]}
          />
        </Form.Item>
        <Form.Item name="passphrase" label={t('Passphrase (optional)')}>
          <Input.Password placeholder="••••••" autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="saveToEnv" label={t('Save private key to environment variable')} valuePropName="checked">
          <Switch />
        </Form.Item>
        {saveToEnv && (
          <Form.Item
            name="envVarName"
            label={t('Environment variable name')}
            rules={[{ required: true, message: t('Variable name is required when saving to env') as string }]}
            extra={
              <Space size={4}>
                <code>{`<NAME>_PRIVATE`}</code>
                <code>{`<NAME>_PUBLIC`}</code>
              </Space>
            }
          >
            <Input placeholder="MY_PGP_KEY" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
};

export default KeyGenerateModal;
