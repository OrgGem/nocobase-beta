// SPDX-License-Identifier: Apache-2.0

import { CloudOutlined, DatabaseOutlined, HddOutlined, SwapOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Progress, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RcloneAboutUsage, RcloneRemoteSummary, RcloneTransferTaskRecord } from '../../shared/types';
import { useRcloneApi, type DashboardSummaryResponse } from '../api';
import { useRcloneSession } from '../hooks/useRcloneSession';
import { useT } from '../locale';
import { formatBytes, getErrorMessage } from '../utils/format';
import { ConnectionHeader } from './ConnectionHeader';

type UsageMap = Record<string, { loading: boolean; data?: RcloneAboutUsage; error?: string }>;

export const RcloneDashboard: React.FC = () => {
  const t = useT();
  const api = useRcloneApi();
  const { enabledConnections, selectedConnectionId, setSelectedConnectionId, permissions } = useRcloneSession();

  const [summary, setSummary] = useState<DashboardSummaryResponse | null>(null);
  const [recentTasks, setRecentTasks] = useState<RcloneTransferTaskRecord[]>([]);
  const [usageMap, setUsageMap] = useState<UsageMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeConnRef = useRef<number | null>(selectedConnectionId);
  activeConnRef.current = selectedConnectionId;

  const loadRemoteUsage = useCallback(
    async (connId: number, remoteName: string) => {
      if (activeConnRef.current !== connId) return;
      setUsageMap((prev) => ({ ...prev, [remoteName]: { loading: true } }));
      try {
        const usage = await api.remoteUsage(connId, `${remoteName}:`);
        if (activeConnRef.current !== connId) return;
        setUsageMap((prev) => ({ ...prev, [remoteName]: { loading: false, data: usage } }));
      } catch (err) {
        if (activeConnRef.current !== connId) return;
        setUsageMap((prev) => ({
          ...prev,
          [remoteName]: { loading: false, error: getErrorMessage(err) },
        }));
      }
    },
    [api],
  );

  const loadDashboard = useCallback(async () => {
    const connId = selectedConnectionId;
    if (!connId) {
      setSummary(null);
      setRecentTasks([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [dash, jobs] = await Promise.all([api.dashboardSummary(connId), api.listJobs(connId)]);
      if (activeConnRef.current !== connId) return;
      setSummary(dash);
      setRecentTasks(jobs.slice(0, 8));
      setUsageMap({});

      if (dash.checkUsageOnLoad) {
        const supported = dash.remotes.filter((r) => r.supportsAbout).slice(0, 12);
        for (const remote of supported) {
          loadRemoteUsage(connId, remote.name);
        }
      }
    } catch (err) {
      if (activeConnRef.current !== connId) return;
      setError(getErrorMessage(err, t('Failed to load Rclone dashboard')));
    } finally {
      if (activeConnRef.current === connId) {
        setLoading(false);
      }
    }
  }, [api, loadRemoteUsage, selectedConnectionId, t]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const remoteColumns: ColumnsType<RcloneRemoteSummary> = [
    {
      title: t('Remote'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Typography.Text strong>{name}:</Typography.Text>,
    },
    {
      title: t('Backend'),
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => <Tag color="blue">{type}</Tag>,
    },
    {
      title: t('Storage Usage'),
      key: 'usage',
      render: (_val: unknown, record: RcloneRemoteSummary) => {
        if (!record.supportsAbout) {
          return <Typography.Text type="secondary">{t('Usage API not supported')}</Typography.Text>;
        }
        const entry = usageMap[record.name];
        if (!entry) {
          return (
            <Button
              size="small"
              type="link"
              onClick={() => selectedConnectionId && loadRemoteUsage(selectedConnectionId, record.name)}
            >
              {t('Check usage')}
            </Button>
          );
        }
        if (entry.loading) {
          return <Typography.Text type="secondary">{t('Checking...')}</Typography.Text>;
        }
        if (entry.error) {
          return <Typography.Text type="danger">{entry.error}</Typography.Text>;
        }
        const used = entry.data?.used ?? 0;
        const total = entry.data?.total ?? 0;
        if (total > 0) {
          const pct = Math.min(100, Math.round((used / total) * 100));
          return (
            <div style={{ minWidth: 200 }}>
              <Progress percent={pct} size="small" />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatBytes(used)} / {formatBytes(total)}
              </Typography.Text>
            </div>
          );
        }
        return <Typography.Text>{formatBytes(used)}</Typography.Text>;
      },
    },
  ];

  const taskColumns: ColumnsType<RcloneTransferTaskRecord> = [
    {
      title: t('Operation'),
      dataIndex: 'operation',
      key: 'operation',
      render: (op: string) => <Tag>{op}</Tag>,
    },
    {
      title: t('Source -> Destination'),
      key: 'route',
      render: (_v: unknown, row: RcloneTransferTaskRecord) => (
        <Typography.Text ellipsis style={{ maxWidth: 360 }}>
          {row.srcRemote ? `${row.srcFs}/${row.srcRemote}` : row.srcFs} →{' '}
          {row.dstRemote ? `${row.dstFs}/${row.dstRemote}` : row.dstFs}
        </Typography.Text>
      ),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const color =
          status === 'completed'
            ? 'success'
            : status === 'running'
              ? 'processing'
              : status === 'failed'
                ? 'error'
                : 'default';
        return <Tag color={color}>{t(status)}</Tag>;
      },
    },
    {
      title: t('Progress'),
      dataIndex: 'progress',
      key: 'progress',
      width: 150,
      render: (pct: number) => <Progress percent={pct ?? 0} size="small" />,
    },
  ];

  return (
    <div role="region" aria-label={t('Rclone Dashboard')}>
      <ConnectionHeader
        title={t('Dashboard')}
        connections={enabledConnections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        onRefresh={loadDashboard}
        loading={loading}
      />

      {error && <Alert style={{ marginBottom: 16 }} type="error" showIcon message={error} />}

      {summary && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} md={6}>
              <Card size="small">
                <Statistic
                  title={t('Global Speed')}
                  value={`${formatBytes(summary.stats.speed ?? 0)}/s`}
                  prefix={<ThunderboltOutlined />}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card size="small">
                <Statistic
                  title={t('Transferred Session Data')}
                  value={formatBytes(summary.stats.bytes ?? 0)}
                  prefix={<DatabaseOutlined />}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card size="small">
                <Statistic title={t('Configured Remotes')} value={summary.remotes.length} prefix={<CloudOutlined />} />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card size="small">
                <Statistic
                  title={
                    permissions.canMounts || permissions.canServes
                      ? t('Active Workflow Jobs / Mounts / Serves')
                      : t('Active Workflow Jobs')
                  }
                  value={
                    permissions.canMounts || permissions.canServes
                      ? `${summary.activeTasksCount} / ${summary.mountsCount} / ${summary.servesCount}`
                      : summary.activeTasksCount
                  }
                  prefix={permissions.canMounts ? <HddOutlined /> : <SwapOutlined />}
                />
              </Card>
            </Col>
          </Row>

          <Card size="small" title={t('Cloud Remotes & Capacity')}>
            <Table
              rowKey="name"
              size="small"
              loading={loading}
              columns={remoteColumns}
              dataSource={summary.remotes}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
            />
          </Card>

          <Card size="small" title={t('Recent Workflow Transfers')}>
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              columns={taskColumns}
              dataSource={recentTasks}
              pagination={false}
            />
          </Card>
        </Space>
      )}
    </div>
  );
};

export default RcloneDashboard;
