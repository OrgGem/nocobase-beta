import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Space, message, Popconfirm, Tag, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
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

  const [searchText, setSearchText] = useState('');

  const { data, loading, refresh } = useN8nRequest('n8nVariables', 'list');
  const { data: workflowsData } = useN8nRequest('n8nWorkflows', 'list');
  
  const variables = data?.data || data || [];
  const workflows = workflowsData?.data || workflowsData || [];

  const filteredVariables = React.useMemo(() => {
    let res = variables;
    if (searchText) {
      const q = searchText.toLowerCase();
      res = res.filter((v: any) => v.key?.toLowerCase().includes(q) || v.value?.toLowerCase().includes(q));
    }
    return res;
  }, [variables, searchText]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingId) {
        await api.request({
          url: `n8nVariables:update`,
          method: 'post',
          params: { instanceId, filterByTk: editingId },
          data: values,
        });
      } else {
        await api.request({
          url: `n8nVariables:create`,
          method: 'post',
          params: { instanceId },
          data: values,
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
      await api.request({ url: 'n8nVariables:destroy', params: { instanceId, filterByTk: id } });
      message.success(t('Deleted'));
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err.message || t('Failed'));
    }
  };

  const columns = [
    { title: t('Key'), dataIndex: 'key', key: 'key' },
    { title: t('Value'), dataIndex: 'value', key: 'value', ellipsis: true },
    { title: t('Type'), dataIndex: 'type', key: 'type', width: 100 },
    {
      title: t('Used In Workflows'),
      key: 'usedIn',
      render: (_: any, record: any) => {
        const usedWfs = workflows.filter((w: any) => {
          const wfStr = JSON.stringify(w.data || w);
          return wfStr.includes(`$vars.${record.key}`) || wfStr.includes(`$vars["${record.key}"]`) || wfStr.includes(`$vars['${record.key}']`);
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
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Space>
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
        <Input.Search
          placeholder={t('Search variables...')}
          allowClear
          onSearch={setSearchText}
          onChange={(e) => { if (!e.target.value) setSearchText(''); }}
          style={{ width: 250 }}
          prefix={<SearchOutlined />}
        />
      </Space>
      <Table columns={columns} dataSource={filteredVariables} rowKey="id" loading={loading} pagination={false} size="small" />
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
