// SPDX-License-Identifier: Apache-2.0

import { CloudServerOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Select, Space, Tag, Typography } from 'antd';
import React from 'react';
import type { RcloneConnectionPublic } from '../../shared/types';
import { useT } from '../locale';

export interface ConnectionHeaderProps {
  title: string;
  connections: RcloneConnectionPublic[];
  selectedConnectionId: number | null;
  onSelectConnection: (id: number) => void;
  onRefresh?: () => void;
  loading?: boolean;
  extra?: React.ReactNode;
}

export const ConnectionHeader: React.FC<ConnectionHeaderProps> = ({
  title,
  connections,
  selectedConnectionId,
  onSelectConnection,
  onRefresh,
  loading,
  extra,
}) => {
  const t = useT();
  const active = connections.find((c) => c.id === selectedConnectionId) ?? null;

  return (
    <div style={{ marginBottom: 16 }}>
      <Flex justify="space-between" align="center" wrap="wrap" gap={12}>
        <Space size="middle" wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Select
            aria-label={t('Select Rclone Connection')}
            style={{ minWidth: 220 }}
            placeholder={t('Select Rclone Connection')}
            value={selectedConnectionId ?? undefined}
            onChange={(val) => onSelectConnection(val)}
            options={connections.map((conn) => ({
              value: conn.id,
              label: conn.title ? `${conn.title} (${conn.name})` : conn.name,
            }))}
          />
          {active?.lastVersion && (
            <Tag icon={<CloudServerOutlined />} color="processing">
              {active.lastVersion}
            </Tag>
          )}
        </Space>
        <Space wrap>
          {extra}
          {onRefresh && (
            <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading} aria-label={t('Refresh')}>
              {t('Refresh')}
            </Button>
          )}
        </Space>
      </Flex>
      {!loading && connections.length === 0 && (
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          message={t('No active Rclone RC connection configured')}
          description={t(
            'Ask an administrator with Rclone Connections permission to add an enabled rclone rcd endpoint in the Connections & Config tab.',
          )}
        />
      )}
    </div>
  );
};
