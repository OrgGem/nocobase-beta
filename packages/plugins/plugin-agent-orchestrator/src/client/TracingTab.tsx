import React, { useState } from 'react';
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
} from 'antd';
import {
  EyeOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useAIEmployees } from './AIEmployeesContext';

const { Text, Paragraph } = Typography;

export const TracingTab: React.FC = () => {
  const api = useAPIClient();
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const { data, loading, refresh } = useRequest({
    url: 'orchestratorTracing:list',
    params: {
      sort: ['-createdAt'],
      pageSize: 50,
    },
  });

  const { employeeMap } = useAIEmployees();
  const logs = React.useMemo(() => {
    const rows = (data as any)?.data;
    return Array.isArray(rows) ? rows : Array.isArray(data) ? data : [];
  }, [data]);

  const groupedLogs = React.useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const log of logs) {
      const key = log.leaderUsername || 'unknown';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(log);
    }
    return Array.from(groups.entries()).map(([leaderUsername, items]) => ({
      leaderUsername,
      items,
    }));
  }, [logs]);

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
        params: { filterByTk: record.id },
      });
      setSelectedLog((res as any)?.data?.data || (res as any)?.data || record);
    } finally {
      setDetailLoading(false);
    }
  };

  const columns = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (v: string) => v ? new Date(v).toLocaleString() : '-',
    },
    {
      title: 'Leader',
      dataIndex: 'leaderUsername',
      key: 'leaderUsername',
      render: (username: string) => (
        <Tag color="blue">{employeeMap.get(username) || username}</Tag>
      ),
    },
    {
      title: 'Sub-Agent',
      dataIndex: 'subAgentUsername',
      key: 'subAgentUsername',
      render: (username: string) => (
        <Tag color="green">{employeeMap.get(username) || username}</Tag>
      ),
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
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => handleOpenLog(record)}
        >
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
        message="Swarm Tracing"
        description={
          <Text type="secondary">
            View delegation execution logs. Each row represents one sub-agent invocation
            triggered by a Leader's tool call.
          </Text>
        }
      />

      <Card bordered={false}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={refresh}>Refresh</Button>
        </div>
        {groupedLogs.length ? (
          <Collapse
            bordered={false}
            defaultActiveKey={groupedLogs.map((group) => group.leaderUsername)}
            items={groupedLogs.map((group) => ({
              key: group.leaderUsername,
              label: (
                <Space>
                  <Tag color="blue">{employeeMap.get(group.leaderUsername) || group.leaderUsername}</Tag>
                  <Text type="secondary">{group.items.length} execution{group.items.length > 1 ? 's' : ''}</Text>
                </Space>
              ),
              children: (
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={group.items}
                  columns={columns}
                  pagination={{ hideOnSinglePage: true, pageSize: 20 }}
                  size="middle"
                />
              ),
            }))}
          />
        ) : (
          <Table
            rowKey="id"
            loading={loading}
            dataSource={[]}
            columns={columns}
            pagination={false}
            size="middle"
            locale={{ emptyText: <Empty description="No delegation executions yet" /> }}
          />
        )}
      </Card>

      <Drawer
        title="Delegation Detail"
        width={760}
        onClose={() => setSelectedLog(null)}
        open={!!selectedLog}
      >
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
                <Tag color="blue">
                  {employeeMap.get(selectedLog.leaderUsername) || selectedLog.leaderUsername}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Sub-Agent">
                <Tag color="green">
                  {employeeMap.get(selectedLog.subAgentUsername) || selectedLog.subAgentUsername}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Tool">
                <Text code>{selectedLog.toolName}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Depth">
                {selectedLog.depth ?? 0}
              </Descriptions.Item>
              <Descriptions.Item label="Duration">
                {formatDuration(selectedLog.durationMs)}
              </Descriptions.Item>
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

            <Card title="Sub-Agent Flow" size="small" style={{ marginBottom: 16 }}>
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
                <Empty description="No flow trace captured" />
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
                <Paragraph
                  type="danger"
                  style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}
                >
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
