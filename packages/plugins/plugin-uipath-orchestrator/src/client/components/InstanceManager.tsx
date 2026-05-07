/**
 * Instance Manager — CRUD for UiPath Orchestrator instances
 */

import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, Switch, Space, message, Tag, Popconfirm } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, ApiOutlined } from '@ant-design/icons';
import { useRequest, useAPIClient } from '@nocobase/client';
import { useT } from '../locale';

export const InstanceManager: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest<any>({
    resource: 'uipathInstances',
    action: 'list',
    params: { pageSize: 100 },
  });

  const instances = data?.data || [];
  const isMaskedSecret = (value: any) =>
    typeof value === 'string' && (value === '********' || value.includes('•') || value.includes('封'));

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      for (const field of ['clientSecret', 'webhookSecret', 'esPassword']) {
        if (editing && isMaskedSecret(values[field])) {
          delete values[field];
        }
      }
      if (editing) {
        await api.resource('uipathInstances').update({ filterByTk: editing.id, values });
      } else {
        await api.resource('uipathInstances').create({ values });
      }
      message.success(t('Saved'));
      setModalOpen(false);
      form.resetFields();
      setEditing(null);
      refresh();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    await api.resource('uipathInstances').destroy({ filterByTk: id });
    message.success(t('Deleted'));
    refresh();
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      const res = await api.request({ url: 'uipathInstanceActions:testConnection', params: { filterByTk: id } });
      const result = res?.data;
      if (result?.status === 'healthy') {
        message.success(`${t('Connected')} (${result.latencyMs}ms)`);
      } else {
        message.error(`${t('Failed')}: ${result?.message || 'Unknown error'}`);
      }
    } catch (err: any) {
      message.error(err.message);
    }
    setTesting(null);
  };

  const deploymentType = Form.useWatch('deploymentType', form);

  const columns = [
    { title: t('Name'), dataIndex: 'name' },
    { title: t('Type'), dataIndex: 'deploymentType', width: 100, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: t('Default'),
      dataIndex: 'isDefault',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="green">✓</Tag> : null),
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="green">On</Tag> : <Tag>Off</Tag>),
    },
    { title: t('Poll'), dataIndex: 'pollEnabled', width: 80, render: (v: boolean) => (v ? 'On' : 'Off') },
    {
      title: t('Actions'),
      width: 180,
      render: (_: any, r: any) => (
        <Space>
          <Button size="small" icon={<ApiOutlined />} loading={testing === r.id} onClick={() => handleTest(r.id)}>
            {t('Test')}
          </Button>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(r);
              form.setFieldsValue(r);
              setModalOpen(true);
            }}
          />
          <Popconfirm title={t('Delete?')} onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
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
          setEditing(null);
          form.resetFields();
          setModalOpen(true);
        }}
        style={{ marginBottom: 16 }}
      >
        {t('Add Instance')}
      </Button>
      <Table dataSource={instances} columns={columns} rowKey="id" loading={loading} size="small" />

      <Modal
        title={editing ? t('Edit Instance') : t('New Instance')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        width={640}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ deploymentType: 'cloud', scopes: 'OR.Default', enabled: true, pollEnabled: true }}
        >
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="deploymentType" label={t('Deployment Type')}>
            <Select
              options={[
                { label: 'Automation Cloud', value: 'cloud' },
                { label: 'On-Premises', value: 'onPrem' },
              ]}
            />
          </Form.Item>
          {deploymentType === 'cloud' ? (
            <>
              <Form.Item name="accountLogicalName" label={t('Account Name')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="tenantLogicalName" label={t('Tenant Name')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </>
          ) : (
            <Form.Item name="baseUrl" label={t('Base URL')} rules={[{ required: true }]}>
              <Input placeholder="https://orchestrator.company.com" />
            </Form.Item>
          )}
          <Form.Item name="apiBaseUrl" label={t('API Base URL (optional override)')}>
            <Input placeholder={t('Auto-generated from above')} />
          </Form.Item>
          <Form.Item name="tokenUrl" label={t('Token URL')}>
            <Input placeholder="https://cloud.uipath.com/identity_/connect/token" />
          </Form.Item>
          <Form.Item name="clientId" label={t('Client ID')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="clientSecret" label={t('Client Secret')} rules={[{ required: !editing }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="scopes" label={t('Scopes')}>
            <Input />
          </Form.Item>
          <Form.Item name="webhookSecret" label={t('Webhook Secret')}>
            <Input.Password />
          </Form.Item>
          <Space>
            <Form.Item name="isDefault" label={t('Default')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="pollEnabled" label={t('Polling')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="ignoreSsl" label={t('Ignore SSL')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
};
