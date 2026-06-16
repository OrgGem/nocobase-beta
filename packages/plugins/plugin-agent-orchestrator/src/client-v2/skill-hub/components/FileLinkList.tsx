import React from 'react';
import { Space, Typography } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';

export interface FileLinkItem {
  name: string;
  url?: string;
  downloadUrl?: string;
}

/**
 * client-v2 replacement for the v1 `Upload.ReadPretty` file list, which is not
 * exported by `@nocobase/client-v2`. Renders a simple vertical list of download
 * links; non-resolvable entries fall back to plain text.
 */
export const FileLinkList: React.FC<{ files: FileLinkItem[] }> = ({ files }) => {
  if (!Array.isArray(files) || files.length === 0) {
    return <Typography.Text type="secondary">-</Typography.Text>;
  }
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      {files.map((file, index) => {
        const url = file.downloadUrl || file.url;
        const label = file.name || `file-${index + 1}`;
        return url ? (
          <a key={`${label}-${index}`} href={url} target="_blank" rel="noreferrer">
            <PaperClipOutlined /> {label}
          </a>
        ) : (
          <Typography.Text key={`${label}-${index}`}>
            <PaperClipOutlined /> {label}
          </Typography.Text>
        );
      })}
    </Space>
  );
};
