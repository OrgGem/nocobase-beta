// SPDX-License-Identifier: Apache-2.0

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { HaproxyFleetNodeStatus } from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useT } from '../locale';
import { formatDurationSeconds, getErrorMessage } from '../utils/format';

export const HaproxyFleetView: React.FC = () => {
  const t = useT();
  const api = useHaproxyApi();

  const [nodes, setNodes] = useState<HaproxyFleetNodeStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFleet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.fleetOverview();
      setNodes(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadFleet();
  }, [loadFleet]);

  const metrics = useMemo(() => {
    const online = nodes.filter((n) => n.reachable).length;
    const totalConns = nodes.reduce((acc, n) => acc + (n.currConns ?? 0), 0);
    const upServers = nodes.reduce((acc, n) => acc + n.upServers, 0);
    const totalServers = nodes.reduce((acc, n) => acc + n.totalServers, 0);
    const openTxs = nodes.reduce((acc, n) => acc + n.openTransactions, 0);
    return { online, totalConns, upServers, totalServers, openTxs };
  }, [nodes]);

  const columns: ColumnsType<HaproxyFleetNodeStatus> = useMemo(
    () => [
      {
        title: t('Node'),
        key: 'node',
        render: (_v: unknown, row: HaproxyFleetNodeStatus) => (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{row.title || row.name}</Typography.Text>
            {row.hostname && <Typography.Text type="secondary">{row.hostname}</Typography.Text>}
          </Space>
        ),
      },
      {
        title: t('Status'),
        key: 'reachable',
        render: (_v: unknown, row: HaproxyFleetNodeStatus) =>
          row.reachable ? (
            <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
              {t('Online')}
            </Tag>
          ) : (
            <Tag icon={<CloseCircleOutlined aria-hidden="true" />} color="error">
              {t('Unreachable')}
            </Tag>
          ),
      },
      {
        title: t('HAProxy Version'),
        key: 'version',
        render: (_v: unknown, row: HaproxyFleetNodeStatus) =>
          row.haproxyVersion ? `HAProxy ${row.haproxyVersion} (${row.apiVersion ?? 'v3'})` : '—',
      },
      {
        title: t('Config Version'),
        dataIndex: 'configVersion',
        key: 'configVersion',
        render: (ver: number | null) => (ver != null ? <Tag color="geekblue">v{ver}</Tag> : '—'),
      },
      {
        title: t('Active Connections'),
        key: 'conns',
        render: (_v: unknown, row: HaproxyFleetNodeStatus) =>
          row.currConns != null ? `${row.currConns}${row.maxConn ? ` / ${row.maxConn}` : ''}` : '—',
      },
      {
        title: t('Servers UP'),
        key: 'servers',
        render: (_v: unknown, row: HaproxyFleetNodeStatus) =>
          row.reachable ? `${row.upServers} / ${row.totalServers}` : '—',
      },
      {
        title: t('Open Transactions'),
        dataIndex: 'openTransactions',
        key: 'openTransactions',
        render: (count: number) =>
          count > 0 ? (
            <Tag icon={<WarningOutlined aria-hidden="true" />} color="gold">
              {count}
            </Tag>
          ) : (
            '0'
          ),
      },
      {
        title: t('Last Reload'),
        key: 'reload',
        render: (_v: unknown, row: HaproxyFleetNodeStatus) => {
          if (!row.lastReloadStatus) return '—';
          if (row.lastReloadStatus === 'succeeded') {
            return (
              <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
                succeeded
              </Tag>
            );
          }
          if (row.lastReloadStatus === 'failed') {
            return (
              <Tag icon={<CloseCircleOutlined aria-hidden="true" />} color="error">
                failed
              </Tag>
            );
          }
          return (
            <Tag icon={<SyncOutlined spin aria-hidden="true" />} color="processing">
              {row.lastReloadStatus}
            </Tag>
          );
        },
      },
      {
        title: t('Uptime'),
        dataIndex: 'uptime',
        key: 'uptime',
        render: (u: number | null) => formatDurationSeconds(u),
      },
    ],
    [t],
  );

  if (!loading && nodes.length === 0 && !error) {
    return (
      <Card>
        <Empty description={t('No enabled HAProxy Data Plane connections')} />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} />}

      <Row gutter={[12, 12]}>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title={t('Reachable Nodes')} value={metrics.online} suffix={`/ ${nodes.length}`} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title={t('Active Connections')} value={metrics.totalConns} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title={t('Servers UP')} value={metrics.upServers} suffix={`/ ${metrics.totalServers}`} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title={t('Open Transactions')} value={metrics.openTxs} />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={t('Fleet Overview')}
        extra={
          <Button htmlType="button" icon={<ReloadOutlined aria-hidden="true" />} loading={loading} onClick={loadFleet}>
            {t('Refresh')}
          </Button>
        }
      >
        <Table<HaproxyFleetNodeStatus>
          rowKey="connectionId"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={nodes}
          scroll={{ x: 960 }}
          expandable={{
            rowExpandable: (r) => Boolean(r.error),
            expandedRowRender: (r) => <Alert type="error" showIcon message={r.error} />,
          }}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
        />
      </Card>
    </Space>
  );
};

export default HaproxyFleetView;
