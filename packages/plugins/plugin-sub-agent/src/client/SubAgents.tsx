import React, { useState } from 'react';
import { Table, Button, Drawer, Form, Input, InputNumber, Switch, Space, Popconfirm, Card, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { SkillsSelect } from './SkillsSelect';

export const SubAgents: React.FC = () => {
  const api = useAPIClient();
  const [visible, setVisible] = useState(false);
  const [editingRecord, setEditingRecord] = useState<any>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest({
    url: 'subAgents:list',
    params: {
      sort: 'sort',
    },
  });

  const handleOpen = (record?: any) => {
    setEditingRecord(record);
    if (record) {
      form.setFieldsValue({
        ...record,
        // Sometimes NocoBase model outputs object
        model: typeof record.model === 'object' ? record.model?.llmService : record.model,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ maxIterations: 10, enabled: true, retryOnError: false, retryCount: 3 });
    }
    setVisible(true);
  };

  const handleClose = () => {
    setVisible(false);
    setEditingRecord(null);
  };

  const handleSave = async (values: any) => {
    try {
      if (editingRecord) {
        await api.request({
          url: 'subAgents:update',
          method: 'put',
          params: { filterByTk: editingRecord.id },
          data: values,
        });
        message.success('Updated successfully');
      } else {
        await api.request({
          url: 'subAgents:create',
          method: 'post',
          data: values,
        });
        message.success('Created successfully');
      }
      handleClose();
      refresh();
    } catch (e: any) {
      message.error(`Save failed: ${e.message}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.request({
        url: 'subAgents:destroy',
        method: 'delete',
        params: { filterByTk: id },
      });
      message.success('Deleted successfully');
      refresh();
    } catch (e: any) {
      message.error(`Delete failed: ${e.message}`);
    }
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Description', dataIndex: 'description', key: 'description' },
    { title: 'Model', dataIndex: 'model', key: 'model', render: (val: any) => (typeof val === 'object' ? val?.llmService : val) },
    { 
      title: 'Enabled', 
      dataIndex: 'enabled', 
      key: 'enabled',
      render: (enabled: boolean, record: any) => (
        <Switch 
          checked={enabled} 
          onChange={async (checked) => {
            await api.request({ url: 'subAgents:update', method: 'put', params: { filterByTk: record.id }, data: { enabled: checked } });
            refresh();
          }} 
        />
      )
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleOpen(record)}>Edit</Button>
          <Popconfirm title="Are you sure to delete this sub-agent?" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>Delete</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Card bordered={false}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => handleOpen()}>
            New Sub-Agent
          </Button>
        </div>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={(data as any)?.data || []}
          columns={columns}
          pagination={{ hideOnSinglePage: true }}
        />
      </Card>

      <Drawer
        title={editingRecord ? 'Edit Sub-Agent' : 'New Sub-Agent'}
        width={500}
        onClose={handleClose}
        open={visible}
        styles={{ body: { paddingBottom: 80 } }}
        extra={
          <Space>
            <Button onClick={handleClose}>Cancel</Button>
            <Button onClick={() => form.submit()} type="primary">Submit</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="name" label="Agent Name" rules={[{ required: true, message: 'Please enter name' }]}>
            <Input placeholder="e.g. data_analyst" />
          </Form.Item>
          
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Briefly describe what this agent does. Parent AI uses this to select it." />
          </Form.Item>
          
          <Form.Item name="systemPrompt" label="System Prompt">
            <Input.TextArea rows={4} placeholder="You are a data analyst..." />
          </Form.Item>
          
          <Form.Item name="skills" label="Skills (Tools)">
            <SkillsSelect />
          </Form.Item>

          <Form.Item name="model" label="LLM Model (Optional)" tooltip="Leave blank to use global default model">
            <Input placeholder="Enter LLM Service or Model name (e.g., openai, gpt-4)" allowClear />
          </Form.Item>

          <Form.Item name="maxIterations" label="Max Tool Iterations">
            <InputNumber min={1} max={50} style={{ width: '100%' }} />
          </Form.Item>

          <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 24 }}>
             <Form.Item name="enabled" label="Enabled" valuePropName="checked" style={{ margin: 0 }}>
               <Switch />
             </Form.Item>

             <Form.Item name="retryOnError" label="Retry on Error" valuePropName="checked" style={{ margin: 0 }}>
               <Switch />
             </Form.Item>
          </Space>

          <Form.Item 
            noStyle 
            shouldUpdate={(prev, curr) => prev.retryOnError !== curr.retryOnError}
          >
            {() => form.getFieldValue('retryOnError') ? (
              <Form.Item name="retryCount" label="Retry Count">
                 <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
            ) : null}
          </Form.Item>

        </Form>
      </Drawer>
    </div>
  );
};
