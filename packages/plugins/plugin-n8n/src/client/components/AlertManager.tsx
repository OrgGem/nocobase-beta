import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, InputNumber, Switch, Space, message, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

const METRICS = [
  { label: 'CPU', value: 'cpu' },
  { label: 'Memory RSS', value: 'memoryRss' },
  { label: 'Heap Used', value: 'heapUsed' },
  { label: 'Event Loop Lag', value: 'eventLoopLag' },
  { label: 'Queue Waiting', value: 'queueWaiting' },
  { label: 'Queue Active', value: 'queueActive' },
  { label: 'Queue Failed', value: 'queueFailed' },
  { label: 'Active Workflows', value: 'activeWorkflows' },
];

const OPERATORS = [
  { label: '>', value: '>' },
  { label: '<', value: '<' },
  { label: '>=', value: '>=' },
  { label: '<=', value: '<=' },
  { label: '==', value: '==' },
];

export const AlertManager: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { instanceId, instances } = useCurrentInstance();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest<any>(() => api.resource('n8nAlertRules').list({ pageSize: 100 }));

  const body = data?.data;
  const rules = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editingId) {
      await api.resource('n8nAlertRules').update({ filterByTk: editingId, values });
    } else {
      await api.resource('n8nAlertRules').create({ values });
    }
    message.success(t('Saved'));
    setModalOpen(false);
    setEditingId(null);
    form.resetFields();
    refresh();
  };

  const handleDelete = async (id: number) => {
    await api.resource('n8nAlertRules').destroy({ filterByTk: id });
    message.success(t('Deleted'));
    refresh();
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    {
      title: t('Instance'),
      dataIndex: 'instanceId',
      key: 'instanceId',
      render: (id: number) => instances.find((i: any) => i.id === id)?.name || `#${id}`,
    },
    { title: t('Metric'), dataIndex: 'metric', key: 'metric' },
    {
      title: t('Condition'),
      key: 'condition',
      render: (_: any, r: any) => `${r.operator} ${r.threshold}`,
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      render: (v: boolean) => (v ? '✓' : ''),
    },
    { title: t('Channel'), dataIndex: 'notifyChannel', key: 'notifyChannel' },
    {
      title: t('Last Triggered'),
      dataIndex: 'lastTriggeredAt',
      key: 'lastTriggeredAt',
      render: (v: string) => (v ? new Date(v).toLocaleString() : t('Never')),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingId(record.id);
              form.setFieldsValue(record);
              setModalOpen(true);
            }}
          />
          <Popconfirm title={t('Delete this alert?')} onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditingId(null);
            form.resetFields();
            form.setFieldsValue({ instanceId, windowMinutes: 60, enabled: true, notifyChannel: 'log' });
            setModalOpen(true);
          }}
        >
          {t('Add Alert Rule')}
        </Button>
      </div>
      <Table columns={columns} dataSource={rules} rowKey="id" loading={loading} pagination={false} />
      <Modal
        title={editingId ? t('Edit Alert Rule') : t('Add Alert Rule')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="instanceId" label={t('Instance')} rules={[{ required: true }]}>
            <Select options={instances.map((i: any) => ({ label: i.name, value: i.id }))} />
          </Form.Item>
          <Form.Item name="metric" label={t('Metric')} rules={[{ required: true }]}>
            <Select options={METRICS} />
          </Form.Item>
          <Space>
            <Form.Item name="operator" label={t('Operator')} rules={[{ required: true }]}>
              <Select options={OPERATORS} style={{ width: 80 }} />
            </Form.Item>
            <Form.Item name="threshold" label={t('Threshold')} rules={[{ required: true }]}>
              <InputNumber style={{ width: 150 }} />
            </Form.Item>
          </Space>
          <Form.Item name="windowMinutes" label={t('Cooldown (minutes)')}>
            <InputNumber min={1} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="notifyChannel" label={t('Notify Channel')}>
            <Select
              options={[
                { label: t('Log'), value: 'log' },
                { label: t('Webhook'), value: 'webhook' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.notifyChannel !== cur.notifyChannel}>
            {({ getFieldValue }) =>
              getFieldValue('notifyChannel') === 'webhook' ? (
                <Form.Item name="webhookUrl" label={t('Webhook URL')} rules={[{ required: true }]}>
                  <Input placeholder="https://..." />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
