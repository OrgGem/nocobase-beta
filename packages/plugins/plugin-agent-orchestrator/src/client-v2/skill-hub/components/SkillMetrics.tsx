import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Alert, Card, Table, Space, Row, Col, Statistic, Progress } from 'antd';
import { SyncOutlined, CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { useApiClient as useAPIClient } from '../../hooks/useApiRequest';
import { useT } from '../locale';

export const SkillMetrics: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [executions, setExecutions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchExecutions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch up to 1000 recent executions to calculate basic metrics
      const { data } = await api.request({
        url: 'skillExecutions:list',
        params: {
          pageSize: 1000,
          sort: ['-createdAt'],
          appends: ['skill'],
        },
      });
      const rawData = data?.data?.data ?? data?.data ?? [];
      setExecutions(Array.isArray(rawData) ? rawData : []);
    } catch (err) {
      const response = err as { response?: { data?: { errors?: { message?: string }[] } } };
      setExecutions([]);
      setError(
        response?.response?.data?.errors?.[0]?.message || (err as Error)?.message || t('Failed to load metrics'),
      );
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  const metrics = useMemo(() => {
    const total = executions.length;
    const succeeded = executions.filter((e) => e.status === 'succeeded').length;
    const failed = executions.filter((e) => e.status === 'failed').length;
    const timeout = executions.filter((e) => e.status === 'timeout').length;
    const canceled = executions.filter((e) => e.status === 'canceled').length;

    // Group by skill
    const bySkill: Record<string, any> = {};
    executions.forEach((e) => {
      const skillName = e.skill?.title || e.skill?.name || 'Unknown';
      if (!bySkill[skillName]) {
        bySkill[skillName] = {
          name: skillName,
          total: 0,
          succeeded: 0,
          failed: 0,
          timeout: 0,
          canceled: 0,
          totalDuration: 0,
          durationCount: 0,
        };
      }
      bySkill[skillName].total += 1;
      bySkill[skillName][e.status] = (bySkill[skillName][e.status] || 0) + 1;
      if (e.durationMs) {
        bySkill[skillName].totalDuration += e.durationMs;
        bySkill[skillName].durationCount += 1;
      }
    });

    const skillData = Object.values(bySkill)
      .map((s) => ({
        ...s,
        successRate: s.total > 0 ? (s.succeeded / s.total) * 100 : 0,
        avgDuration: s.durationCount > 0 ? (s.totalDuration / s.durationCount / 1000).toFixed(2) : 0,
      }))
      .sort((a: any, b: any) => b.total - a.total);

    return { total, succeeded, failed, timeout, canceled, skillData };
  }, [executions]);

  const columns = [
    { title: t('Skill'), dataIndex: 'name', key: 'name', width: 200 },
    { title: t('Total Runs'), dataIndex: 'total', key: 'total', width: 100 },
    {
      title: t('Success Rate'),
      dataIndex: 'successRate',
      key: 'successRate',
      width: 150,
      render: (val: number) => (
        <Progress
          percent={Math.round(val)}
          size="small"
          status={val === 100 ? 'success' : val > 50 ? 'active' : 'exception'}
        />
      ),
    },
    { title: t('Success'), dataIndex: 'succeeded', key: 'succeeded', width: 100 },
    { title: t('Failed'), dataIndex: 'failed', key: 'failed', width: 100 },
    { title: t('Timeout'), dataIndex: 'timeout', key: 'timeout', width: 100 },
    { title: t('Avg Duration (s)'), dataIndex: 'avgDuration', key: 'avgDuration', width: 120 },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', padding: '0 16px' }}>
      {error && <Alert type="error" showIcon message={error} />}
      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <Statistic title={t('Total Executions (Recent)')} value={metrics.total} prefix={<SyncOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Succeeded')}
              value={metrics.succeeded}
              valueStyle={{ color: '#3f8600' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Failed')}
              value={metrics.failed}
              valueStyle={{ color: '#cf1322' }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('Timeout/Canceled')}
              value={metrics.timeout + metrics.canceled}
              valueStyle={{ color: '#faad14' }}
              prefix={<ClockCircleOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Card title={t('Metrics by Skill (Recent)')}>
        <Table
          dataSource={metrics.skillData}
          columns={columns}
          rowKey="name"
          loading={loading}
          pagination={false}
          size="middle"
          scroll={{ x: 'max-content' }}
        />
      </Card>
    </Space>
  );
};
