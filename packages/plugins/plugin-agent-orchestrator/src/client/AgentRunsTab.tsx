import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  message,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  BranchesOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  EyeOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { useAIEmployees } from './AIEmployeesContext';
import { parseJsonText } from './skill-hub/utils/jsonFields';

const { Paragraph, Text } = Typography;

type FilterState = {
  leader?: string;
  status?: string;
};

const terminalRunStatuses = new Set(['succeeded', 'failed', 'rejected', 'canceled']);

function statusColor(status?: string) {
  switch (status) {
    case 'succeeded':
    case 'success':
      return 'success';
    case 'failed':
    case 'error':
      return 'error';
    case 'waiting_user':
    case 'waiting_plan_approval':
    case 'needs_replan':
      return 'warning';
    case 'approved':
    case 'running':
    case 'planning':
      return 'processing';
    case 'rejected':
    case 'canceled':
    case 'skipped':
      return 'default';
    default:
      return 'default';
  }
}

function statusIcon(status?: string) {
  switch (status) {
    case 'succeeded':
    case 'success':
      return <CheckCircleOutlined />;
    case 'failed':
    case 'error':
      return <CloseCircleOutlined />;
    case 'waiting_user':
    case 'waiting_plan_approval':
    case 'needs_replan':
      return <PauseCircleOutlined />;
    case 'approved':
    case 'running':
    case 'planning':
      return <ClockCircleOutlined />;
    default:
      return undefined;
  }
}

function timelineColor(status?: string) {
  switch (status) {
    case 'succeeded':
    case 'success':
      return 'green';
    case 'failed':
    case 'error':
      return 'red';
    case 'waiting_user':
    case 'waiting_plan_approval':
    case 'needs_replan':
      return 'orange';
    case 'approved':
    case 'running':
    case 'planning':
      return 'blue';
    default:
      return 'gray';
  }
}

function StatusTag({ status }: { status?: string }) {
  return (
    <Tag icon={statusIcon(status)} color={statusColor(status)}>
      {status || '-'}
    </Tag>
  );
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : '-';
}

function formatDuration(start?: string, end?: string) {
  if (!start) return '-';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const diff = Math.max(0, endMs - startMs);
  if (diff >= 60000) return `${Math.round(diff / 60000)}m`;
  if (diff >= 1000) return `${(diff / 1000).toFixed(1)}s`;
  return `${diff}ms`;
}

function formatJson(value: any) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildSkillFileUrl(execution: any, file: any) {
  if (file?.downloadUrl) return file.downloadUrl;
  if (!execution?.id || !file?.name) return '';
  return `/api/skillHub:download?execId=${execution.id}&filename=${encodeURIComponent(file.name)}`;
}

function renderSkillFileLink(execution: any, file: any, index: number) {
  const url = buildSkillFileUrl(execution, file);
  const label = file.name || file.path || `file-${index + 1}`;
  return url ? (
    <a key={index} href={url} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    <Text key={index}>{label}</Text>
  );
}

function TextBlock({ value, rows = 10 }: { value: any; rows?: number }) {
  const text = formatJson(value);
  if (!text) return <Text type="secondary">-</Text>;
  return (
    <Paragraph
      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 12 }}
      ellipsis={{ rows, expandable: true }}
    >
      {text}
    </Paragraph>
  );
}

