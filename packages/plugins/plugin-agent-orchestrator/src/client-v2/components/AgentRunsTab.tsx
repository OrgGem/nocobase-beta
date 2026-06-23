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
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, EyeOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { useApiClient as useAPIClient, useRequest } from '../hooks/useApiRequest';
import { useAIEmployees } from './AIEmployeesContext';
import { useT } from '../skill-hub/locale';

const { Paragraph, Text } = Typography;

type FilterState = {
  leader?: string;
  subAgent?: string;
  status?: string;
};

function statusColor(status?: string) {
  switch (status) {
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    case 'running':
      return 'processing';
    default:
      return 'default';
  }
}

function statusIcon(status?: string) {
  if (status === 'success') return <CheckCircleOutlined />;
  if (status === 'error') return <CloseCircleOutlined />;
  return undefined;
}

function StatusTag({ status }: { status?: string }) {
  return (
    <Tag color={statusColor(status)} icon={statusIcon(status)}>
      {status || '-'}
    </Tag>
  );
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : '-';
}

function formatDurationMs(value?: number) {
  if (!value) return '-';
  if (value >= 60000) return `${Math.round(value / 60000)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

function formatJson(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function TextBlock({ value, rows = 8 }: { value: unknown; rows?: number }) {
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
  const api = useAPIClient();
  const t = useT();
  const { employees, employeeMap } = useAIEmployees();
  const [filters, setFilters] = useState<FilterState>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedRun, setSelectedRun] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);

  const requestParams = useMemo(() => {
    const filter: Record<string, string> = {};
    if (filters.leader) filter.leaderUsername = filters.leader;
    if (filters.subAgent) filter.subAgentUsername = filters.subAgent;
    if (filters.status) filter.status = filters.status;
    return {
      sort: ['-createdAt'],
      page,
      pageSize,
      filter,
    };
  }, [filters, page, pageSize]);

  const { data, loading, refresh } = useRequest(
    {
      url: 'agentMonitor:list',
      params: requestParams,
    },
    {
      refreshDeps: [requestParams],
    },
  );

  const runs = useMemo(() => {
    const rows = (data as any)?.data;
    return Array.isArray(rows) ? rows : [];
  }, [data]);

  const total = useMemo(() => {
    const count = (data as any)?.meta?.count;
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

  const updateFilter = (patch: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };

  const resetFilters = () => {
    setFilters({});
    setPage(1);
  };

  const fetchDetail = async (record: any) => {
    setSelectedRun(record);
    setDetailLoading(true);
    try {
      const res = await api.request({
        url: 'agentMonitor:get',
        params: { filterByTk: record.id },
      });
      setSelectedRun((res as any)?.data?.data?.data || (res as any)?.data?.data || record);
    } finally {
      setDetailLoading(false);
    }
  };

  const syncNativeRuns = async () => {
    setSyncLoading(true);
    try {
      const res = await api.request({
        url: 'agentMonitor:sync',
        method: 'post',
        data: { limit: 500 },
      });
      const result = (res as any)?.data?.data || {};
      message.success(t('Synced {{count}} native runs', { count: result.created || 0 }));
      refresh();
    } catch (error: any) {
      const text = error?.response?.data?.errors?.[0]?.message || error?.message || t('Sync failed');
      message.error(text);
    } finally {
      setSyncLoading(false);
    }
  };

  const hasFilters = Boolean(filters.leader || filters.subAgent || filters.status);
  const trace = Array.isArray(selectedRun?.trace) ? selectedRun.trace : [];
  const toolMessages = Array.isArray(selectedRun?.toolMessages) ? selectedRun.toolMessages : [];
  const nativeMessages = Array.isArray(selectedRun?.nativeMessages) ? selectedRun.nativeMessages : [];

  const columns = [
    {
      title: t('Time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: formatDate,
    },
    {
      title: t('Leader'),
      dataIndex: 'leaderUsername',
      key: 'leaderUsername',
      width: 160,
      render: (username: string) => <Tag color="blue">{employeeMap.get(username) || username || '-'}</Tag>,
    },
    {
      title: t('Sub-Agent'),
      dataIndex: 'subAgentUsername',
      key: 'subAgentUsername',
      width: 160,
      render: (username: string) => <Tag color="green">{employeeMap.get(username) || username || '-'}</Tag>,
    },
    {
      title: t('Task'),
      dataIndex: 'task',
      key: 'task',
      render: (task: string) => (
        <Text ellipsis style={{ maxWidth: 360 }}>
          {task || '-'}
        </Text>
      ),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (status: string) => <StatusTag status={status} />,
    },
    {
      title: t('Duration'),
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 100,
      render: formatDurationMs,
    },
    {
      title: t('Context'),
      dataIndex: 'memoryContextApplied',
      key: 'memoryContextApplied',
      width: 100,
      render: (applied: boolean) => (applied ? <Tag color="purple">memory</Tag> : <Text type="secondary">-</Text>),
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: unknown, record: any) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => fetchDetail(record)}>
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
        message={t('Native Agent Runs')}
        description={
          <Text type="secondary">
            {t(
              'Native plugin-ai sub-agent dispatches captured by the orchestrator observer. Execution still runs through AIEmployee/SubAgentsDispatcher.',
            )}
          </Text>
        }
      />

      <Card bordered={false}>
        <Form layout="inline" style={{ marginBottom: 16, rowGap: 8, flexWrap: 'wrap' }}>
          <Form.Item label={t('Leader')}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('Any leader')}
              style={{ minWidth: 180 }}
              options={employeeOptions}
              value={filters.leader}
              onChange={(value) => updateFilter({ leader: value })}
            />
          </Form.Item>
          <Form.Item label={t('Sub-Agent')}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('Any sub-agent')}
              style={{ minWidth: 180 }}
              options={employeeOptions}
              value={filters.subAgent}
              onChange={(value) => updateFilter({ subAgent: value })}
            />
          </Form.Item>
          <Form.Item label={t('Status')}>
            <Select
              allowClear
              placeholder={t('Any status')}
              style={{ minWidth: 140 }}
              value={filters.status}
              onChange={(value) => updateFilter({ status: value })}
              options={[
                { label: t('Running'), value: 'running' },
                { label: t('Success'), value: 'success' },
                { label: t('Error'), value: 'error' },
              ]}
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
              <Button icon={<SyncOutlined />} onClick={syncNativeRuns} loading={syncLoading}>
                {t('Sync')}
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
            showTotal: (count) => t('{{count}} runs', { count }),
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
            },
          }}
          locale={{
            emptyText: (
              <Empty description={hasFilters ? t('No runs match the current filters') : t('No native runs yet')} />
            ),
          }}
        />
      </Card>

      <Drawer title={t('Native Run Detail')} width={960} onClose={() => setSelectedRun(null)} open={!!selectedRun}>
        {selectedRun && (
          <Spin spinning={detailLoading}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label={t('Status')}>
                  <StatusTag status={selectedRun.status} />
                </Descriptions.Item>
                <Descriptions.Item label={t('Harness')}>{selectedRun.harnessTag || 'default'}</Descriptions.Item>
                <Descriptions.Item label={t('Leader')}>
                  <Tag color="blue">
                    {employeeMap.get(selectedRun.leaderUsername) || selectedRun.leaderUsername || '-'}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label={t('Sub-Agent')}>
                  <Tag color="green">
                    {employeeMap.get(selectedRun.subAgentUsername) || selectedRun.subAgentUsername || '-'}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label={t('Parent session')}>
                  <Text code>{selectedRun.parentSessionId || '-'}</Text>
                </Descriptions.Item>
                <Descriptions.Item label={t('Sub session')}>
                  <Text code>{selectedRun.subSessionId || '-'}</Text>
                </Descriptions.Item>
                <Descriptions.Item label={t('Tool call')}>
                  <Text code>{selectedRun.toolCallId || '-'}</Text>
                </Descriptions.Item>
                <Descriptions.Item label={t('Duration')}>{formatDurationMs(selectedRun.durationMs)}</Descriptions.Item>
                <Descriptions.Item label={t('Started')}>
                  {formatDate(selectedRun.startedAt || selectedRun.createdAt)}
                </Descriptions.Item>
                <Descriptions.Item label={t('Ended')}>{formatDate(selectedRun.endedAt)}</Descriptions.Item>
              </Descriptions>

              <Card title={t('Task')} size="small">
                <TextBlock value={selectedRun.task || selectedRun.input?.question} rows={6} />
              </Card>

              <Card title={t('Execution Flow')} size="small">
                {trace.length ? (
                  <Timeline
                    items={trace.map((item: any) => ({
                      key: item.id,
                      color: item.status === 'error' ? 'red' : item.status === 'running' ? 'blue' : 'green',
                      children: (
                        <Space direction="vertical" size={2} style={{ width: '100%' }}>
                          <Space wrap>
                            <Text strong>{item.title || item.type}</Text>
                            <Tag>{item.type}</Tag>
                            <StatusTag status={item.status} />
                            {item.toolName && <Text code>{item.toolName}</Text>}
                            {item.durationMs ? <Text type="secondary">{formatDurationMs(item.durationMs)}</Text> : null}
                          </Space>
                          <Text type="secondary">{formatDate(item.at)}</Text>
                          {item.content ? <TextBlock value={item.content} rows={4} /> : null}
                        </Space>
                      ),
                    }))}
                  />
                ) : (
                  <Empty description={t('No execution flow captured')} />
                )}
              </Card>

              <Collapse
                items={[
                  {
                    key: 'toolMessages',
                    label: t('Native tool messages ({{count}})', { count: toolMessages.length }),
                    children: toolMessages.length ? (
                      <Table
                        rowKey={(record: any) => `${record.sessionId}:${record.toolCallId}`}
                        size="small"
                        pagination={false}
                        dataSource={toolMessages}
                        scroll={{ x: 'max-content' }}
                        columns={[
                          { title: t('Session'), dataIndex: 'sessionId', key: 'sessionId' },
                          { title: t('Tool'), dataIndex: 'toolName', key: 'toolName' },
                          {
                            title: t('Status'),
                            dataIndex: 'status',
                            key: 'status',
                            render: (value: string) => <StatusTag status={value === 'error' ? 'error' : value} />,
                          },
                          { title: t('Invoke'), dataIndex: 'invokeStatus', key: 'invokeStatus' },
                          {
                            title: t('Content'),
                            dataIndex: 'content',
                            key: 'content',
                            render: (value: unknown) => <TextBlock value={value} rows={3} />,
                          },
                        ]}
                      />
                    ) : (
                      <Empty description={t('No native tool messages')} />
                    ),
                  },
                  {
                    key: 'messages',
                    label: t('Native messages ({{count}})', { count: nativeMessages.length }),
                    children: nativeMessages.length ? (
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        {nativeMessages.map((item: any) => (
                          <Card
                            key={`${item.sessionId}:${item.messageId}`}
                            size="small"
                            title={`${item.role} #${item.messageId}`}
                          >
                            <TextBlock value={item.content || item.metadata} rows={6} />
                          </Card>
                        ))}
                      </Space>
                    ) : (
                      <Empty description={t('No native messages loaded')} />
                    ),
                  },
                  {
                    key: 'metadata',
                    label: t('Monitor metadata'),
                    children: <TextBlock value={selectedRun.metadata} rows={10} />,
                  },
                ]}
              />

              {(selectedRun.output || selectedRun.error) && (
                <Card title={selectedRun.error ? t('Error') : t('Result')} size="small">
                  <TextBlock value={selectedRun.error || selectedRun.output} rows={12} />
                </Card>
              )}
            </Space>
          </Spin>
        )}
      </Drawer>
    </div>
  );
};
