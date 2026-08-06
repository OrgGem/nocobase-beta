import React, { useEffect, useState, useCallback } from 'react';
import { Table, Tag, Button, Drawer, Select, Space, Badge } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { JobState, PipelineDef, formatDateTime, unwrapData } from '../types';

const STATUS_COLORS: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  polling: 'processing',
  completed: 'success',
  failed: 'error',
  timeout: 'error',
};

interface JobFilter {
  status?: string;
  pipelineId?: number;
}

export const JobsTab = () => {
  const ctx = useFlowContext();
  const api = ctx.api;
  const t = useT();
  const [data, setData] = useState<JobState[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined);
  const [filterPipeline, setFilterPipeline] = useState<number | undefined>(undefined);

  const statusLabels: Record<string, string> = {
    pending: t('Pending'),
    running: t('Running'),
    polling: t('Polling'),
    completed: t('Completed'),
    failed: t('Failed'),
    timeout: t('Timeout'),
  };

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const filter: JobFilter = {};
      if (filterStatus) filter.status = filterStatus;
      if (filterPipeline) filter.pipelineId = filterPipeline;

      const res = await api.request({
        url: 'docUnderstanding:listJobs',
        params: { filter: Object.keys(filter).length > 0 ? filter : undefined },
      });
      setData(unwrapData<JobState[]>(res, []));
    } finally {
      setLoading(false);
    }
  }, [api, filterStatus, filterPipeline]);

  const fetchPipelines = useCallback(async () => {
    try {
      const res = await api.request({ url: 'docUnderstanding:listPipelines' });
      setPipelines(unwrapData<PipelineDef[]>(res, []));
    } catch {
      // Pipeline names are only used to label rows; failing to load them is not fatal.
    }
  }, [api]);

  useEffect(() => {
    fetchPipelines();
  }, [fetchPipelines]);

  useEffect(() => {
    fetchJobs();
    const timer = setInterval(fetchJobs, 10000);
    return () => clearInterval(timer);
  }, [fetchJobs]);

  const pipelineMap = new Map(pipelines.map((p) => [p.id, p.name]));

  const viewDetails = async (record: JobState) => {
    try {
      const res = await api.request({
        url: 'docUnderstanding:getJobStatus',
        params: { filterByTk: record.id },
      });
      setActiveJob(unwrapData<JobState>(res, record));
    } catch {
      setActiveJob(record);
    }
    setDrawerVisible(true);
  };

  const columns: ColumnsType<JobState> = [
    { title: t('ID'), dataIndex: 'id', width: 60 },
    {
      title: t('Pipeline'),
      dataIndex: 'pipelineId',
      width: 180,
      render: (id: number) => pipelineMap.get(id) || `#${id}`,
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={STATUS_COLORS[status] || 'default'}>{statusLabels[status] || status}</Tag>
      ),
    },
    {
      title: t('Current Step'),
      dataIndex: 'currentStep',
      width: 90,
      render: (v: number, record) => {
        if (record.status === 'completed') return <Tag color="success">{t('Done')}</Tag>;
        if (record.status === 'failed') return <Tag color="error">{`${t('Step')} ${v}`}</Tag>;
        return <Badge status="processing" text={`${t('Step')} ${v}`} />;
      },
    },
    {
      title: t('Started'),
      dataIndex: 'startedAt',
      width: 160,
      render: (val: string) => formatDateTime(val),
    },
    {
      title: t('Completed'),
      dataIndex: 'completedAt',
      width: 160,
      render: (val: string) => formatDateTime(val),
    },
    {
      title: t('Action'),
      width: 80,
      render: (_: unknown, record) => (
        <Button
          size="small"
          icon={<EyeOutlined />}
          onClick={() => viewDetails(record)}
          aria-label={`${t('View')} #${record.id}`}
        >
          {t('View')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder={t('Filter by status')}
          aria-label={t('Filter by status')}
          value={filterStatus}
          onChange={setFilterStatus}
          style={{ width: 160 }}
          options={Object.keys(STATUS_COLORS).map((key) => ({ value: key, label: statusLabels[key] }))}
        />
        <Select
          allowClear
          placeholder={t('Filter by pipeline')}
          aria-label={t('Filter by pipeline')}
          value={filterPipeline}
          onChange={setFilterPipeline}
          style={{ width: 200 }}
          options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchJobs}>
          {t('Refresh')}
        </Button>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        size="small"
        pagination={{ pageSize: 20 }}
      />

      <Drawer
        title={
          activeJob
            ? `${t('Job')} #${activeJob.id} — ${pipelineMap.get(activeJob.pipelineId) || t('Unknown')}`
            : t('Job Details')
        }
        width={640}
        open={drawerVisible}
        onClose={() => setDrawerVisible(false)}
      >
        {activeJob && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Space wrap>
                <Tag color={STATUS_COLORS[activeJob.status] || 'default'}>
                  {statusLabels[activeJob.status] || activeJob.status}
                </Tag>
                {activeJob.startedAt && (
                  <span>
                    {t('Started')}: {formatDateTime(activeJob.startedAt)}
                  </span>
                )}
                {activeJob.completedAt && (
                  <span>
                    {t('Completed')}: {formatDateTime(activeJob.completedAt)}
                  </span>
                )}
              </Space>
            </div>

            {activeJob.error && (
              <div
                style={{
                  background: '#fff2f0',
                  border: '1px solid #ffccc7',
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 16,
                }}
              >
                <strong style={{ color: '#cf1322' }}>{t('Error')}:</strong>
                <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', color: '#cf1322' }}>{activeJob.error}</pre>
              </div>
            )}

            <h4>{t('Input')}</h4>
            <pre
              style={{
                background: '#f5f5f5',
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                maxHeight: 200,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(activeJob.input, null, 2)}
            </pre>

            <h4 style={{ marginTop: 16 }}>{t('Step Results')}</h4>
            {activeJob.stepResults && Object.keys(activeJob.stepResults).length > 0 ? (
              Object.entries(activeJob.stepResults).map(([key, val]) => (
                <div key={key} style={{ marginBottom: 8 }}>
                  <Tag color="blue">{key}</Tag>
                  <pre
                    style={{
                      background: '#f5f5f5',
                      padding: 8,
                      borderRadius: 4,
                      fontSize: 11,
                      maxHeight: 150,
                      overflow: 'auto',
                      marginTop: 4,
                    }}
                  >
                    {JSON.stringify(val, null, 2)}
                  </pre>
                </div>
              ))
            ) : (
              <div style={{ color: '#999' }}>{t('No step results yet')}</div>
            )}

            <h4 style={{ marginTop: 16 }}>{t('Final Result')}</h4>
            <pre
              style={{
                background: '#f0f5ff',
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                maxHeight: 300,
                overflow: 'auto',
              }}
            >
              {activeJob.finalResult ? JSON.stringify(activeJob.finalResult, null, 2) : t('(not yet available)')}
            </pre>

            {activeJob.externalTaskIds && Object.keys(activeJob.externalTaskIds).length > 0 && (
              <>
                <h4 style={{ marginTop: 16 }}>{t('External Task IDs')}</h4>
                <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, fontSize: 11 }}>
                  {JSON.stringify(activeJob.externalTaskIds, null, 2)}
                </pre>
              </>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
};
