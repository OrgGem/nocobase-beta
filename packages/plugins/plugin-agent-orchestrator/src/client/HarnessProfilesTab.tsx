import React from 'react';
import { Button, Card, Drawer, Form, Input, Popconfirm, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';

const { Text } = Typography;

const parseSettings = (value: string) => {
  const text = String(value || '').trim();
  if (!text) return {};
  return JSON.parse(text);
};

export const HarnessProfilesTab: React.FC = () => {
  const api = useAPIClient();
  const [open, setOpen] = React.useState(false);
  const [editingRecord, setEditingRecord] = React.useState<any>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest({
    url: 'agentHarnessProfiles:list',
    params: {
      sort: ['tag'],
      pageSize: 100,
    },
  });

  const rows = React.useMemo(() => {
    const raw = (data as any)?.data;
    return Array.isArray(raw) ? raw : [];
  }, [data]);

  const openDrawer = (record?: any) => {
    setEditingRecord(record || null);
    form.resetFields();
    form.setFieldsValue(
      record
        ? {
            ...record,
            settingsText: JSON.stringify(record.settings || {}, null, 2),
          }
        : {
            tag: '',
            title: '',
            description: '',
            enabled: true,
            settingsText: JSON.stringify(
              {
                requirePlanApproval: true,
                allowSubAgents: true,
                allowToolCalls: true,
                maxParallelSubAgents: 3,
                maxControllerSteps: 100,
              },
              null,
              2,
            ),
          },
    );
    setOpen(true);
  };

  const closeDrawer = () => {
    setOpen(false);
    setEditingRecord(null);
  };

  const saveProfile = async (values: any) => {
    let settings: any;
    try {
      settings = parseSettings(values.settingsText);
    } catch (error: any) {
      message.error(`Settings JSON is invalid: ${error?.message || error}`);
      return;
    }

    const payload = {
      tag: String(values.tag || '').trim(),
      title: values.title,
      description: values.description,
      enabled: values.enabled !== false,
      settings,
    };

    try {
      if (editingRecord) {
        await api.request({
          url: 'agentHarnessProfiles:update',
          method: 'put',
          params: { filterByTk: editingRecord.id },
          data: payload,
        });
        message.success('Harness profile updated');
      } else {
        await api.request({
          url: 'agentHarnessProfiles:create',
          method: 'post',
          data: payload,
        });
        message.success('Harness profile created');
      }
      closeDrawer();
      refresh();
    } catch (error: any) {
      const msg = error?.response?.data?.errors?.[0]?.message || error?.message || 'unknown error';
      message.error(`Save failed: ${msg}`);
    }
  };

  const deleteProfile = async (id: string | number) => {
    try {
      await api.request({
        url: 'agentHarnessProfiles:destroy',
        method: 'delete',
        params: { filterByTk: id },
      });
      message.success('Harness profile deleted');
      refresh();
    } catch (error: any) {
      message.error(`Delete failed: ${error?.message || 'unknown error'}`);
    }
  };

  const columns = [
    {
      title: 'Tag',
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      render: (tag: string) => <Tag color="blue">{tag}</Tag>,
    },
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record: any) => title || record.tag,
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (enabled: boolean, record: any) => (
        <Switch
          size="small"
          checked={enabled !== false}
          onChange={async (checked) => {
            await api.request({
              url: 'agentHarnessProfiles:update',
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
      title: 'Settings',
      key: 'settings',
      render: (_: any, record: any) => (
        <Space size={4} wrap>
          {Object.entries(record.settings || {})
            .slice(0, 5)
            .map(([key, value]) => (
              <Tag key={key}>
                {key}: {String(value)}
              </Tag>
            ))}
        </Space>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 150,
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openDrawer(record)}>
            Edit
          </Button>
          <Popconfirm title="Delete this profile?" onConfirm={() => deleteProfile(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card bordered={false}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <Text type="secondary">
              Harness profiles are selected by orchestration rules through the harnessTag field.
            </Text>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
              New Profile
            </Button>
          </div>
          <Table rowKey="id" loading={loading} dataSource={rows} columns={columns} pagination={false} />
        </Space>
      </Card>

      <Drawer
        title={editingRecord ? 'Edit Harness Profile' : 'New Harness Profile'}
        width={560}
        open={open}
        onClose={closeDrawer}
        extra={
          <Space>
            <Button onClick={closeDrawer}>Cancel</Button>
            <Button type="primary" onClick={() => form.submit()}>
              Save
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={saveProfile}>
          <Form.Item name="tag" label="Tag" rules={[{ required: true, message: 'Tag is required' }]}>
            <Input placeholder="default" disabled={editingRecord?.tag === 'default'} />
          </Form.Item>
          <Form.Item name="title" label="Title">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="settingsText"
            label="Settings JSON"
            rules={[{ required: true, message: 'Settings JSON is required' }]}
          >
            <Input.TextArea rows={12} spellCheck={false} />
          </Form.Item>
          <Form.Item name="enabled" label="Enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};
