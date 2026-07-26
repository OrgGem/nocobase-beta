import { Form, Input, Modal } from 'antd';
import React, { useEffect } from 'react';
import { useT } from '../locale';
import { KeyInput, type KeyInputValue } from './KeyInput';

export interface KeyImportFormValues {
  name: string;
  displayName?: string;
  purpose: 'encrypt' | 'sign' | 'both';
  kind?: string;
  key: KeyInputValue;
}

export interface KeyImportModalProps {
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: (values: KeyImportFormValues) => void;
}

export const KeyImportModal: React.FC<KeyImportModalProps> = ({ open, saving, onClose, onSubmit }) => {
  const t = useT();
  const [form] = Form.useForm<KeyImportFormValues>();

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ purpose: 'both', key: { mode: 'text', text: '' } });
    }
  }, [open, form]);

  return (
    <Modal
      open={open}
      title={t('Import Key')}
      onCancel={onClose}
      onOk={async () => {
        const values = await form.validateFields();
        onSubmit(values);
      }}
      okText={t('Import')}
      cancelText={t('Cancel')}
      confirmLoading={saving}
      width={640}
      destroyOnClose
    >
      <Form<KeyImportFormValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ purpose: 'both', key: { mode: 'text', text: '' } }}
      >
        <Form.Item name="name" label={t('Name')} rules={[{ required: true, message: 'name is required' }]}>
          <Input placeholder="partner-acme-2026" />
        </Form.Item>
        <Form.Item name="displayName" label={t('Display name')}>
          <Input placeholder={t('Optional display name') as string} />
        </Form.Item>
        <Form.Item name="purpose" label={t('Purpose')}>
          <Input type="hidden" />
        </Form.Item>
        <Form.Item label={t('Import a partner public key')} required>
          <Form.Item name="key" noStyle rules={[{ required: true, message: 'key is required' }]}>
            <KeyInput acceptPrivate={false} />
          </Form.Item>
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default KeyImportModal;
