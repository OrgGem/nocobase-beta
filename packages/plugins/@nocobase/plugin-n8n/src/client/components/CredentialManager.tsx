import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, Space, message, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

export const CredentialManager: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId } = useCurrentInstance();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string>('');
  const [form] = Form.useForm();

  const { data, loading, refresh } = useN8nRequest('n8nCredentials', 'list');
  const { data: typesData } = useN8nRequest('n8nCredentials', 'listTypes');

  const credentials = data?.data || data || [];
  const credTypes = typesData?.data || typesData || [];

  const handleSave = async () => {
    const values = await form.validateFields();
    const payload = { name: values.name, type: values.type, data: values.credentialData || {} };
    if (editingId) {
      await api.request({
        url: 'n8nCredentials:update',
        params: { instanceId, filterByTk: editingId },
        data: { values: payload },
      });
    } else {
      await api.request({ url: 'n8nCredentials:create', params: { instanceId }, data: { values: payload } });
    }
    message.success(t('Saved'));
    setModalOpen(false);
    setEditingId(null);
    form.resetFields();
    refresh();
  };

  const handleDelete = async (id: string) => {
    await api.request({ url: 'n8nCredentials:destroy', params: { instanceId, filterByTk: id } });
    message.success(t('Deleted'));
    refresh();
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    { title: t('Type'), dataIndex: 'type', key: 'type' },
    {
      title: t('Created'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
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
              setSelectedType(record.type);
              form.setFieldsValue({ name: record.name, type: record.type });
              setModalOpen(true);
            }}
          />
          <Popconfirm title={t('Delete this credential?')} onConfirm={() => handleDelete(record.id)}>
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
            setSelectedType('');
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t('Add Credential')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table columns={columns} dataSource={credentials} rowKey="id" loading={loading} pagination={{ pageSize: 20 }} />
      <Modal
        title={editingId ? t('Edit Credential') : t('Add Credential')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label={t('Credential Type')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              onChange={setSelectedType}
              disabled={!!editingId}
              options={
                Array.isArray(credTypes)
                  ? credTypes.map((ct: any) => ({
                      label: ct.displayName || ct.name,
                      value: ct.name,
                    }))
                  : []
              }
            />
          </Form.Item>
          {selectedType && (
            <Form.Item name="credentialData" label={t('Credential Data')}>
              <Input.TextArea rows={6} placeholder={t('JSON data for credential fields')} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
};
