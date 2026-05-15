import React, { useState, useEffect } from 'react';
import { Card, Tag, Button, Space, Spin, Typography, Tooltip } from 'antd';
import {
  GlobalOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  EyeOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useT } from './locale';

const { Text, Paragraph } = Typography;

interface AIBrowserSessionCardProps {
  sessionId: string;
  title?: string;
  status?: string;
  liveUrl?: string;
  currentUrl?: string;
  driver?: string;
  startedAt?: string;
  onStop?: (sessionId: string) => void;
  onViewLive?: (sessionId: string, liveUrl: string) => void;
}

const statusColors: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  stopped: 'warning',
  expired: 'default',
};

const statusIcons: Record<string, React.ReactNode> = {
  pending: <Spin size="small" />,
  running: <PlayCircleOutlined />,
  completed: <EyeOutlined />,
  failed: <CloseOutlined />,
  stopped: <PauseCircleOutlined />,
  expired: <CloseOutlined />,
};

/**
 * AIBrowserSessionCard — compact card shown in AI chat for a browser session.
 * Shows status, live URL, and action buttons.
 */
export const AIBrowserSessionCard: React.FC<AIBrowserSessionCardProps> = ({
  sessionId,
  title,
  status = 'pending',
  liveUrl,
  currentUrl,
  driver,
  startedAt,
  onStop,
  onViewLive,
}) => {
  const t = useT();

  return (
    <Card
      size="small"
      style={{
        borderRadius: 8,
        border: '1px solid #d9d9d9',
        background: status === 'running' ? '#f6ffed' : undefined,
      }}
      title={
        <Space>
          <GlobalOutlined />
          <Text strong>{title || t('Browser Session')}</Text>
          <Tag color={statusColors[status]}>{t(status.charAt(0).toUpperCase() + status.slice(1))}</Tag>
        </Space>
      }
      extra={
        <Space size="small">
          {liveUrl && onViewLive && (
            <Tooltip title={t('Open Live Viewer')}>
              <Button type="primary" size="small" icon={<EyeOutlined />} onClick={() => onViewLive(sessionId, liveUrl)}>
                {t('Live View')}
              </Button>
            </Tooltip>
          )}
          {onStop && status === 'running' && (
            <Tooltip title={t('Stop Session')}>
              <Button size="small" danger icon={<PauseCircleOutlined />} onClick={() => onStop(sessionId)} />
            </Tooltip>
          )}
        </Space>
      }
    >
      {currentUrl && (
        <Paragraph
          ellipsis={{ rows: 1 }}
          style={{ margin: 0, color: '#666', fontSize: 12 }}
        >
          🌐 {currentUrl}
        </Paragraph>
      )}
      {driver && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {t('Driver')}: {driver}
        </Text>
      )}
    </Card>
  );
};

export default AIBrowserSessionCard;
