import { ReloadOutlined, RedoOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { Button, Card, Col, Row, Select, Space, Statistic, Table, Tag, message } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { actionData, ActionResponse, ApiEnvelope, errorMessage } from './shared';
interface Job {
  id: number;
  jobId: string;
  operation: string;
  status: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  nextAttemptAt?: string;
}
interface Audit {
  id: number;
  requestId: string;
  jobId?: string;
  operation: string;
  status: string;
  httpStatus?: number;
  graphHttpStatus?: number;
  graphRequestId?: string;
  apiKeyPrefix?: string;
  attempt?: number;
  durationMs?: number;
  error?: string;
  createdAt: string;
}
const colors: Record<string, string> = {
  succeeded: 'green',
  failed: 'red',
  processing: 'blue',
  retrying: 'orange',
  pending: 'default',
};
export default function OperationsPage() {
  const api = useFlowContext().api;
  const t = useT();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<string>();
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [j, a, d] = await Promise.all([
        api.request<ActionResponse<ApiEnvelope<Job[]>>>({
          url: 'msGraphGateway:listJobs',
          method: 'post',
          data: { pageSize: 50, status },
        }),
        api.request<ActionResponse<ApiEnvelope<Audit[]>>>({
          url: 'msGraphGateway:listAuditLogs',
          method: 'post',
          data: { pageSize: 50 },
        }),
        api.request<ActionResponse<ApiEnvelope<Record<string, number>>>>({ url: 'msGraphGateway:dashboard' }),
      ]);
      setJobs(actionData(j.data).data);
      setAudits(actionData(a.data).data);
      setStats(actionData(d.data).data);
    } finally {
      setLoading(false);
    }
  }, [api, status]);
  useEffect(() => {
    load().catch((error) => message.error(errorMessage(error, t('Load failed'))));
  }, [load, t]);
  const retry = async (jobId: string) => {
    await api.request({ url: 'msGraphGateway:retryJob', method: 'post', data: { jobId } });
    message.success(t('Job queued for retry'));
    await load();
  };
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        {['pending', 'processing', 'retrying', 'succeeded', 'failed'].map((key) => (
          <Col xs={12} md={4} key={key}>
            <Card size="small">
              <Statistic title={t(key)} value={stats[key] || 0} />
            </Card>
          </Col>
        ))}
      </Row>
      <Card
        title={t('Queue')}
        extra={
          <Space>
            <Select
              allowClear
              placeholder={t('Status')}
              value={status}
              onChange={setStatus}
              options={['pending', 'processing', 'retrying', 'succeeded', 'failed'].map((value) => ({
                value,
                label: value,
              }))}
            />
            <Button icon={<ReloadOutlined />} onClick={load}>
              {t('Refresh')}
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={jobs}
          scroll={{ x: 1000 }}
          columns={[
            { title: t('Job ID'), dataIndex: 'jobId', width: 220 },
            { title: t('Operation'), dataIndex: 'operation', width: 160 },
            {
              title: t('Status'),
              dataIndex: 'status',
              width: 110,
              render: (v: string) => <Tag color={colors[v]}>{v}</Tag>,
            },
            { title: t('Attempts'), dataIndex: 'attempts', width: 90 },
            { title: t('Last error'), dataIndex: 'lastError', ellipsis: true },
            {
              title: t('Created at'),
              dataIndex: 'createdAt',
              width: 180,
              render: (v: string) => new Date(v).toLocaleString(),
            },
            {
              title: '',
              width: 100,
              render: (_: unknown, row: Job) =>
                ['failed', 'retrying'].includes(row.status) && (
                  <Button size="small" icon={<RedoOutlined />} onClick={() => retry(row.jobId)}>
                    {t('Retry')}
                  </Button>
                ),
            },
          ]}
        />
      </Card>
      <Card title={t('Audit log')}>
        <Table
          rowKey="id"
          dataSource={audits}
          scroll={{ x: 1500 }}
          columns={[
            {
              title: t('Time'),
              dataIndex: 'createdAt',
              width: 180,
              render: (v: string) => new Date(v).toLocaleString(),
            },
            { title: t('Request ID'), dataIndex: 'requestId', width: 220, ellipsis: true },
            { title: t('Job ID'), dataIndex: 'jobId', width: 220 },
            { title: t('Operation'), dataIndex: 'operation', width: 160 },
            {
              title: t('Status'),
              dataIndex: 'status',
              width: 120,
              render: (v: string) => <Tag color={colors[v]}>{v}</Tag>,
            },
            { title: t('HTTP status'), dataIndex: 'httpStatus', width: 110 },
            { title: t('Graph status'), dataIndex: 'graphHttpStatus', width: 110 },
            { title: t('API key'), dataIndex: 'apiKeyPrefix', width: 130 },
            { title: t('Graph request ID'), dataIndex: 'graphRequestId', width: 220, ellipsis: true },
            { title: t('Attempt'), dataIndex: 'attempt', width: 90 },
            { title: t('Duration (ms)'), dataIndex: 'durationMs', width: 120 },
            { title: t('Error'), dataIndex: 'error', ellipsis: true },
          ]}
        />
      </Card>
    </Space>
  );
}
