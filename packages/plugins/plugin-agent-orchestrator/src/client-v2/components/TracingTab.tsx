import React, { useMemo, useRef, useState } from 'react';
import type { Dayjs } from 'dayjs';
import {
  Table,
  Card,
  Tag,
  Typography,
  Drawer,
  Descriptions,
  Alert,
  Button,
  Empty,
  Space,
  Timeline,
  Collapse,
  Spin,
  Select,
  DatePicker,
  Form,
  message,
} from 'antd';
import {
  EyeOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useApiClient as useAPIClient, useRequest } from '../hooks/useApiRequest';
import { useAIEmployees } from './AIEmployeesContext';
import { useT } from '../skill-hub/locale';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

type TraceItem = {
  type?: string;
  at?: string;
  title?: string;
  toolName?: string;
  status?: string;
  content?: string;
  args?: unknown;
  skillExecutionId?: number;
};

type TraceMessage = {
  index: number;
  type?: string;
  content?: string;
  toolCalls?: unknown[];
};

type TracingLog = {
  id: number | string;
  createdAt?: string;
  leaderUsername?: string;
  subAgentUsername?: string;
  toolName?: string;
  task?: string;
  context?: string;
  status?: string;
  durationMs?: number;
  depth?: number;
  result?: string;
  error?: string;
  hasUnifiedTrace?: boolean;
  trace?: TraceItem[];
  messages?: TraceMessage[];
};

type FilterState = {
  leader?: string;
  subAgent?: string;
  status?: string;
  range?: [Dayjs | null, Dayjs | null] | null;
};

function statusIcon(status?: string) {
  if (status === 'success') return <CheckCircleOutlined />;
  if (status === 'error') return <CloseCircleOutlined />;
  if (status === 'running') return <SyncOutlined spin />;
  return <ClockCircleOutlined />;
}

function statusColor(status?: string) {
  if (status === 'success') return 'success';
  if (status === 'error') return 'error';
  if (status === 'running') return 'processing';
  return 'default';
}

