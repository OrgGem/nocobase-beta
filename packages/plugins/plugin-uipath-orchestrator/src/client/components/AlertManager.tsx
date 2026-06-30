/**
 * Alert Manager — CRUD alert rules
 */

import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, InputNumber, Switch, Space, message, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';
import { getListRows } from '../utils/apiResponse';

const SCOPES = ['jobs', 'sessions'];
const METRICS = [
  'jobsStats.Faulted',
  'jobsStats.Pending',
  'jobsStats.Running',
  'sessionsStats.Disconnected',
  'sessionsStats.Unresponsive',
];
const OPERATORS = ['>', '<', '>=', '<=', '=='];
const SEVERITIES = ['info', 'warning', 'critical'];

export const AlertManager: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { instanceId } = useCurrentInstance();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<any>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest<any>(
    () => api.resource('uipathAlertRules').list({ pageSize: 100, filter: { instanceId } }),
    { ready: !!instanceId, refreshDeps: [instanceId] },
  );

  const rules = getListRows<Record<string, unknown>>(data);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingRule) {
        await api.resource('uipathAlertRules').update({ filterByTk: editingRule.id, values });
      } else {
        await api.resource('uipathAlertRules').create({ values: { ...values, instanceId } });
      }
      message.success(t('Saved'));
      setModalOpen(false);
      form.resetFields();
      setEditingRule(null);
      refresh();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    await api.resource('uipathAlertRules').destroy({ filterByTk: id });
    message.success(t('Deleted'));
    refresh();
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name' },
    { title: t('Scope'), dataIndex: 'scope', width: 100 },
    { title: t('Metric'), dataIndex: 'metric', width: 200 },
    { title: t('Condition'), width: 150, render: (_: any, r: any) => `${r.operator} ${r.threshold}` },
    {
      title: t('Severity'),
      dataIndex: 'severity',
      width: 100,
      render: (s: string) => <Tag color={s === 'critical' ? 'red' : s === 'warning' ? 'orange' : 'blue'}>{s}</Tag>,
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="green">On</Tag> : <Tag>Off</Tag>),
    },
    {
      title: t('Actions'),
      width: 120,
      render: (_: any, r: any) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingRule(r);
              form.setFieldsValue(r);
              setModalOpen(true);
            }}
          />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(r.id)} />
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => {
          setEditingRule(null);
          form.resetFields();
          setModalOpen(true);
        }}
        style={{ marginBottom: 16 }}
      >
        {t('Add Alert Rule')}
      </Button>
      <Table dataSource={rules} columns={columns} rowKey="id" loading={loading} size="small" />

      <Modal
        title={editingRule ? t('Edit Alert Rule') : t('New Alert Rule')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditingRule(null);
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="scope" label={t('Scope')} initialValue="jobs">
            <Select options={SCOPES.map((s) => ({ label: s, value: s }))} />
          </Form.Item>
          <Form.Item name="metric" label={t('Metric')} rules={[{ required: true }]}>
            <Select options={METRICS.map((m) => ({ label: m, value: m }))} />
          </Form.Item>
          <Form.Item name="operator" label={t('Operator')} initialValue=">">
            <Select options={OPERATORS.map((o) => ({ label: o, value: o }))} />
          </Form.Item>
          <Form.Item name="threshold" label={t('Threshold')} rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="windowMinutes" label={t('Window (min)')} initialValue={60}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="severity" label={t('Severity')} initialValue="warning">
            <Select options={SEVERITIES.map((s) => ({ label: s, value: s }))} />
          </Form.Item>
          <Form.Item name="notifyChannel" label={t('Channel')} initialValue="log">
            <Select
              options={[
                { label: 'Log', value: 'log' },
                { label: 'Webhook', value: 'webhook' },
              ]}
            />
          </Form.Item>
          <Form.Item name="webhookUrl" label={t('Webhook URL')}>
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
