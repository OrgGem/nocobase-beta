import React from 'react';
import { Card, Col, Row, Statistic, Badge, Table, Tag, Spin } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
  HeartOutlined,
} from '@ant-design/icons';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useT } from '../locale';

export const Dashboard: React.FC = () => {
  const t = useT();
  const { data, loading } = useN8nRequest('n8nMonitoring', 'dashboard');

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '60px auto' }} />;
  if (!data) return null;

  const { health, workflows, executions, recentFailures } = data;

  const failureColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 100 },
    {
      title: t('Workflow'),
      key: 'workflow',
      render: (_: any, r: any) => r.workflowData?.name || `#${r.workflowId}`,
    },
    {
      title: t('Started'),
      dataIndex: 'startedAt',
      key: 'startedAt',
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
  ];

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={t('Health')}
              value={health?.status === 'healthy' ? t('Healthy') : t('Unhealthy')}
              valueStyle={{ color: health?.status === 'healthy' ? '#3f8600' : '#cf1322' }}
              prefix={<HeartOutlined />}
              suffix={health?.latencyMs ? `${health.latencyMs}ms` : ''}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={t('Workflows')}
              value={workflows?.active || 0}
              suffix={`/ ${workflows?.total || 0}`}
              prefix={<ThunderboltOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={t('Success Rate')}
              value={executions?.successRate || 0}
              suffix="%"
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: (executions?.successRate || 0) >= 90 ? '#3f8600' : '#cf1322' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={t('Executions')}
              value={executions?.total || 0}
              prefix={<PlayCircleOutlined />}
            />
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <Tag color="green">{executions?.success || 0} {t('success')}</Tag>
              <Tag color="red">{executions?.error || 0} {t('error')}</Tag>
              <Tag color="blue">{executions?.running || 0} {t('running')}</Tag>
            </div>
          </Card>
        </Col>
      </Row>

      {recentFailures?.length > 0 && (
        <Card title={t('Recent Failures')} style={{ marginTop: 16 }}>
          <Table columns={failureColumns} dataSource={recentFailures} rowKey="id" pagination={false} size="small" />
        </Card>
      )}
    </div>
  );
};