export const TracingTab: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [selectedLog, setSelectedLog] = useState<TracingLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Guards the detail drawer against out-of-order responses when the user
  // switches rows quickly: only the newest request may commit its result.
  const detailRequestId = useRef(0);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState<FilterState>({});

  const { employees, employeeMap } = useAIEmployees();

  const requestParams = useMemo(() => {
    const filter: Record<string, unknown> = {};
    if (filters.leader) filter.leaderUsername = filters.leader;
    if (filters.subAgent) filter.subAgentUsername = filters.subAgent;
    if (filters.status) filter.status = filters.status;
    if (filters.range && (filters.range[0] || filters.range[1])) {
      const createdAt: Record<string, string> = {};
      if (filters.range[0]) createdAt.$gte = filters.range[0].toDate().toISOString();
      if (filters.range[1]) createdAt.$lte = filters.range[1].toDate().toISOString();
      filter.createdAt = createdAt;
    }
    return {
      sort: ['-createdAt'],
      page,
      pageSize,
      filter,
    };
  }, [page, pageSize, filters]);

  const { data, loading, refresh } = useRequest<{ data?: TracingLog[]; meta?: { count?: number } }>(
    {
      url: 'orchestratorTracing:list',
      params: requestParams,
    },
    {
      refreshDeps: [requestParams],
    },
  );

  // Server returns { data: rows, meta: { count } }; useRequest unwraps to that shape.
  const logs = useMemo(() => {
    const rows = data?.data;
    return Array.isArray(rows) ? rows : [];
  }, [data]);

  const total = useMemo(() => {
    const count = data?.meta?.count;
    return typeof count === 'number' ? count : 0;
  }, [data]);

  const formatDuration = (ms?: number) => {
    if (!ms) return '-';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  };

  const handleOpenLog = async (record: TracingLog) => {
    const requestId = ++detailRequestId.current;
    setSelectedLog(record);
    setDetailLoading(true);
    try {
      const res = await api.request({
        url: 'orchestratorTracing:get',
        params: { filterByTk: record.id, source: record.hasUnifiedTrace ? 'span' : 'log' },
      });
      if (requestId !== detailRequestId.current) return;
      const payload = res as { data?: { data?: { data?: TracingLog } | TracingLog } };
      const detail =
        (payload?.data?.data as { data?: TracingLog })?.data || (payload?.data?.data as TracingLog) || record;
      setSelectedLog(detail);
    } catch (error) {
      if (requestId !== detailRequestId.current) return;
      const text =
        (error as { response?: { data?: { errors?: Array<{ message?: string }> } }; message?: string })?.response?.data
          ?.errors?.[0]?.message ||
        (error as { message?: string })?.message ||
        t('Failed to load execution detail');
      message.error(text);
    } finally {
      if (requestId === detailRequestId.current) {
        setDetailLoading(false);
      }
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

  const employeeOptions = useMemo(
    () =>
      employees.map((e) => ({
        label: e.nickname || e.username,
        value: e.username,
      })),
    [employees],
  );

  const hasFilters = Boolean(
    filters.leader || filters.subAgent || filters.status || (filters.range && (filters.range[0] || filters.range[1])),
  );

  const columns = [
    {
      title: t('Time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (v: string) => (v ? new Date(v).toLocaleString() : '-'),
    },
    {
      title: t('Leader'),
      dataIndex: 'leaderUsername',
      key: 'leaderUsername',
      render: (username: string) => <Tag color="blue">{employeeMap.get(username) || username}</Tag>,
    },
    {
      title: t('Sub-Agent'),
      dataIndex: 'subAgentUsername',
      key: 'subAgentUsername',
      render: (username: string) => <Tag color="green">{employeeMap.get(username) || username}</Tag>,
    },
    {
      title: t('Task'),
      dataIndex: 'task',
      key: 'task',
      render: (task: string) => (
        <Text ellipsis style={{ maxWidth: 280 }}>
          {task?.substring(0, 100) || '-'}
        </Text>
      ),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: string) => (
        <Tag icon={statusIcon(status)} color={statusColor(status)}>
          {status ? t(status) : '-'}
        </Tag>
      ),
    },
    {
      title: t('Duration'),
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 90,
      render: formatDuration,
    },
    {
      title: t('Depth'),
      dataIndex: 'depth',
      key: 'depth',
      width: 60,
      render: (v: number) => v ?? 0,
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: TracingLog) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleOpenLog(record)}>
          {t('Detail')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('Execution Tracing')}
        description={
          <Text type="secondary">
            {t(
              'View orchestration execution logs. Each row represents one sub-agent invocation, with child tool and Skill Hub executions shown in the detail flow.',
            )}
          </Text>
        }
      />

      <Card bordered={false}>
        <Form layout="inline" style={{ marginBottom: 16, rowGap: 8, flexWrap: 'wrap' }}>
          <Form.Item label={t('Leader')}>
            <Select
              allowClear
              placeholder={t('Any leader')}
              style={{ minWidth: 180 }}
              options={employeeOptions}
              value={filters.leader}
              onChange={(v) => updateFilter({ leader: v })}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item label={t('Sub-Agent')}>
            <Select
              allowClear
              placeholder={t('Any sub-agent')}
              style={{ minWidth: 180 }}
              options={employeeOptions}
              value={filters.subAgent}
              onChange={(v) => updateFilter({ subAgent: v })}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item label={t('Status')}>
            <Select
              allowClear
              placeholder={t('Any status')}
              style={{ minWidth: 140 }}
              options={[
                { label: t('Success'), value: 'success' },
                { label: t('Error'), value: 'error' },
                { label: t('Running'), value: 'running' },
              ]}
              value={filters.status}
              onChange={(v) => updateFilter({ status: v })}
            />
          </Form.Item>
          <Form.Item label={t('Time')}>
            <RangePicker
              showTime
              value={filters.range}
              onChange={(v) => updateFilter({ range: v as [Dayjs | null, Dayjs | null] | null })}
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button onClick={resetFilters} disabled={!hasFilters}>
                {t('Reset')}
              </Button>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                {t('Refresh')}
              </Button>
            </Space>
          </Form.Item>
        </Form>

        <Table
          rowKey="id"
          loading={loading}
          dataSource={logs}
          columns={columns}
          size="middle"
          scroll={{ x: 'max-content' }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (count) => t('{{count}} executions', { count }),
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
            },
          }}
          locale={{
            emptyText: (
              <Empty
                description={
                  hasFilters ? t('No executions match the current filters') : t('No delegation executions yet')
                }
              />
            ),
          }}
        />
      </Card>

      <Drawer title={t('Execution Detail')} width={820} onClose={() => setSelectedLog(null)} open={!!selectedLog}>
        {selectedLog && (
          <Spin spinning={detailLoading}>
            <>
              <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }}>
                <Descriptions.Item label={t('Status')}>
                  <Tag icon={statusIcon(selectedLog.status)} color={statusColor(selectedLog.status)}>
                    {selectedLog.status ? t(selectedLog.status) : '-'}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label={t('Leader')}>
                  <Tag color="blue">{employeeMap.get(selectedLog.leaderUsername) || selectedLog.leaderUsername}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label={t('Sub-Agent')}>
                  <Tag color="green">
                    {employeeMap.get(selectedLog.subAgentUsername) || selectedLog.subAgentUsername}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label={t('Tool')}>
                  <Text code>{selectedLog.toolName}</Text>
                </Descriptions.Item>
                <Descriptions.Item label={t('Depth')}>{selectedLog.depth ?? 0}</Descriptions.Item>
                <Descriptions.Item label={t('Duration')}>{formatDuration(selectedLog.durationMs)}</Descriptions.Item>
                <Descriptions.Item label={t('Time')}>
                  {selectedLog.createdAt ? new Date(selectedLog.createdAt).toLocaleString() : '-'}
                </Descriptions.Item>
              </Descriptions>

              <Card title={t('Task')} size="small" style={{ marginBottom: 16 }}>
                <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}>
                  {selectedLog.task || t('No task description')}
                </Paragraph>
              </Card>

              {selectedLog.context && (
                <Card title={t('Context')} size="small" style={{ marginBottom: 16 }}>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}>
                    {selectedLog.context}
                  </Paragraph>
                </Card>
              )}

              <Card title={t('Execution Flow')} size="small" style={{ marginBottom: 16 }}>
                {Array.isArray(selectedLog.trace) && selectedLog.trace.length ? (
                  <Timeline
                    items={selectedLog.trace.map((item, index) => ({
                      key: item.skillExecutionId ?? `${item.type ?? 'step'}-${item.at ?? index}`,
                      color: item.status === 'error' ? 'red' : item.type === 'tool_call' ? 'blue' : 'green',
                      children: (
                        <div>
                          <Space direction="vertical" size={2} style={{ width: '100%' }}>
                            <Text strong>{item.title || item.type}</Text>
                            <Text type="secondary">{item.at ? new Date(item.at).toLocaleString() : ''}</Text>
                            {item.toolName && <Text code>{item.toolName}</Text>}
                            {item.skillExecutionId && (
                              <Text type="secondary">
                                {t('Skill execution #{{id}}', { id: item.skillExecutionId })}
                              </Text>
                            )}
                            {item.content && (
                              <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}>
                                {item.content}
                              </Paragraph>
                            )}
                            {item.args && (
                              <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>
                                {JSON.stringify(item.args, null, 2)}
                              </Paragraph>
                            )}
                          </Space>
                        </div>
                      ),
                    }))}
                  />
                ) : (
                  <Empty description={t('No execution flow captured')} />
                )}
              </Card>

              {Array.isArray(selectedLog.messages) && selectedLog.messages.length > 0 && (
                <Collapse
                  style={{ marginBottom: 16 }}
                  items={[
                    {
                      key: 'messages',
                      label: t('Raw messages ({{count}})', { count: selectedLog.messages.length }),
                      children: (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          {selectedLog.messages.map((msg) => (
                            <Card key={msg.index} size="small" title={`${msg.index + 1}. ${msg.type}`}>
                              <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>
                                {msg.content || JSON.stringify(msg.toolCalls || msg, null, 2)}
                              </Paragraph>
                              {(msg.toolCalls?.length ?? 0) > 0 && (
                                <Paragraph style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: 12 }}>
                                  {JSON.stringify(msg.toolCalls, null, 2)}
                                </Paragraph>
                              )}
                            </Card>
                          ))}
                        </Space>
                      ),
                    },
                  ]}
                />
              )}

              <Card
                title={t('Result')}
                size="small"
                style={{
                  marginBottom: 16,
                  borderColor: selectedLog.status === 'success' ? '#b7eb8f' : '#ffa39e',
                }}
              >
                <Paragraph
                  style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}
                  ellipsis={{ rows: 20, expandable: true }}
                >
                  {selectedLog.result || selectedLog.error || t('No result')}
                </Paragraph>
              </Card>

              {selectedLog.error && (
                <Card title={t('Error')} size="small" style={{ borderColor: '#ffa39e' }}>
                  <Paragraph type="danger" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}>
                    {selectedLog.error}
                  </Paragraph>
                </Card>
              )}
            </>
          </Spin>
        )}
      </Drawer>
    </div>
  );
};
