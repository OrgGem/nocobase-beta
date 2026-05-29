/**
 * Overview Dashboard — KPI cards + recent failures
 */

import React from 'react';
import { Alert, Card, Row, Col, Statistic, Typography, Table, Tag, Spin } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

const stateColors: Record<string, string> = {
  Faulted: 'red',
  Stopped: 'orange',
  Running: 'blue',
  Pending: 'gold',
  Successful: 'green',
  Suspended: 'purple',
};

type StatsMap = Record<string, number | string | undefined>;
type DashboardData = {
  jobsStats?: StatsMap | null;
  sessionsStats?: StatsMap | null;
  countStats?: unknown;
  licenseStats?: unknown;
  recentFaultedJobs?: unknown;
  errorLogs24h?: number | string | null;
};

export const OverviewDashboard: React.FC = () => {
  const t = useT();
  const { data, loading, error } = useUiPathRequest('uipathStats', 'dashboard');
  const dashboard = data && typeof data === 'object' ? (data as DashboardData) : null;

  if (loading) return <Spin tip={t('Loading dashboard...')} />;
  if (error) return <Alert type="error" showIcon message={t('Failed')} description={error.message} />;
  if (!dashboard) return <Typography.Text type="secondary">{t('No data')}</Typography.Text>;

  const { jobsStats, sessionsStats, errorLogs24h } = dashboard;
  const recentFaultedJobs = toUiPathArray(dashboard.recentFaultedJobs);

  return (
    <div>
      {/* KPI Cards */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Running Jobs')}
              value={jobsStats?.Running ?? '-'}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Pending Jobs')}
              value={jobsStats?.Pending ?? '-'}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ color: '#faad14' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Faulted Jobs')}
              value={jobsStats?.Faulted ?? '-'}
              prefix={<CloseCircleOutlined />}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Successful Jobs')}
              value={jobsStats?.Successful ?? '-'}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title={t('Error Logs (24h)')}
              value={errorLogs24h ?? '-'}
              prefix={<WarningOutlined />}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic title={t('Sessions')} value={sessionsStats?.Total ?? '-'} prefix={<RobotOutlined />} />
          </Card>
        </Col>
      </Row>

      {/* Sessions Breakdown */}
      {sessionsStats && (
        <Card title={t('Robot Sessions')} size="small" style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={6}>
              <Statistic title={t('Available')} value={sessionsStats.Available} valueStyle={{ color: '#52c41a' }} />
            </Col>
            <Col span={6}>
              <Statistic title={t('Busy')} value={sessionsStats.Busy} valueStyle={{ color: '#1890ff' }} />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('Disconnected')}
                value={sessionsStats.Disconnected}
                valueStyle={{ color: '#ff4d4f' }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('Unresponsive')}
                value={sessionsStats.Unresponsive}
                valueStyle={{ color: '#faad14' }}
              />
            </Col>
          </Row>
        </Card>
      )}

      {/* Recent Faulted Jobs */}
      <Card title={t('Recent Faulted Jobs')} size="small" style={{ marginTop: 16 }}>
        <Table
          dataSource={recentFaultedJobs || []}
          rowKey="Id"
          size="small"
          pagination={false}
          columns={[
            { title: t('ID'), dataIndex: 'Id', width: 80 },
            { title: t('Process'), dataIndex: 'ReleaseName', ellipsis: true },
            {
              title: t('State'),
              dataIndex: 'State',
              width: 100,
              render: (s: string) => <Tag color={stateColors[s]}>{s}</Tag>,
            },
            { title: t('Machine'), dataIndex: 'HostMachineName', ellipsis: true },
            { title: t('Info'), dataIndex: 'Info', ellipsis: true },
            {
              title: t('Time'),
              dataIndex: 'CreationTime',
              width: 180,
              render: (t: string) => (t ? new Date(t).toLocaleString() : '-'),
            },
          ]}
        />
      </Card>
    </div>
  );
};
