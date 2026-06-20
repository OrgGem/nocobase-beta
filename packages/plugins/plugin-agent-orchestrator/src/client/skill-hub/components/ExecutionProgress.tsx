import React from 'react';
import { Progress, Typography } from 'antd';
import { LoadingOutlined, CheckCircleOutlined } from '@ant-design/icons';

interface ExecutionProgressProps {
  execId: string;
  skillName: string;
  percent: number;
  log: string;
}

/**
 * Progress component rendered inside chat UI when receiving
 * SSE custom event: {action: "skillProgress", body: {...}}
 *
 * Usage in chat message renderer:
 * ```
 * if (event.action === 'skillProgress') {
 *   return <ExecutionProgress {...event.body} />;
 * }
 * ```
 */
export const ExecutionProgress: React.FC<ExecutionProgressProps> = ({ skillName, percent, log }) => {
  const isDone = percent >= 100;

  return (
    <div style={{ padding: '8px 12px', background: '#fafafa', borderRadius: 6, margin: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        {isDone ? (
          <CheckCircleOutlined style={{ color: '#52c41a' }} />
        ) : (
          <LoadingOutlined style={{ color: '#1890ff' }} />
        )}
        <Typography.Text strong style={{ fontSize: 13 }}>
          {skillName}
        </Typography.Text>
      </div>
      <Progress
        percent={percent}
        size="small"
        status={isDone ? 'success' : 'active'}
        strokeColor={isDone ? '#52c41a' : '#1890ff'}
      />
      {log && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {log}
        </Typography.Text>
      )}
    </div>
  );
};
