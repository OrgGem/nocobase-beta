import React, { useEffect, useState } from 'react';
import { Button, Card, Form, Input, message, Modal, Select, Space, Table, Tag } from 'antd';
import { useAPIClient } from '@nocobase/client';

export const PackageRegistriesSettings = () => {
  const api = useAPIClient();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm();

  const fetchRegistries = async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'packageRegistries:list' });
      setData(res.data?.data || []);
    } catch (err: any) {
      message.error('Failed to load registries');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRegistries();
  }, []);

  const handleAdd = () => {
    form.resetFields();
    form.setFieldsValue({ format: 'npm', type: 'proxy', authRequired: false });
    setEditingId(null);
    setVisible(true);
  };

  const handleEdit = (record: any) => {
    form.setFieldsValue(record);
    setEditingId(record.id);
    setVisible(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await api.request({
        url: `packageRegistries:destroy`,
        method: 'post',
        data: { filterByTk: id },
      });
      message.success('Deleted successfully');
      fetchRegistries();
    } catch (err: any) {
      message.error('Delete failed');
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingId) {
        await api.request({
          url: `packageRegistries:update`,
          method: 'post',
          data: { filterByTk: editingId, values },
        });
      } else {
        await api.request({
          url: `packageRegistries:create`,
          method: 'post',
          data: { values },
        });
      }
      message.success('Saved successfully');
      setVisible(false);
      fetchRegistries();
    } catch (err: any) {
      if (err?.errorFields) return; // Validation error
      message.error(err?.response?.data?.error?.message || 'Save failed');
    }
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    {
      title: 'Format',
      dataIndex: 'format',
      key: 'format',
      render: (text: string) => {
        let color = 'blue';
        if (text === 'pypi') color = 'gold';
        if (text === 'apt') color = 'red';
        if (text === 'apk') color = 'cyan';
        return <Tag color={color}>{text.toUpperCase()}</Tag>;
      },
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: (text: string) => <Tag color={text === 'proxy' ? 'green' : 'orange'}>{text}</Tag>,
    },
    { title: 'Upstream URL', dataIndex: 'upstreamUrl', key: 'upstreamUrl' },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" onClick={() => handleEdit(record)}>
            Edit
          </Button>
          <Button type="link" danger onClick={() => handleDelete(record.id)}>
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card title="Package Registries" extra={<Button type="primary" onClick={handleAdd}>Add Proxy Registry</Button>}>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />

      <Modal
        title={editingId ? 'Edit Registry' : 'Add Registry'}
        open={visible}
        onOk={handleSave}
        onCancel={() => setVisible(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. npm-proxy" />
          </Form.Item>
          <Form.Item name="format" label="Format" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'NPM', value: 'npm' },
                { label: 'PyPI (pip)', value: 'pypi' },
                { label: 'APT (Debian/Ubuntu)', value: 'apt' },
                { label: 'APK (Alpine)', value: 'apk' },
              ]}
            />
          </Form.Item>
          <Form.Item name="type" label="Type" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'Proxy', value: 'proxy' },
                { label: 'Hosted', value: 'hosted' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, current) => prev.type !== current.type}
          >
            {({ getFieldValue }) => {
              const type = getFieldValue('type');
              if (type === 'proxy') {
                return (
                  <Form.Item
                    name="upstreamUrl"
                    label="Upstream URL"
                    rules={[{ required: true }]}
                  >
                    <Input placeholder="e.g. https://registry.npmjs.org/" />
                  </Form.Item>
                );
              }
              return null;
            }}
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
