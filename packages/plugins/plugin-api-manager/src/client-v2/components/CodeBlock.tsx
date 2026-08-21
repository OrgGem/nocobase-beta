import { Button, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import React from 'react';
import { useT } from '../locale';

interface CodeBlockProps {
  value: string;
  copyable?: boolean;
  maxHeight?: number;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ value, copyable = true, maxHeight = 280 }) => {
  const t = useT();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(t('Copied to clipboard') as string);
    } catch {
      message.error(t('Copy failed — select and copy manually') as string);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      {copyable && (
        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={copy}
          style={{ position: 'absolute', top: 6, right: 6, zIndex: 1 }}
        >
          {t('Copy')}
        </Button>
      )}
      <pre
        style={{
          margin: 0,
          padding: 12,
          paddingRight: copyable ? 96 : 12,
          background: '#f5f5f5',
          border: '1px solid #e8e8e8',
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          maxHeight,
          overflow: 'auto',
        }}
      >
        {value}
      </pre>
    </div>
  );
};

export default CodeBlock;
