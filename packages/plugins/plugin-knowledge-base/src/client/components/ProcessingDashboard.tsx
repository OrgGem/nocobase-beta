/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { Card, Col, message, Row, Spin, Statistic, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  RetweetOutlined,
  SyncOutlined,
} from '@ant-design/icons';

const { Title } = Typography;

type DocStats = {
  total: number;
  pending: number;
  processing: number;
  success: number;
  failed: number;
  retrying: number;
};

const EMPTY_STATS: DocStats = { total: 0, pending: 0, processing: 0, success: 0, failed: 0, retrying: 0 };

const REFRESH_INTERVAL_MS = 10_000;

export const ProcessingDashboard: React.FC = () => {
  const api = useApp().apiClient;
  const [stats, setStats] = useState<DocStats>(EMPTY_STATS);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await api.request({ url: 'aiKnowledgeBaseDoc:stats' });
      setStats({ ...EMPTY_STATS, ...(res?.data?.data ?? {}) });
      setLastUpdated(new Date());
    } catch {
      message.error('Failed to load processing stats');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchStats();
    const timer = setInterval(fetchStats, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchStats]);

  if (loading && stats.total === 0 && !lastUpdated) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          Document Processing
        </Title>
        <Tag icon={<SyncOutlined spin={stats.processing > 0} />} color="default">
          Auto-refresh every {REFRESH_INTERVAL_MS / 1000}s
          {lastUpdated ? ` · updated ${lastUpdated.toLocaleTimeString()}` : ''}
        </Tag>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic title="Total" value={stats.total} prefix={<FileTextOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic title="Pending" value={stats.pending} prefix={<ClockCircleOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic
              title="Processing"
              value={stats.processing}
              prefix={<SyncOutlined spin={stats.processing > 0} />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic
              title="Ready"
              value={stats.success}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic
              title="Failed"
              value={stats.failed}
              prefix={<CloseCircleOutlined />}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic title="Retrying" value={stats.retrying} prefix={<RetweetOutlined />} />
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default ProcessingDashboard;
