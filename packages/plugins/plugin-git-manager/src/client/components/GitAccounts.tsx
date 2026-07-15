import React, { useCallback, useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, Space, Tag, Popconfirm, Select, message } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';

export const GitAccounts: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<any>(null);
  const [form] = Form.useForm();

  const refreshAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'gitAccounts:list', params: { pageSize: 100 } });
      setAccounts(data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refreshAccounts().catch(() => undefined);
  }, [refreshAccounts]);

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editingAccount && (!values.pat || values.pat === '••••••••')) {
      delete values.pat;
    }
    try {
      if (editingAccount) {
        await api.request({
          url: 'gitAccounts:update',
          method: 'post',
          params: { filterByTk: editingAccount.id },
          data: values,
        });
        message.success(t('Account updated'));
      } else {
        await api.request({
          url: 'gitAccounts:create',
          method: 'post',
          data: values,
        });
        message.success(t('Account added'));
      }
      setModalOpen(false);
      setEditingAccount(null);
      form.resetFields();
      await refreshAccounts();
    } catch (err) {
      message.error(err?.message || t('Failed to save'));
    }
  };

  const handleDelete = async (id: number) => {
    await api.request({ url: 'gitAccounts:destroy', method: 'post', params: { filterByTk: id } });
    message.success(t('Deleted'));
    await refreshAccounts();
  };

  const columns = [
    {
      title: t('Account Name'),
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: t('Provider'),
      dataIndex: 'provider',
      key: 'provider',
      width: 100,
      render: (provider: string) => (
        <Tag color={provider === 'github' ? 'blue' : 'orange'}>{provider === 'github' ? 'GitHub' : 'GitLab'}</Tag>
      ),
    },
    {
      title: t('Base URL'),
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      ellipsis: true,
      render: (url: string) => url || '-',
    },
    {
      title: t('Username'),
      dataIndex: 'username',
      key: 'username',
      width: 150,
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_: any, record: any) => (
        <Space size="small">
          <Button
            size="small"
            onClick={() => {
              setEditingAccount(record);
              form.setFieldsValue({ ...record, pat: '' });
              setModalOpen(true);
            }}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this account?')} onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
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
            setEditingAccount(null);
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t('Add Account')}
        </Button>
      </div>

      <Table dataSource={accounts} columns={columns} rowKey="id" size="small" loading={loading} pagination={false} />

      <Modal
        title={editingAccount ? t('Edit Account') : t('Add Account')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditingAccount(null);
        }}
        width={480}
      >
        <Form form={form} layout="vertical" initialValues={{ provider: 'gitlab' }}>
          <Form.Item name="name" label={t('Account Name')} rules={[{ required: true }]}>
            <Input placeholder={t('e.g. Company GitLab')} />
          </Form.Item>
          <Form.Item name="provider" label={t('Provider')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'gitlab', label: 'GitLab' },
                { value: 'github', label: 'GitHub' },
              ]}
            />
          </Form.Item>
          <Form.Item name="baseUrl" label={t('Base URL')} extra={t('Leave empty for gitlab.com or github.com')}>
            <Input placeholder="https://gitlab.company.com" />
          </Form.Item>
          <Form.Item
            name="username"
            label={t('Username')}
            rules={[{ required: true }]}
            extra={t('GitLab username for PAT authentication')}
          >
            <Input placeholder="gitlab-username" />
          </Form.Item>
          <Form.Item name="pat" label={t('Personal Access Token')} rules={editingAccount ? [] : [{ required: true }]}>
            <Input.Password placeholder={editingAccount ? t('Leave empty to keep current') : 'glpat-xxxx...'} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export const GitAccountsSettings: React.FC = () => <GitAccounts />;
