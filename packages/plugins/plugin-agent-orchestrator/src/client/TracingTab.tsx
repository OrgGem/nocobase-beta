import React, { useMemo, useState } from 'react';
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
} from 'antd';
import { EyeOutlined, CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useAIEmployees } from './AIEmployeesContext';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

type FilterState = {
  leader?: string;
  subAgent?: string;
  status?: string;
  range?: [any, any] | null;
};

export const TracingTab: React.FC = () => {
  const api = useAPIClient();
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState<FilterState>({});

  const { employees, employeeMap } = useAIEmployees();

  const requestParams = useMemo(() => {
    const filter: any = {};
    if (filters.leader) filter.leaderUsername = filters.leader;
    if (filters.subAgent) filter.subAgentUsername = filters.subAgent;
    if (filters.status) filter.status = filters.status;
    if (filters.range && (filters.range[0] || filters.range[1])) {
      filter.createdAt = {};
      if (filters.range[0]) filter.createdAt.$gte = filters.range[0].toDate().toISOString();
      if (filters.range[1]) filter.createdAt.$lte = filters.range[1].toDate().toISOString();
    }
    return {
      sort: ['-createdAt'],
      page,
      pageSize,
      filter,
    };
  }, [page, pageSize, filters]);

  const { data, loading, refresh } = useRequest(
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
    const rows = (data as any)?.data;
    return Array.isArray(rows) ? rows : [];
  }, [data]);

  const total = useMemo(() => {
    const count = (data as any)?.meta?.count;
    return typeof count === 'number' ? count : 0;
  }, [data]);

  const formatDuration = (ms: number) => {
    if (!ms) return '-';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  };

  const handleOpenLog = async (record: any) => {
    setSelectedLog(record);
    setDetailLoading(true);
    try {
      const res = await api.request({
        url: 'orchestratorTracing:get',
        params: { filterByTk: record.id, source: record.hasUnifiedTrace ? 'span' : 'log' },
      });
      setSelectedLog((res as any)?.data?.data || (res as any)?.data || record);
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
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (v: string) => (v ? new Date(v).toLocaleString() : '-'),
    },
    {
      title: 'Leader',
      dataIndex: 'leaderUsername',
      key: 'leaderUsername',
      render: (username: string) => <Tag color="blue">{employeeMap.get(username) || username}</Tag>,
    },
    {
      title: 'Sub-Agent',
      dataIndex: 'subAgentUsername',
      key: 'subAgentUsername',
      render: (username: string) => <Tag color="green">{employeeMap.get(username) || username}</Tag>,
    },
    {
      title: 'Task',
      dataIndex: 'task',
      key: 'task',
      render: (task: string) => (
        <Text ellipsis style={{ maxWidth: 280 }}>
          {task?.substring(0, 100) || '-'}
        </Text>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: string) => (
        <Tag
          icon={status === 'success' ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          color={status === 'success' ? 'success' : 'error'}
        >
          {status}
        </Tag>
      ),
    },
    {
      title: 'Duration',
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 90,
      render: formatDuration,
    },
    {
      title: 'Depth',
      dataIndex: 'depth',
      key: 'depth',
      width: 60,
      render: (v: number) => v ?? 0,
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: any, record: any) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleOpenLog(record)}>
          Detail
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
        message="Execution Tracing"
        description={
          <Text type="secondary">
            View orchestration execution logs. Each row represents one sub-agent invocation, with child tool and Skill
            Hub executions shown in the detail flow.
          </Text>
        }
      />

      <Card bordered={false}>
        <Form layout="inline" style={{ marginBottom: 16, rowGap: 8, flexWrap: 'wrap' }}>
          <Form.Item label="Leader">
            <Select
              allowClear
              placeholder="Any leader"
              style={{ minWidth: 180 }}
              options={employeeOptions}
              value={filters.leader}
              onChange={(v) => updateFilter({ leader: v })}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item label="Sub-Agent">
            <Select
              allowClear
              placeholder="Any sub-agent"
              style={{ minWidth: 180 }}
              options={employeeOptions}
              value={filters.subAgent}
              onChange={(v) => updateFilter({ subAgent: v })}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item label="Status">
            <Select
              allowClear
              placeholder="Any status"
              style={{ minWidth: 140 }}
              options={[
                { label: 'Success', value: 'success' },
                { label: 'Error', value: 'error' },
                { label: 'Running', value: 'running' },
              ]}
              value={filters.status}
              onChange={(v) => updateFilter({ status: v })}
            />
          </Form.Item>
          <Form.Item label="Time">
            <RangePicker showTime value={filters.range as any} onChange={(v) => updateFilter({ range: v as any })} />
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
          dataSource={logs}
          columns={columns}
          size="middle"
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (count) => `${count} execution${count === 1 ? '' : 's'}`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
            },
          }}
          locale={{
            emptyText: (
              <Empty
                description={hasFilters ? 'No executions match the current filters' : 'No delegation executions yet'}
              />
            ),
          }}
        />
      </Card>

      <Drawer title="Execution Detail" width={820} onClose={() => setSelectedLog(null)} open={!!selectedLog}>
        {selectedLog && (
          <Spin spinning={detailLoading}>
            <>
              <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }}>
                <Descriptions.Item label="Status">
                  <Tag
                    icon={selectedLog.status === 'success' ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                    color={selectedLog.status === 'success' ? 'success' : 'error'}
                  >
                    {selectedLog.status}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Leader">
                  <Tag color="blue">{employeeMap.get(selectedLog.leaderUsername) || selectedLog.leaderUsername}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Sub-Agent">
                  <Tag color="green">
                    {employeeMap.get(selectedLog.subAgentUsername) || selectedLog.subAgentUsername}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="Tool">
                  <Text code>{selectedLog.toolName}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="Depth">{selectedLog.depth ?? 0}</Descriptions.Item>
                <Descriptions.Item label="Duration">{formatDuration(selectedLog.durationMs)}</Descriptions.Item>
                <Descriptions.Item label="Time">
                  {selectedLog.createdAt ? new Date(selectedLog.createdAt).toLocaleString() : '-'}
                </Descriptions.Item>
              </Descriptions>

              <Card title="Task" size="small" style={{ marginBottom: 16 }}>
                <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}>
                  {selectedLog.task || 'No task description'}
                </Paragraph>
              </Card>

              {selectedLog.context && (
                <Card title="Context" size="small" style={{ marginBottom: 16 }}>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}>
                    {selectedLog.context}
                  </Paragraph>
                </Card>
              )}

              <Card title="Execution Flow" size="small" style={{ marginBottom: 16 }}>
                {Array.isArray(selectedLog.trace) && selectedLog.trace.length ? (
                  <Timeline
                    items={selectedLog.trace.map((item: any, index: number) => ({
                      key: index,
                      color: item.status === 'error' ? 'red' : item.type === 'tool_call' ? 'blue' : 'green',
                      children: (
                        <div>
                          <Space direction="vertical" size={2} style={{ width: '100%' }}>
                            <Text strong>{item.title || item.type}</Text>
                            <Text type="secondary">{item.at ? new Date(item.at).toLocaleString() : ''}</Text>
                            {item.toolName && <Text code>{item.toolName}</Text>}
                            {item.skillExecutionId && (
                              <Text type="secondary">Skill execution #{item.skillExecutionId}</Text>
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
                  <Empty description="No execution flow captured" />
                )}
              </Card>

              {Array.isArray(selectedLog.messages) && selectedLog.messages.length > 0 && (
                <Collapse
                  style={{ marginBottom: 16 }}
                  items={[
                    {
                      key: 'messages',
                      label: `Raw messages (${selectedLog.messages.length})`,
                      children: (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          {selectedLog.messages.map((message: any) => (
                            <Card key={message.index} size="small" title={`${message.index + 1}. ${message.type}`}>
                              <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>
                                {message.content || JSON.stringify(message.toolCalls || message, null, 2)}
                              </Paragraph>
                              {message.toolCalls?.length > 0 && (
                                <Paragraph style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: 12 }}>
                                  {JSON.stringify(message.toolCalls, null, 2)}
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
                title="Result"
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
                  {selectedLog.result || selectedLog.error || 'No result'}
                </Paragraph>
              </Card>

              {selectedLog.error && (
                <Card title="Error" size="small" style={{ borderColor: '#ffa39e' }}>
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
