import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, Space, message, Popconfirm, Tag, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
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

  const [searchText, setSearchText] = useState('');

  const { data, loading, refresh } = useN8nRequest('n8nCredentials', 'list');
  const { data: typesData } = useN8nRequest('n8nCredentials', 'listTypes');
  const { data: workflowsData } = useN8nRequest('n8nWorkflows', 'list');

  const credentials = data?.data || data || [];
  const credTypes = typesData?.data || typesData || [];
  const workflows = workflowsData?.data || workflowsData || [];

  const filteredCredentials = React.useMemo(() => {
    let res = credentials;
    if (searchText) {
      const q = searchText.toLowerCase();
      res = res.filter((c: any) => c.name?.toLowerCase().includes(q) || c.type?.toLowerCase().includes(q));
    }
    return res;
  }, [credentials, searchText]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      let credData = {};
      if (values.credentialData) {
        try {
          credData = JSON.parse(values.credentialData);
        } catch {
          message.error(t('Credential Data must be valid JSON'));
          return;
        }
      }
      const payload = { name: values.name, type: values.type, data: credData };
      if (editingId) {
        await api.request({
          url: 'n8nCredentials:update',
          method: 'post',
          params: { instanceId, filterByTk: editingId },
          data: payload,
        });
      } else {
        await api.request({
          url: 'n8nCredentials:create',
          method: 'post',
          params: { instanceId },
          data: payload,
        });
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

  const handleDelete = async (id: string) => {
    try {
      await api.request({ url: 'n8nCredentials:destroy', params: { instanceId, filterByTk: id } });
      message.success(t('Deleted'));
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    { title: t('Type'), dataIndex: 'type', key: 'type' },
    {
      title: t('Used In Workflows'),
      key: 'usedIn',
      render: (_: any, record: any) => {
        // N8n stores credentials in node parameters usually as "credentials": { "TypeName": { "id": "123", ... } } 
        // We can check if the workflow string contains the credential ID or Name
        const usedWfs = workflows.filter((w: any) => {
          const wfStr = JSON.stringify(w.data || w);
          return wfStr.includes(`"id":"${record.id}"`) || wfStr.includes(`"name":"${record.name}"`);
        });
        if (!usedWfs.length) return <span style={{ color: '#ccc' }}>-</span>;
        return (
          <Space size={[0, 4]} wrap>
            {usedWfs.map((w: any) => (
              <Tooltip key={w.id} title={w.name}>
                <Tag color="cyan">{w.name}</Tag>
              </Tooltip>
            ))}
          </Space>
        );
      },
    },
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
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Space>
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
        <Input.Search
          placeholder={t('Search credentials...')}
          allowClear
          onSearch={setSearchText}
          onChange={(e) => { if (!e.target.value) setSearchText(''); }}
          style={{ width: 250 }}
          prefix={<SearchOutlined />}
        />
      </Space>
      <Table columns={columns} dataSource={filteredCredentials} rowKey="id" loading={loading} pagination={{ pageSize: 20 }} size="small" />
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
