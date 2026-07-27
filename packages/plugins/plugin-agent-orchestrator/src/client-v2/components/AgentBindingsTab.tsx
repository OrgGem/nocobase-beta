import React, { useMemo, useState } from 'react';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
  Drawer,
  Form,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { AIEmployeeSelect } from './AIEmployeeSelect';
import { useAIEmployees } from './AIEmployeesContext';
import { useApiClient, useRequest } from '../hooks/useApiRequest';
import { useT } from '../skill-hub/locale';

type BindingRecord = {
  id: string | number;
  leaderUsername: string;
  subAgentUsername: string;
  harnessTag?: string;
  enabled?: boolean;
  maxDepth?: number;
  timeout?: number;
};

type ProfileRecord = { tag: string; title?: string; enabled?: boolean };

type BindingForm = Omit<BindingRecord, 'id'>;

function rowsFromResponse<T>(value: unknown): T[] {
  const response = value as { data?: unknown } | undefined;
  return Array.isArray(response?.data) ? (response.data as T[]) : [];
}

function errorText(error: unknown): string {
  const response = error as { response?: { data?: { errors?: Array<{ message?: string }> } }; message?: string };
  return response.response?.data?.errors?.[0]?.message || response.message || 'Unknown error';
}

export const AgentBindingsTab: React.FC = () => {
  const api = useApiClient();
  const t = useT();
  const { employeeMap } = useAIEmployees();
  const [form] = Form.useForm<BindingForm>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<BindingRecord | null>(null);

  const bindingsRequest = useRequest({
    url: 'orchestratorConfig:list',
    params: { sort: ['leaderUsername', 'subAgentUsername'], pageSize: 200 },
  });
  const profilesRequest = useRequest({
    url: 'agentHarnessProfiles:list',
    params: { sort: ['tag'], pageSize: 100 },
  });

  const bindings = useMemo(() => rowsFromResponse<BindingRecord>(bindingsRequest.data), [bindingsRequest.data]);
  const profiles = useMemo(() => rowsFromResponse<ProfileRecord>(profilesRequest.data), [profilesRequest.data]);
  const profileOptions = useMemo(
    () =>
      profiles
        .filter((profile) => profile.enabled !== false)
        .map((profile) => ({
          label: profile.title ? `${profile.title} (${profile.tag})` : profile.tag,
          value: profile.tag,
        })),
    [profiles],
  );

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditing(null);
    form.resetFields();
  };

  const openDrawer = (binding?: BindingRecord) => {
    setEditing(binding || null);
    form.setFieldsValue(
      binding || {
        enabled: true,
        harnessTag: 'default',
        maxDepth: 1,
        timeout: 120000,
      },
    );
    setDrawerOpen(true);
  };

  const saveBinding = async (values: BindingForm) => {
    const payload = {
      ...values,
      leaderUsername: values.leaderUsername?.trim(),
      subAgentUsername: values.subAgentUsername?.trim(),
      harnessTag: values.harnessTag || 'default',
      enabled: values.enabled !== false,
    };
    try {
      if (editing) {
        await api.request({
          url: 'orchestratorConfig:update',
          method: 'put',
          params: { filterByTk: editing.id },
          data: payload,
        });
        message.success(t('Agent binding updated'));
      } else {
        await api.request({ url: 'orchestratorConfig:create', method: 'post', data: payload });
        message.success(t('Agent binding created'));
      }
      closeDrawer();
      bindingsRequest.refresh();
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorText(error) }));
    }
  };

  const removeBinding = async (id: string | number) => {
    try {
      await api.request({
        url: 'orchestratorConfig:destroy',
        method: 'delete',
        params: { filterByTk: id },
      });
      message.success(t('Agent binding deleted'));
      bindingsRequest.refresh();
    } catch (error) {
      message.error(t('Delete failed: {{message}}', { message: errorText(error) }));
    }
  };

  const columns = [
    {
      title: t('Leader (Orchestrator)'),
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
      title: t('Policy Profile'),
      dataIndex: 'harnessTag',
      key: 'harnessTag',
      render: (tag: string) => <Tag color="purple">{tag || 'default'}</Tag>,
    },
    { title: t('Max Delegation Depth'), dataIndex: 'maxDepth', key: 'maxDepth', width: 140 },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean, binding: BindingRecord) => (
        <Switch
          size="small"
          checked={enabled !== false}
          aria-label={t('Enabled')}
          onChange={async (checked) => {
            await api.request({
              url: 'orchestratorConfig:update',
              method: 'put',
              params: { filterByTk: binding.id },
              data: { enabled: checked },
            });
            bindingsRequest.refresh();
          }}
        />
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 150,
      render: (_: unknown, binding: BindingRecord) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openDrawer(binding)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this binding?')} onConfirm={() => removeBinding(binding.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card bordered={false}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <Typography.Text type="secondary">
            {t('Bind each leader/sub-agent pair to the profile that controls memory and tracing policy.')}
          </Typography.Text>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
            {t('New Agent Binding')}
          </Button>
        </div>
        <Table
          rowKey="id"
          dataSource={bindings}
          loading={bindingsRequest.loading || profilesRequest.loading}
          columns={columns}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      </Space>

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        width={560}
        title={editing ? t('Edit Agent Binding') : t('New Agent Binding')}
        extra={
          <Space>
            <Button onClick={closeDrawer}>{t('Cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('Save')}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={saveBinding}>
          <Form.Item
            label={t('Leader (Orchestrator)')}
            name="leaderUsername"
            rules={[{ required: true, message: t('Leader is required') }]}
          >
            <AIEmployeeSelect placeholder={t('Select leader')} />
          </Form.Item>
          <Form.Item
            label={t('Sub-Agent')}
            name="subAgentUsername"
            rules={[{ required: true, message: t('Sub-agent is required') }]}
          >
            <AIEmployeeSelect placeholder={t('Select sub-agent')} />
          </Form.Item>
          <Form.Item
            label={t('Policy Profile')}
            name="harnessTag"
            rules={[{ required: true, message: t('Policy profile is required') }]}
          >
            <Select options={profileOptions} placeholder={t('Select policy profile')} />
          </Form.Item>
          <Form.Item label={t('Max Delegation Depth')} name="maxDepth">
            <InputNumber min={1} max={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('Timeout (ms)')} name="timeout">
            <InputNumber min={1000} max={600000} step={1000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('Enabled')} name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </Card>
  );
};
