import React, { useState, useMemo } from 'react';
import { Table, Select, Button, Badge, Drawer, Space, message, Popconfirm, Card, Tag, Timeline, Collapse, Empty } from 'antd';
import {
  ReloadOutlined,
  EyeOutlined,
  RedoOutlined,
  StopOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  PlayCircleOutlined,
  FileTextOutlined,
  NodeIndexOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';
import { Input } from 'antd';

const statusColors: Record<string, string> = {
  success: 'green',
  error: 'red',
  running: 'blue',
  waiting: 'gold',
  new: 'cyan',
};

const statusIcons: Record<string, React.ReactNode> = {
  success: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
  error: <CloseCircleOutlined style={{ color: '#ff4d4f' }} />,
  running: <PlayCircleOutlined style={{ color: '#1890ff' }} />,
  waiting: <ClockCircleOutlined style={{ color: '#faad14' }} />,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// Execution Detail component with node timeline
const ExecutionDetail: React.FC<{ detail: any }> = ({ detail }) => {
  const t = useT();
  const [view, setView] = useState<'timeline' | 'json'>('timeline');

  if (!detail) return null;

  const data = detail.data || detail;
  const runData = data?.resultData?.runData || data?.data?.resultData?.runData;
  const globalError = data?.resultData?.error || data?.data?.resultData?.error;

  // Parse node executions from runData
  const nodeExecutions = useMemo(() => {
    if (!runData) return [];
    const nodes: Array<{
      name: string;
      status: 'success' | 'error';
      startTime: number;
      executionTime: number;
      error?: string;
      itemCount: number;
      outputData?: any;
    }> = [];

    for (const [nodeName, runs] of Object.entries(runData as Record<string, any[]>)) {
      if (!Array.isArray(runs)) continue;
      for (const run of runs) {
        const items = run.data?.main?.flatMap((m: any[]) => m || []) || [];
        nodes.push({
          name: nodeName,
          status: run.error ? 'error' : 'success',
          startTime: run.startTime || 0,
          executionTime: run.executionTime || 0,
          error: run.error?.message,
          itemCount: items.length,
          outputData: run.data,
        });
      }
    }

    return nodes.sort((a, b) => a.startTime - b.startTime);
  }, [runData]);

  const executionStatus = detail.status || 'unknown';
  const workflowName = detail.workflowData?.name || detail.workflowName || `#${detail.workflowId || ''}`;
  const startedAt = detail.startedAt ? new Date(detail.startedAt).toLocaleString() : '-';
  const stoppedAt = detail.stoppedAt ? new Date(detail.stoppedAt).toLocaleString() : '-';
  const duration = detail.startedAt && detail.stoppedAt
    ? formatDuration(new Date(detail.stoppedAt).getTime() - new Date(detail.startedAt).getTime())
    : '-';

  return (
    <div>
      {/* Header Info */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
          <div>
            {statusIcons[executionStatus] || statusIcons.waiting}
            <Tag color={statusColors[executionStatus]} style={{ marginLeft: 8, textTransform: 'capitalize' }}>
              {executionStatus}
            </Tag>
          </div>
          <div>
            <span style={{ color: '#999', fontSize: 12 }}>{t('Workflow')}</span>
            <div style={{ fontWeight: 600 }}>{workflowName}</div>
          </div>
          <div>
            <span style={{ color: '#999', fontSize: 12 }}>{t('Started')}</span>
            <div>{startedAt}</div>
          </div>
          <div>
            <span style={{ color: '#999', fontSize: 12 }}>{t('Duration')}</span>
            <div style={{ fontWeight: 600 }}>{duration}</div>
          </div>
          {detail.mode && (
            <div>
              <span style={{ color: '#999', fontSize: 12 }}>{t('Mode')}</span>
              <div>{detail.mode}</div>
            </div>
          )}
        </div>
      </Card>

      {/* Global Error */}
      {globalError && (
        <Card
          size="small"
          style={{ marginBottom: 16, borderColor: '#ffccc7', backgroundColor: '#fff2f0' }}
        >
          <div style={{ color: '#cf1322', fontWeight: 600, marginBottom: 4 }}>
            <CloseCircleOutlined /> {t('Error')}
          </div>
          <div style={{ color: '#cf1322', fontSize: 13 }}>
            {globalError.message || JSON.stringify(globalError)}
          </div>
        </Card>
      )}

      {/* View Toggle */}
      <Space style={{ marginBottom: 12 }}>
        <Button
          type={view === 'timeline' ? 'primary' : 'default'}
          size="small"
          icon={<NodeIndexOutlined />}
          onClick={() => setView('timeline')}
        >
          {t('Node Timeline')}
        </Button>
        <Button
          type={view === 'json' ? 'primary' : 'default'}
          size="small"
          icon={<FileTextOutlined />}
          onClick={() => setView('json')}
        >
          JSON
        </Button>
      </Space>

      {/* Timeline View */}
      {view === 'timeline' && (
        nodeExecutions.length > 0 ? (
          <Timeline
            items={nodeExecutions.map((node, idx) => ({
              color: node.status === 'error' ? 'red' : 'green',
              dot: node.status === 'error'
                ? <CloseCircleOutlined style={{ fontSize: 14 }} />
                : <CheckCircleOutlined style={{ fontSize: 14 }} />,
              children: (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{node.name}</span>
                    <span style={{ fontSize: 11, color: '#999' }}>
                      {node.executionTime}ms
                      {node.itemCount > 0 && ` · ${node.itemCount} items`}
                    </span>
                  </div>
                  {node.error && (
                    <div style={{
                      marginTop: 4,
                      padding: '4px 8px',
                      background: '#fff2f0',
                      border: '1px solid #ffccc7',
                      borderRadius: 4,
                      color: '#cf1322',
                      fontSize: 12,
                    }}>
                      {node.error}
                    </div>
                  )}
                  {node.outputData && (
                    <Collapse
                      size="small"
                      ghost
                      items={[{
                        key: 'output',
                        label: <span style={{ fontSize: 11, color: '#1890ff' }}>{t('Output Data')}</span>,
                        children: (
                          <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', margin: 0, background: '#fafafa', padding: 8, borderRadius: 4 }}>
                            {JSON.stringify(node.outputData, null, 2)}
                          </pre>
                        ),
                      }]}
                    />
                  )}
                </div>
              ),
            }))}
          />
        ) : (
          <Empty description={t('No node execution data available')} />
        )
      )}

      {/* JSON View */}
      {view === 'json' && (
        <pre style={{ fontSize: 12, overflow: 'auto', maxHeight: 'calc(100vh - 300px)', margin: 0 }}>
          {JSON.stringify(detail, null, 2)}
        </pre>
      )}
    </div>
  );
};

export const ExecutionList: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { instanceId } = useCurrentInstance();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [workflowFilter, setWorkflowFilter] = useState<string | undefined>();
  const [searchText, setSearchText] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);

  const filter: any = {};
  if (statusFilter) filter.status = statusFilter;
  if (workflowFilter) filter.workflowId = workflowFilter;

  const { data, loading, refresh } = useN8nRequest('n8nExecutions', 'list', { filter });
  const { data: workflowsData } = useN8nRequest('n8nWorkflows', 'list');

  const executions = data?.data || data || [];
  const workflows = workflowsData?.data || workflowsData || [];

  const filteredExecutions = React.useMemo(() => {
    let res = executions;
    if (searchText) {
      const q = searchText.toLowerCase();
      res = res.filter((e: any) => String(e.id).includes(q) || e.workflowData?.name?.toLowerCase().includes(q) || String(e.workflowId).includes(q));
    }
    return res;
  }, [executions, searchText]);

  const handleRetry = async (id: string) => {
    try {
      await api.request({ url: 'n8nExecutions:retry', params: { instanceId, filterByTk: id } });
      message.success(t('Retry initiated'));
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const handleStop = async (id: string) => {
    try {
      await api.request({ url: 'n8nExecutions:stop', params: { instanceId, filterByTk: id } });
      message.success(t('Execution stopped'));
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const handleViewDetail = async (id: string) => {
    try {
      const res = await api.request({ url: 'n8nExecutions:get', params: { instanceId, filterByTk: id } });
      setDetail(res?.data);
      setDetailOpen(true);
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 100 },
    {
      title: t('Workflow'),
      dataIndex: 'workflowId',
      key: 'workflowId',
      render: (wfId: string, record: any) => record.workflowData?.name || `#${wfId}`,
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <span>
          {statusIcons[status]} <Badge color={statusColors[status] || 'default'} text={status} />
        </span>
      ),
    },
    {
      title: t('Started'),
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
    {
      title: t('Duration'),
      key: 'duration',
      width: 100,
      render: (_: any, record: any) => {
        if (!record.startedAt || !record.stoppedAt) return '-';
        const ms = new Date(record.stoppedAt).getTime() - new Date(record.startedAt).getTime();
        return formatDuration(ms);
      },
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 150,
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(record.id)} />
          {record.status === 'error' && (
            <Popconfirm title={t('Retry this execution?')} onConfirm={() => handleRetry(record.id)}>
              <Button type="link" size="small" icon={<RedoOutlined />} />
            </Popconfirm>
          )}
          {(record.status === 'running' || record.status === 'waiting') && (
            <Popconfirm title={t('Stop this execution?')} onConfirm={() => handleStop(record.id)}>
              <Button type="link" size="small" danger icon={<StopOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder={t('Status')}
          allowClear
          onChange={setStatusFilter}
          style={{ width: 150 }}
          options={[
            { label: t('Success'), value: 'success' },
            { label: t('Error'), value: 'error' },
            { label: t('Running'), value: 'running' },
            { label: t('Waiting'), value: 'waiting' },
          ]}
        />
        <Select
          placeholder={t('Workflow')}
          allowClear
          showSearch
          optionFilterProp="label"
          onChange={setWorkflowFilter}
          style={{ width: 250 }}
          options={workflows.map((w: any) => ({ label: w.name, value: String(w.id) }))}
        />
        <Input.Search
          placeholder={t('Search ID or Workflow...')}
          allowClear
          onSearch={setSearchText}
          onChange={(e) => { if (!e.target.value) setSearchText(''); }}
          style={{ width: 220 }}
          prefix={<SearchOutlined />}
        />
        <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table columns={columns} dataSource={filteredExecutions} rowKey="id" loading={loading} pagination={{ pageSize: 20 }} size="small" />
      <Drawer
        title={`${t('Execution')} #${detail?.id || ''}`}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={720}
      >
        <ExecutionDetail detail={detail} />
      </Drawer>
    </div>
  );
};
