import React, { useEffect, useState, useCallback } from 'react';
import { Table, Tag, Button, Drawer, Select, Space, Badge } from 'antd';
import { EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: 'Pending' },
  running: { color: 'processing', label: 'Running' },
  polling: { color: 'processing', label: 'Polling' },
  completed: { color: 'success', label: 'Completed' },
  failed: { color: 'error', label: 'Failed' },
  timeout: { color: 'error', label: 'Timeout' },
};

export const JobsTab = () => {
  const api = useAPIClient();
  const [data, setData] = useState<any[]>([]);
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [activeJob, setActiveJob] = useState<any>(null);
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined);
  const [filterPipeline, setFilterPipeline] = useState<number | undefined>(undefined);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const filter: any = {};
      if (filterStatus) filter.status = filterStatus;
      if (filterPipeline) filter.pipelineId = filterPipeline;

      const res = await api.request({
        url: 'docUnderstanding:listJobs',
        params: { filter: Object.keys(filter).length > 0 ? filter : undefined },
      });
      setData(res.data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api, filterStatus, filterPipeline]);

  const fetchPipelines = useCallback(async () => {
    try {
      const res = await api.request({ url: 'docUnderstanding:listPipelines' });
      setPipelines(res.data?.data || []);
    } catch {
      // ignore
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

  const pipelineMap = new Map(pipelines.map((p: any) => [p.id, p.name]));

  const viewDetails = async (record: any) => {
    // Fetch fresh job data for detail view
    try {
      const res = await api.request({
        url: 'docUnderstanding:getJobStatus',
        params: { filterByTk: record.id },
      });
      setActiveJob(res.data?.data || record);
    } catch {
      setActiveJob(record);
    }
    setDrawerVisible(true);
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    {
      title: 'Pipeline',
      dataIndex: 'pipelineId',
      width: 180,
      render: (id: number) => pipelineMap.get(id) || `#${id}`,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (status: string) => {
        const cfg = STATUS_CONFIG[status] || { color: 'default', label: status };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
    {
      title: 'Current Step',
      dataIndex: 'currentStep',
      width: 90,
      render: (v: number, record: any) => {
        if (record.status === 'completed') return <Tag color="success">Done</Tag>;
        if (record.status === 'failed') return <Tag color="error">Step {v}</Tag>;
        return <Badge status="processing" text={`Step ${v}`} />;
      },
    },
    {
      title: 'Started',
      dataIndex: 'startedAt',
      width: 160,
      render: (val: string) => (val ? new Date(val).toLocaleString() : '-'),
    },
    {
      title: 'Completed',
      dataIndex: 'completedAt',
      width: 160,
      render: (val: string) => (val ? new Date(val).toLocaleString() : '-'),
    },
    {
      title: 'Action',
      width: 80,
      render: (_: any, record: any) => (
        <Button size="small" icon={<EyeOutlined />} onClick={() => viewDetails(record)}>
          View
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="Filter by status"
          value={filterStatus}
          onChange={setFilterStatus}
          style={{ width: 160 }}
          options={Object.entries(STATUS_CONFIG).map(([k, v]) => ({ value: k, label: v.label }))}
        />
        <Select
          allowClear
          placeholder="Filter by pipeline"
          value={filterPipeline}
          onChange={setFilterPipeline}
          style={{ width: 200 }}
          options={pipelines.map((p: any) => ({ value: p.id, label: p.name }))}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchJobs}>
          Refresh
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
          activeJob ? `Job #${activeJob.id} — ${pipelineMap.get(activeJob.pipelineId) || 'Unknown'}` : 'Job Details'
        }
        width={640}
        open={drawerVisible}
        onClose={() => setDrawerVisible(false)}
      >
        {activeJob && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Tag color={STATUS_CONFIG[activeJob.status]?.color}>{activeJob.status}</Tag>
                {activeJob.startedAt && <span>Started: {new Date(activeJob.startedAt).toLocaleString()}</span>}
                {activeJob.completedAt && <span>Completed: {new Date(activeJob.completedAt).toLocaleString()}</span>}
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
                <strong style={{ color: '#cf1322' }}>Error:</strong>
                <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', color: '#cf1322' }}>{activeJob.error}</pre>
              </div>
            )}

            <h4>Input</h4>
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

            <h4 style={{ marginTop: 16 }}>Step Results</h4>
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
              <div style={{ color: '#999' }}>No step results yet</div>
            )}

            <h4 style={{ marginTop: 16 }}>Final Result</h4>
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
              {activeJob.finalResult ? JSON.stringify(activeJob.finalResult, null, 2) : '(not yet available)'}
            </pre>

            {activeJob.externalTaskIds && Object.keys(activeJob.externalTaskIds).length > 0 && (
              <>
                <h4 style={{ marginTop: 16 }}>External Task IDs</h4>
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
