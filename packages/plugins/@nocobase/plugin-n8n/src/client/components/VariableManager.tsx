import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Space, message, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

export const VariableManager: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId } = useCurrentInstance();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useN8nRequest('n8nVariables', 'list');
  const variables = data?.data || data || [];

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editingId) {
      await api.request({
        url: 'n8nVariables:update',
        params: { instanceId, filterByTk: editingId },
        data: { values },
      });
    } else {
      await api.request({ url: 'n8nVariables:create', params: { instanceId }, data: { values } });
    }
    message.success(t('Saved'));
    setModalOpen(false);
    setEditingId(null);
    form.resetFields();
    refresh();
  };

  const handleDelete = async (id: string) => {
    await api.request({ url: 'n8nVariables:destroy', params: { instanceId, filterByTk: id } });
    message.success(t('Deleted'));
    refresh();
  };

  const columns = [
    { title: t('Key'), dataIndex: 'key', key: 'key' },
    { title: t('Value'), dataIndex: 'value', key: 'value', ellipsis: true },
    { title: t('Type'), dataIndex: 'type', key: 'type', width: 100 },
    {
      title: t('Actions'),
      key: 'actions',
      width: 120,
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
          <Popconfirm title={t('Delete this variable?')} onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditingId(null);
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t('Add Variable')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table columns={columns} dataSource={variables} rowKey="id" loading={loading} pagination={false} />
      <Modal
        title={editingId ? t('Edit Variable') : t('Add Variable')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="key" label={t('Key')} rules={[{ required: true }]}>
            <Input disabled={!!editingId} />
          </Form.Item>
          <Form.Item name="value" label={t('Value')} rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
