import { Alert, Button, Input, Modal, Space, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import React from 'react';
import { useT } from '../locale';

interface ApiKeyCreatedModalProps {
  value: { name: string; apiKey: string } | null;
  onClose: () => void;
}

export const ApiKeyCreatedModal: React.FC<ApiKeyCreatedModalProps> = ({ value, onClose }) => {
  const t = useT();

  const copyKey = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value.apiKey);
      message.success(t('Copied to clipboard') as string);
    } catch {
      message.error(t('Copy failed — select and copy manually') as string);
    }
  };

  return (
    <Modal
      title={t('API Key Created') as string}
      open={Boolean(value)}
      // The key is shown exactly once; closing it accidentally (backdrop click
      // or Escape) would make it unrecoverable, so require an explicit button.
      maskClosable={false}
      keyboard={false}
      onCancel={onClose}
      footer={
        <Space>
          <Button icon={<CopyOutlined />} onClick={copyKey}>
            {t('Copy Key')}
          </Button>
          <Button type="primary" onClick={onClose}>
            {t('Done')}
          </Button>
        </Space>
      }
    >
      <Alert
        type="warning"
        showIcon
        message={t('Store this key securely') as string}
        description={t('The full API key is shown only once and cannot be retrieved again.') as string}
        style={{ marginBottom: 12 }}
      />
      <div style={{ marginBottom: 4 }}>
        {t('Key Name') as string}: {value?.name}
      </div>
      <Input.TextArea readOnly value={value?.apiKey ?? ''} rows={3} style={{ fontFamily: 'monospace' }} />
    </Modal>
  );
};

export default ApiKeyCreatedModal;
