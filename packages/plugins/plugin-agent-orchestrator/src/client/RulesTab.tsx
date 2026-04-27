import React, { useState } from 'react';
import {
  Table,
  Button,
  Drawer,
  Form,
  InputNumber,
  Switch,
  Space,
  Popconfirm,
  Card,
  message,
  Tag,
  Typography,
  Alert,
  Collapse,
  Empty,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SwapRightOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { AIEmployeeSelect } from './AIEmployeeSelect';
import { useAIEmployees } from './AIEmployeesContext';

const { Text } = Typography;

export const RulesTab: React.FC = () => {
  const api = useAPIClient();
  const [visible, setVisible] = useState(false);
  const [editingRecord, setEditingRecord] = useState<any>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest({
    url: 'orchestratorConfig:list',
    params: {
      sort: ['-createdAt'],
    },
  });

  // P3 FIX: Use shared context instead of duplicate API call
  const { employeeMap } = useAIEmployees();
  const rules = React.useMemo(() => {
    const rows = (data as any)?.data;
    return Array.isArray(rows) ? rows : [];
  }, [data]);

  const groupedRules = React.useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const rule of rules) {
      const key = rule.leaderUsername || 'unknown';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(rule);
    }

    return Array.from(groups.entries()).map(([leaderUsername, items]) => ({
      leaderUsername,
      items,
    }));
  }, [rules]);

  const handleOpen = (record?: any) => {
    setEditingRecord(record);
    if (record) {
      form.setFieldsValue(record);
    } else {
      form.resetFields();
      form.setFieldsValue({ enabled: true, maxDepth: 1, timeout: 120000 });
    }
    setVisible(true);
  };

  const handleClose = () => {
    setVisible(false);
    setEditingRecord(null);
  };

  const handleSave = async (values: any) => {
    // Validate: leader !== subAgent
    if (values.leaderUsername === values.subAgentUsername) {
      message.error('Leader and Sub-Agent cannot be the same employee.');
      return;
    }

    try {
      if (editingRecord) {
        await api.request({
          url: 'orchestratorConfig:update',
          method: 'put',
          params: { filterByTk: editingRecord.id },
          data: values,
        });
        message.success('Rule updated');
      } else {
        await api.request({
          url: 'orchestratorConfig:create',
          method: 'post',
          data: values,
        });
        message.success('Rule created');
      }
      handleClose();
      refresh();
    } catch (e: any) {
      const msg = e?.response?.data?.errors?.[0]?.message || e.message;
      message.error(`Save failed: ${msg}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.request({
        url: 'orchestratorConfig:destroy',
        method: 'delete',
        params: { filterByTk: id },
      });
      message.success('Rule deleted');
      refresh();
    } catch (e: any) {
      message.error(`Delete failed: ${e.message}`);
    }
  };

  const columns = [
    {
      title: 'Leader (Orchestrator)',
      dataIndex: 'leaderUsername',
      key: 'leaderUsername',
      render: (username: string) => (
        <Tag color="blue">{employeeMap.get(username) || username}</Tag>
      ),
    },
    {
      title: '',
      key: 'arrow',
      width: 50,
      render: () => <SwapRightOutlined style={{ color: '#999', fontSize: 18 }} />,
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
      title: 'Max Depth',
      dataIndex: 'maxDepth',
      key: 'maxDepth',
      width: 100,
      render: (v: number) => v ?? 1,
    },
    {
      title: 'Timeout',
      dataIndex: 'timeout',
      key: 'timeout',
      width: 100,
      render: (v: number) => `${((v ?? 120000) / 1000).toFixed(0)}s`,
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (enabled: boolean, record: any) => (
        <Switch
          checked={enabled}
          size="small"
          onChange={async (checked) => {
            await api.request({
              url: 'orchestratorConfig:update',
              method: 'put',
              params: { filterByTk: record.id },
              data: { enabled: checked },
            });
            refresh();
          }}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleOpen(record)}>
            Edit
          </Button>
          <Popconfirm title="Delete this rule?" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const leaderUsername = Form.useWatch('leaderUsername', form);

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Orchestration Rules"
        description={
          <Text type="secondary">
            Configure which AI Employees can act as Leaders (Orchestrators) and which ones they can delegate tasks to.
            Each rule creates a callable tool for the Leader to invoke the Sub-Agent.
          </Text>
        }
      />

      <Card bordered={false}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => handleOpen()}>
            New Rule
          </Button>
        </div>
        {groupedRules.length ? (
          <Collapse
            bordered={false}
            defaultActiveKey={groupedRules.map((group) => group.leaderUsername)}
            items={groupedRules.map((group) => ({
              key: group.leaderUsername,
              label: (
                <Space>
                  <Tag color="blue">{employeeMap.get(group.leaderUsername) || group.leaderUsername}</Tag>
                  <Text type="secondary">{group.items.length} sub-agent{group.items.length > 1 ? 's' : ''}</Text>
                </Space>
              ),
              children: (
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={group.items}
                  columns={columns}
                  pagination={false}
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
            locale={{ emptyText: <Empty description="No orchestration rules yet" /> }}
          />
        )}
      </Card>

      <Drawer
        title={editingRecord ? 'Edit Orchestration Rule' : 'New Orchestration Rule'}
        width={480}
        onClose={handleClose}
        open={visible}
        styles={{ body: { paddingBottom: 80 } }}
        extra={
          <Space>
            <Button onClick={handleClose}>Cancel</Button>
            <Button onClick={() => form.submit()} type="primary">
              Save
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="leaderUsername"
            label="Leader (Orchestrator)"
            rules={[{ required: true, message: 'Please select a Leader' }]}
            tooltip="The AI Employee that will be able to delegate tasks to the Sub-Agent"
          >
            <AIEmployeeSelect placeholder="Select Leader AI Employee..." />
          </Form.Item>

          <Form.Item
            name="subAgentUsername"
            label="Sub-Agent"
            rules={[{ required: true, message: 'Please select a Sub-Agent' }]}
            tooltip="The AI Employee that will receive delegated tasks"
          >
            <AIEmployeeSelect
              placeholder="Select Sub-Agent AI Employee..."
              exclude={leaderUsername}
            />
          </Form.Item>

          <Form.Item
            name="maxDepth"
            label="Max Delegation Depth"
            tooltip="How many layers of delegation are allowed (1 = leader calls sub-agent, sub-agent cannot delegate further)"
          >
            <InputNumber min={1} max={3} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="timeout"
            label="Timeout (ms)"
            tooltip="Maximum time in milliseconds for the sub-agent to complete its task"
          >
            <InputNumber min={10000} max={600000} step={10000} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="enabled" label="Enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};