export const AgentRunsTab: React.FC = () => {
  const api = useApp().apiClient;
  const { employees, employeeMap } = useAIEmployees();
  const [filters, setFilters] = useState<FilterState>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedRun, setSelectedRun] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const requestParams = useMemo(() => {
    const filter: any = {};
    if (filters.leader) filter.leaderUsername = filters.leader;
    if (filters.status) filter.status = filters.status;
    return {
      sort: ['-createdAt'],
      page,
      pageSize,
      filter,
    };
  }, [filters, page, pageSize]);

  const { data, loading, refresh } = useRequest(
    () =>
      api.request({
        url: 'agentLoops:list',
        params: requestParams,
      }),
    {
      refreshDeps: [requestParams],
    },
  );

  const runs = useMemo(() => {
    const raw = (data as any)?.data ?? data;
    if (Array.isArray(raw)) return raw;
    return Array.isArray(raw?.data) ? raw.data : [];
  }, [data]);

  const total = useMemo(() => {
    const raw = (data as any)?.data ?? data;
    const count = raw?.meta?.count ?? (data as any)?.meta?.count;
    return typeof count === 'number' ? count : 0;
  }, [data]);

  const employeeOptions = useMemo(
    () =>
      employees.map((employee) => ({
        label: employee.nickname || employee.username,
        value: employee.username,
      })),
    [employees],
  );

  const fetchDetail = async (runId: string | number, seed?: any) => {
    setSelectedRun(seed || selectedRun || { id: runId });
    setDetailLoading(true);
    try {
      const res = await api.request({
        url: 'agentLoops:get',
        params: { filterByTk: runId },
      });
      setDetail((res as any)?.data?.data || (res as any)?.data || null);
    } finally {
      setDetailLoading(false);
    }
  };

  const updateFilter = (patch: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };

  const resetFilters = () => {
    setFilters({});
    setPage(1);
  };

  const runAction = async (action: 'cancel' | 'resume', runId: string | number) => {
    setActionLoading(true);
    try {
      await api.request({
        url: action === 'cancel' ? 'agentLoops:cancel' : 'agentLoops:resume',
        method: 'POST',
        data: action === 'cancel' ? { runId } : { runId, stepId: detail?.run?.currentStepId, approved: true },
      });
      message.success(action === 'cancel' ? 'Run canceled' : 'Run resumed');
      refresh();
      await fetchDetail(runId);
    } catch (error: any) {
      message.error(error?.message || `Failed to ${action} run`);
    } finally {
      setActionLoading(false);
    }
  };

  const retryStep = async (stepId: string | number) => {
    const runId = detail?.run?.id || selectedRun?.id;
    setActionLoading(true);
    try {
      await api.request({
        url: 'agentLoops:retryStep',
        method: 'POST',
        data: { stepId },
      });
      message.success('Step queued for retry');
      refresh();
      if (runId) await fetchDetail(runId);
    } catch (error: any) {
      message.error(error?.message || 'Failed to retry step');
    } finally {
      setActionLoading(false);
    }
  };

  const columns = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: formatDate,
    },
    {
      title: 'Leader',
      dataIndex: 'leaderUsername',
      key: 'leaderUsername',
      width: 160,
      render: (username: string) => <Tag color="blue">{employeeMap.get(username) || username || '-'}</Tag>,
    },
    {
      title: 'Goal',
      dataIndex: 'goal',
      key: 'goal',
      render: (goal: string) => (
        <Text ellipsis style={{ maxWidth: 380 }}>
          {goal || '-'}
        </Text>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (status: string) => <StatusTag status={status} />,
    },
    {
      title: 'Iterations',
      dataIndex: 'iterationCount',
      key: 'iterationCount',
      width: 90,
      render: (value: number) => value ?? 0,
    },
    {
      title: 'Duration',
      key: 'duration',
      width: 100,
      render: (_: any, record: any) => formatDuration(record.startedAt || record.createdAt, record.endedAt),
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: any, record: any) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => fetchDetail(record.id, record)}>
          Detail
        </Button>
      ),
    },
  ];

  const steps = Array.isArray(detail?.steps) ? detail.steps : [];
  const events = Array.isArray(detail?.events) ? detail.events : [];
  const spans = Array.isArray(detail?.spans) ? detail.spans : [];
  const skillExecutions = Array.isArray(detail?.skillExecutions) ? detail.skillExecutions : [];
  const run = detail?.run || selectedRun;
  const hasFilters = Boolean(filters.leader || filters.status);

  const stepColumns = [
    {
      title: '#',
      dataIndex: 'index',
      key: 'index',
      width: 56,
      render: (value: number) => Number(value ?? 0) + 1,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (status: string) => <StatusTag status={status} />,
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 110,
      render: (type: string) => <Tag>{type}</Tag>,
    },
    {
      title: 'Step',
      key: 'step',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text strong>{record.title || record.planKey}</Text>
          {record.description && <Text type="secondary">{record.description}</Text>}
          {record.target && <Text code>{record.target}</Text>}
        </Space>
      ),
    },
    {
      title: 'Depends',
      dataIndex: 'dependsOn',
      key: 'dependsOn',
      width: 130,
      render: (dependsOn: string[]) =>
        Array.isArray(dependsOn) && dependsOn.length ? dependsOn.map((key) => <Tag key={key}>{key}</Tag>) : '-',
    },
    {
      title: 'Attempts',
      key: 'attempts',
      width: 90,
      render: (_: any, record: any) => `${record.attempt || 0}/${record.maxAttempts || 0}`,
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: any, record: any) =>
        record.status === 'failed' && Number(record.attempt || 0) < Number(record.maxAttempts || 0) ? (
          <Button
            type="link"
            size="small"
            icon={<RedoOutlined />}
            loading={actionLoading}
            onClick={() => retryStep(record.id)}
          >
            Retry
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Agent Runs"
        description={
          <Text type="secondary">
            Persistent loop runs created by the orchestrator tools. Each run stores the goal, plan, step state,
            approvals, and linked Skill Hub or sub-agent traces.
          </Text>
        }
      />

      <Card bordered={false}>
        <Form layout="inline" style={{ marginBottom: 16, rowGap: 8, flexWrap: 'wrap' }}>
          <Form.Item label="Leader">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Any leader"
              style={{ minWidth: 180 }}
              options={employeeOptions}
              value={filters.leader}
              onChange={(value) => updateFilter({ leader: value })}
            />
          </Form.Item>
          <Form.Item label="Status">
            <Select
              allowClear
              placeholder="Any status"
              style={{ minWidth: 160 }}
              value={filters.status}
              onChange={(value) => updateFilter({ status: value })}
              options={[
                { label: 'Planning', value: 'planning' },
                { label: 'Waiting plan approval', value: 'waiting_plan_approval' },
                { label: 'Approved', value: 'approved' },
                { label: 'Running', value: 'running' },
                { label: 'Waiting user', value: 'waiting_user' },
                { label: 'Needs replan', value: 'needs_replan' },
                { label: 'Succeeded', value: 'succeeded' },
                { label: 'Failed', value: 'failed' },
                { label: 'Rejected', value: 'rejected' },
                { label: 'Canceled', value: 'canceled' },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button onClick={resetFilters} disabled={!hasFilters}>
                Reset
              </Button>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                Refresh
              </Button>
            </Space>
          </Form.Item>
        </Form>

        <Table
          rowKey="id"
          loading={loading}
          dataSource={runs}
          columns={columns}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (count) => `${count} run${count === 1 ? '' : 's'}`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
            },
          }}
          locale={{
            emptyText: <Empty description={hasFilters ? 'No runs match the current filters' : 'No agent runs yet'} />,
          }}
        />
      </Card>

      <Drawer
        title="Agent Run Detail"
        width={980}
        onClose={() => {
          setSelectedRun(null);
          setDetail(null);
        }}
        open={!!selectedRun}
      >
        {run && (
          <Spin spinning={detailLoading}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Space wrap>
                <Button icon={<ReloadOutlined />} onClick={() => fetchDetail(run.id)} loading={detailLoading}>
                  Refresh
                </Button>
                {run.status === 'waiting_user' && (
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    loading={actionLoading}
                    onClick={() => runAction('resume', run.id)}
                  >
                    Resume
                  </Button>
                )}
                {!terminalRunStatuses.has(run.status) && (
                  <Popconfirm title="Cancel this run?" onConfirm={() => runAction('cancel', run.id)}>
                    <Button danger icon={<StopOutlined />} loading={actionLoading}>
                      Cancel run
                    </Button>
                  </Popconfirm>
                )}
              </Space>

              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="Status">
                  <StatusTag status={run.status} />
                </Descriptions.Item>
                <Descriptions.Item label="Leader">
                  <Tag color="blue">{employeeMap.get(run.leaderUsername) || run.leaderUsername || '-'}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Root run">
                  <Text code>{run.rootRunId || '-'}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="Current step">
                  <Text code>{run.currentStepId || '-'}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="Iterations">{run.iterationCount || 0}</Descriptions.Item>
                <Descriptions.Item label="Approval">{run.approvalStatus || '-'}</Descriptions.Item>
                <Descriptions.Item label="Plan version">{run.planVersion || '-'}</Descriptions.Item>
                <Descriptions.Item label="Harness">{run.metadata?.harnessTag || '-'}</Descriptions.Item>
                <Descriptions.Item label="Duration">
                  {formatDuration(run.startedAt || run.createdAt, run.endedAt)}
                </Descriptions.Item>
                <Descriptions.Item label="Started">{formatDate(run.startedAt || run.createdAt)}</Descriptions.Item>
                <Descriptions.Item label="Ended">{formatDate(run.endedAt)}</Descriptions.Item>
              </Descriptions>

              <Card title="Goal" size="small">
                <TextBlock value={run.goal} rows={6} />
              </Card>

              <Card title="Plan" size="small" extra={<BranchesOutlined />}>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={steps}
                  columns={stepColumns}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  expandable={{
                    expandedRowRender: (record: any) => (
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <Card size="small" title="Input">
                          <TextBlock value={record.input} rows={8} />
                        </Card>
                        <Card size="small" title="Output">
                          <TextBlock value={record.output} rows={8} />
                        </Card>
                        {record.approval && Object.keys(record.approval).length > 0 && (
                          <Card size="small" title="Approval">
                            <TextBlock value={record.approval} rows={8} />
                          </Card>
                        )}
                        {record.error && (
                          <Card size="small" title="Error" style={{ borderColor: '#ffa39e' }}>
                            <TextBlock value={record.error} rows={8} />
                          </Card>
                        )}
                      </Space>
                    ),
                  }}
                  locale={{ emptyText: <Empty description="No plan steps" /> }}
                />
              </Card>

              <Card title="Event Timeline" size="small">
                {events.length ? (
                  <Timeline
                    items={events.map((event: any) => ({
                      key: event.id,
                      color: timelineColor(event.status),
                      children: (
                        <Space direction="vertical" size={2} style={{ width: '100%' }}>
                          <Space wrap>
                            <Text strong>{event.title || event.type}</Text>
                            <StatusTag status={event.status} />
                            {event.stepId && <Text type="secondary">step #{event.stepId}</Text>}
                          </Space>
                          <Text type="secondary">{formatDate(event.createdAt)}</Text>
                          {event.content && <TextBlock value={event.content} rows={4} />}
                        </Space>
                      ),
                    }))}
                  />
                ) : (
                  <Empty description="No events captured" />
                )}
              </Card>

              <Collapse
                items={[
                  {
                    key: 'spans',
                    label: `Linked spans (${spans.length})`,
                    children: spans.length ? (
                      <Table
                        rowKey="id"
                        size="small"
                        dataSource={spans}
                        pagination={false}
                        scroll={{ x: 'max-content' }}
                        columns={[
                          {
                            title: 'Type',
                            dataIndex: 'type',
                            key: 'type',
                            width: 110,
                            render: (value: string) => <Tag>{value}</Tag>,
                          },
                          {
                            title: 'Status',
                            dataIndex: 'status',
                            key: 'status',
                            width: 110,
                            render: (value: string) => <StatusTag status={value} />,
                          },
                          { title: 'Title', dataIndex: 'title', key: 'title' },
                          {
                            title: 'Tool',
                            dataIndex: 'toolName',
                            key: 'toolName',
                            render: (value: string) => (value ? <Text code>{value}</Text> : '-'),
                          },
                          {
                            title: 'Duration',
                            dataIndex: 'durationMs',
                            key: 'durationMs',
                            width: 100,
                            render: (value: number) => (value ? `${value}ms` : '-'),
                          },
                          {
                            title: 'Skill Exec',
                            dataIndex: 'skillExecutionId',
                            key: 'skillExecutionId',
                            width: 110,
                            render: (value: any) => value || '-',
                          },
                        ]}
                      />
                    ) : (
                      <Empty description="No linked spans" />
                    ),
                  },
                  {
                    key: 'skills',
                    label: `Skill executions (${skillExecutions.length})`,
                    children: skillExecutions.length ? (
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        {skillExecutions.map((execution: any) => {
                          const files = parseJsonText<any[]>(execution.outputFiles, []);
                          return (
                            <Card
                              key={execution.id}
                              size="small"
                              title={
                                <Space wrap>
                                  <Text>Skill execution #{execution.id}</Text>
                                  <StatusTag status={execution.status} />
                                  {execution.agentLoopStepId && (
                                    <Text type="secondary">step #{execution.agentLoopStepId}</Text>
                                  )}
                                </Space>
                              }
                            >
                              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                <Descriptions size="small" column={2}>
                                  <Descriptions.Item label="Duration">
                                    {execution.durationMs ? `${execution.durationMs}ms` : '-'}
                                  </Descriptions.Item>
                                  <Descriptions.Item label="Created">
                                    {formatDate(execution.createdAt)}
                                  </Descriptions.Item>
                                </Descriptions>
                                <Collapse
                                  size="small"
                                  items={[
                                    {
                                      key: 'stdout',
                                      label: 'stdout',
                                      children: <TextBlock value={execution.stdout} rows={10} />,
                                    },
                                    {
                                      key: 'stderr',
                                      label: 'stderr',
                                      children: <TextBlock value={execution.stderr} rows={10} />,
                                    },
                                    {
                                      key: 'files',
                                      label: `files (${files.length})`,
                                      children: files.length ? (
                                        <Space direction="vertical">
                                          {files.map((file: any, index: number) =>
                                            renderSkillFileLink(execution, file, index),
                                          )}
                                        </Space>
                                      ) : (
                                        <Empty description="No files" />
                                      ),
                                    },
                                  ]}
                                />
                              </Space>
                            </Card>
                          );
                        })}
                      </Space>
                    ) : (
                      <Empty description="No linked skill executions" />
                    ),
                  },
                ]}
              />

              {(run.finalAnswer || run.summary) && (
                <Card title="Final Output" size="small">
                  {run.summary && (
                    <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
                      <Text strong>Summary: </Text>
                      {run.summary}
                    </Paragraph>
                  )}
                  <TextBlock value={run.finalAnswer} rows={16} />
                </Card>
              )}
            </Space>
          </Spin>
        )}
      </Drawer>
    </div>
  );
};
