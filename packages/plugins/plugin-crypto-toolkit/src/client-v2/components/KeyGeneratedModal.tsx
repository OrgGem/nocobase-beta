import { Alert, Button, Modal, Space, Tag, message } from 'antd';
import { CopyOutlined, DownloadOutlined, WarningOutlined } from '@ant-design/icons';
import React from 'react';
import { useT } from '../locale';

export interface GeneratedKeyResult {
  key: Record<string, unknown>;
  publicMaterial: string;
  publicFormat: string;
  fingerprint: string;
  privateMaterial: string;
  savedToEnv: boolean;
  envVarName: string | null;
}

export interface KeyGeneratedModalProps {
  open: boolean;
  result: GeneratedKeyResult | null;
  onClose: () => void;
}

export const KeyGeneratedModal: React.FC<KeyGeneratedModalProps> = ({ open, result, onClose }) => {
  const t = useT();
  if (!result) return null;

  const downloadBoth = () => {
    const base = String(result.key?.name ?? 'key');
    const privBlob = new Blob([result.privateMaterial], { type: 'text/plain' });
    const pubBlob = new Blob([result.publicMaterial], { type: 'text/plain' });
    triggerDownload(privBlob, `${base}.private`);
    triggerDownload(pubBlob, `${base}.public`);
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label} ${t('Copied') as string}`);
    } catch {
      message.error('clipboard unavailable');
    }
  };

  return (
    <Modal
      open={open}
      title={t('Generate Key')}
      onCancel={onClose}
      onOk={onClose}
      okText={t('Close')}
      cancelButtonProps={{ style: { display: 'none' } }}
      width={720}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Alert
          showIcon
          type="warning"
          icon={<WarningOutlined />}
          message={t('One-time private material — copy now, it will not be shown again') as string}
        />
        <div>
          <Space>
            <Tag color="blue">
              {t('Fingerprint')}: {result.fingerprint}
            </Tag>
            <Tag color="cyan">{result.publicFormat}</Tag>
            {result.savedToEnv && (
              <Tag color="green">
                {t('Saved to env')}: {result.envVarName}
              </Tag>
            )}
          </Space>
        </div>
        <div>
          <strong>{t('Private material')}</strong>
          <pre
            style={{
              maxHeight: 220,
              overflow: 'auto',
              background: '#1a1a1a',
              color: '#f8f8f2',
              padding: 8,
              borderRadius: 4,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              margin: '4px 0 0 0',
            }}
          >
            {result.privateMaterial}
          </pre>
          <Space style={{ marginTop: 8 }}>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copy(result.privateMaterial, t('Private material') as string)}
            >
              {t('Copy to clipboard')}
            </Button>
            <Button size="small" icon={<DownloadOutlined />} onClick={downloadBoth}>
              {t('Download')}
            </Button>
          </Space>
        </div>
        <div>
          <strong>{t('Public material')}</strong>
          <pre
            style={{
              maxHeight: 220,
              overflow: 'auto',
              background: '#f5f5f5',
              color: '#222',
              padding: 8,
              borderRadius: 4,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              margin: '4px 0 0 0',
            }}
          >
            {result.publicMaterial}
          </pre>
        </div>
      </Space>
    </Modal>
  );
};

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default KeyGeneratedModal;
