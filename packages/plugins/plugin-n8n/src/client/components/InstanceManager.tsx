import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, Switch, Space, message, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useT } from '../locale';

export const InstanceManager: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest<any>({
    resource: 'n8nInstances',
    action: 'list',
    params: { pageSize: 100 },
  });

  const instances = data?.data || [];

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      // Don't send empty apiKey on edit (keep existing)
      if (editingId && !values.apiKey) {
        delete values.apiKey;
      }
      if (editingId) {
        await api.resource('n8nInstances').update({ filterByTk: editingId, values });
      } else {
        await api.resource('n8nInstances').create({ values });
      }
      message.success(t('Saved'));
      setModalOpen(false);
      setEditingId(null);
      form.resetFields();
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.resource('n8nInstances').destroy({ filterByTk: id });
      message.success(t('Deleted'));
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const handleEdit = (record: any) => {
    setEditingId(record.id);
    form.setFieldsValue(record);
    setModalOpen(true);
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    { title: t('URL'), dataIndex: 'baseUrl', key: 'baseUrl', ellipsis: true },
    {
      title: t('Environment'),
      dataIndex: 'environment',
      key: 'environment',
      render: (v: string) => <span style={{ textTransform: 'capitalize' }}>{v}</span>,
    },
    {
      title: t('Default'),
      dataIndex: 'isDefault',
      key: 'isDefault',
      render: (v: boolean) => (v ? '✓' : ''),
    },
    {
      title: t('Metrics'),
      dataIndex: 'metricsEnabled',
      key: 'metricsEnabled',
      render: (v: boolean) => (v ? '✓' : ''),
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      render: (v: boolean) => (v ? '✓' : ''),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm title={t('Delete this instance?')} onConfirm={() => handleDelete(record.id)}>
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
            setModalOpen(true);
          }}
        >
          {t('Add Instance')}
        </Button>
      </div>
      <Table columns={columns} dataSource={instances} rowKey="id" loading={loading} pagination={false} />
      <Modal
        title={editingId ? t('Edit Instance') : t('Add Instance')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ environment: 'production', enabled: true }}>
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="baseUrl" label={t('Base URL')} rules={[{ required: true }]}>
            <Input placeholder="https://n8n.example.com" />
          </Form.Item>
          <Form.Item name="apiKey" label={t('API Key')} rules={editingId ? [] : [{ required: true }]}>
            <Input.Password placeholder={editingId ? t('Leave blank to keep current') : ''} />
          </Form.Item>
          <Form.Item name="environment" label={t('Environment')}>
            <Select
              options={[
                { label: 'Production', value: 'production' },
                { label: 'Staging', value: 'staging' },
                { label: 'Development', value: 'development' },
              ]}
            />
          </Form.Item>
          <Form.Item name="internalUrl" label={t('Internal URL')}>
            <Input placeholder={t('Optional, for metrics behind firewall')} />
          </Form.Item>
          <Form.Item name="isDefault" label={t('Default Instance')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="metricsEnabled" label={t('Metrics Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          
          <div style={{ marginTop: 24, marginBottom: 8, fontWeight: 500 }}>{t('Worker Nodes')}</div>
          <Form.List name="workers">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                    <Form.Item
                      {...restField}
                      name={[name, 'hostname']}
                      rules={[{ required: true, message: 'Missing hostname' }]}
                    >
                      <Input placeholder="Worker Hostname" />
                    </Form.Item>
                    <Form.Item
                      {...restField}
                      name={[name, 'url']}
                      rules={[{ required: true, message: 'Missing URL' }]}
                    >
                      <Input placeholder="http://internal:5678" />
                    </Form.Item>
                    <Popconfirm title="Remove worker?" onConfirm={() => remove(name)}>
                      <Button type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ))}
                <Form.Item>
                  <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                    {t('Add Worker')}
                  </Button>
                </Form.Item>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  );
};
