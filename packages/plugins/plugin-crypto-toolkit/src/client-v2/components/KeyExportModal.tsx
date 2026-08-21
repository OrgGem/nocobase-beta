import { Alert, Button, Modal, Radio, Space, message } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import React, { useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

interface KeyRow {
  id: number;
  name: string;
  publicFormat: 'pem' | 'openpgp' | 'openssh' | string;
}

type Format = 'pem' | 'openssh' | 'armored';

interface ExportResult {
  ok: boolean;
  filename: string;
  contentType: string;
  content: string;
  fingerprint?: string;
}

export interface KeyExportModalProps {
  open: boolean;
  record: KeyRow | null;
  onClose: () => void;
}

export const KeyExportModal: React.FC<KeyExportModalProps> = ({ open, record, onClose }) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [format, setFormat] = useState<Format>('pem');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setFormat('pem');
    }
  }, [open]);

  const doExport = async () => {
    if (!record) return;
    setLoading(true);
    try {
      const res = await api.request({
        // Must target the plugin's own `exportKey` action: `cryptoKeys:export`
        // is intercepted by plugin-action-export's global XLSX handler (500).
        url: 'cryptoKeys:exportKey',
        params: { filterByTk: record.id, format },
      });
      setResult((res?.data?.data ?? res?.data) as ExportResult);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to export key') as string));
    } finally {
      setLoading(false);
    }
  };

  const downloadAsFile = () => {
    if (!result) return;
    const blob = new Blob([result.content], { type: result.contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.content);
      message.success(t('Copied') as string);
    } catch {
      message.error('clipboard unavailable');
    }
  };

  const formatOptions: { value: Format; label: string }[] = [{ value: 'pem', label: 'PEM' }];
  if (record?.publicFormat === 'pem') formatOptions.push({ value: 'openssh', label: 'OpenSSH' });
  if (record?.publicFormat === 'openssh') formatOptions.push({ value: 'pem', label: 'PEM' });
  if (record?.publicFormat === 'openpgp') formatOptions.push({ value: 'armored', label: 'Armored' });

  return (
    <Modal open={open && !!record} title={t('Export Key')} onCancel={onClose} footer={null} width={640} destroyOnClose>
      {record && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Radio.Group
            value={format}
            onChange={(e) => setFormat(e.target.value as Format)}
            options={formatOptions}
            optionType="button"
          />
          <Button type="primary" loading={loading} onClick={doExport} icon={<DownloadOutlined />}>
            {t('Export')}
          </Button>
          {result && (
            <Alert
              type="info"
              showIcon
              message={
                <Space>
                  <code>{result.filename}</code>
                  <Button size="small" icon={<DownloadOutlined />} onClick={downloadAsFile}>
                    {t('Download')}
                  </Button>
                  <Button size="small" icon={<CopyOutlined />} onClick={copyToClipboard}>
                    {t('Copy to clipboard')}
                  </Button>
                </Space>
              }
              description={
                <pre
                  style={{
                    maxHeight: 240,
                    overflow: 'auto',
                    background: '#0b1020',
                    color: '#cdd6f4',
                    padding: 8,
                    borderRadius: 4,
                    fontSize: 12,
                    whiteSpace: 'pre',
                    margin: 0,
                  }}
                >
                  {result.content}
                </pre>
              }
            />
          )}
        </Space>
      )}
    </Modal>
  );
};

export default KeyExportModal;
