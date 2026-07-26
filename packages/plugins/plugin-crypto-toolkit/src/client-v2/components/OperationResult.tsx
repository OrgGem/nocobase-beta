import { Button, Space, Tag, message } from 'antd';
import { CloudDownloadOutlined, CopyOutlined } from '@ant-design/icons';
import React from 'react';
import { useT } from '../locale';

export interface OperationResultProps {
  attachmentId?: number | null;
  url?: string | null;
  filename?: string;
  size?: number;
  sha256?: string;
  json?: Record<string, unknown> | null;
  extraTags?: { label: string; color?: string; value: string }[];
}

export const OperationResult: React.FC<OperationResultProps> = ({
  attachmentId,
  url,
  filename,
  size,
  sha256,
  json,
  extraTags,
}) => {
  const t = useT();

  const copySha = async () => {
    if (!sha256) return;
    try {
      await navigator.clipboard.writeText(sha256);
      message.success(t('Copied') as string);
    } catch {
      message.error('clipboard unavailable');
    }
  };

  if (!attachmentId && !json) return null;

  return (
    <div style={{ background: '#fafafa', border: '1px solid #eee', padding: 12, borderRadius: 6 }}>
      <Space wrap>
        {filename && <Tag color="blue">{filename}</Tag>}
        {typeof size === 'number' && <Tag>{size} bytes</Tag>}
        {sha256 && (
          <Tag color="purple" style={{ fontFamily: 'monospace' }}>
            SHA-256: {sha256.slice(0, 16)}…
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={copySha} />
          </Tag>
        )}
        {extraTags?.map((tag, i) => (
          <Tag key={i} color={tag.color}>
            {tag.label}: {tag.value}
          </Tag>
        ))}
        {url && (
          <Button size="small" icon={<CloudDownloadOutlined />} href={url} target="_blank" rel="noreferrer">
            {t('Download')}
          </Button>
        )}
      </Space>
      {json && (
        <pre
          style={{
            marginTop: 8,
            background: '#0b1020',
            color: '#cdd6f4',
            padding: 8,
            borderRadius: 4,
            fontSize: 12,
            maxHeight: 280,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(json, null, 2)}
        </pre>
      )}
    </div>
  );
};

export default OperationResult;
