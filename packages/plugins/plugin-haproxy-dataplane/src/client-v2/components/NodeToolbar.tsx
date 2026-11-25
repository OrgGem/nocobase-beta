// SPDX-License-Identifier: Apache-2.0

import { ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Col, Row, Select, Space, Typography } from 'antd';
import React from 'react';
import type { HaproxyConnectionPublic } from '../../shared/types';
import { useT } from '../locale';

export interface NodeToolbarProps {
  connections: HaproxyConnectionPublic[];
  selectedConnectionId: number | null;
  onSelectConnection: (id: number) => void;
  fixedConnectionId?: number;
  loading?: boolean;
  onRefresh?: () => void;
  extraLeft?: React.ReactNode;
  extraRight?: React.ReactNode;
}

export const NodeToolbar: React.FC<NodeToolbarProps> = ({
  connections,
  selectedConnectionId,
  onSelectConnection,
  fixedConnectionId,
  loading,
  onRefresh,
  extraLeft,
  extraRight,
}) => {
  const t = useT();

  return (
    <Card size="small">
      <Row gutter={[12, 12]} align="middle" justify="space-between">
        <Col>
          <Space wrap>
            <Typography.Text strong>{t('Node')}:</Typography.Text>
            <Select
              style={{ minWidth: 230 }}
              aria-label={t('Select HAProxy node')}
              value={selectedConnectionId ?? undefined}
              disabled={Boolean(fixedConnectionId)}
              onChange={(val: number) => onSelectConnection(val)}
              options={connections.map((conn) => ({
                value: conn.id,
                label: conn.title ? `${conn.title} (${conn.name})` : conn.name,
              }))}
            />
            {extraLeft}
            {onRefresh && (
              <Button
                htmlType="button"
                icon={<ReloadOutlined aria-hidden="true" />}
                loading={loading}
                onClick={onRefresh}
              >
                {t('Refresh')}
              </Button>
            )}
          </Space>
        </Col>
        {extraRight && <Col>{extraRight}</Col>}
      </Row>
    </Card>
  );
};
