import React, { useState } from 'react';
import { Button, Space, Typography } from 'antd';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { useT } from '../locale';

export function DockerCommand({ command }: { command: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Typography.Text code style={{ flex: 1, padding: '6px 10px', overflowX: 'auto' }}>
        {command}
      </Typography.Text>
      <Button aria-label={t('Copy command')} icon={copied ? <CheckOutlined /> : <CopyOutlined />} onClick={copy} />
    </Space.Compact>
  );
}
