import React, { useState } from 'react';
import { Table, Button, Modal, Form, Input, Space, Tag, Popconfirm, Switch, Tooltip, message } from 'antd';
import { PlusOutlined, DeleteOutlined, LinkOutlined, RobotOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useGitManager } from '../context/GitManagerContext';
import { useT } from '../locale';

export const RepositoryConfig: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { repos, refreshRepos, selectedRepo, setSelectedRepo } = useGitManager();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<any>(null);
  const [form] = Form.useForm();
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleSave = async () => {
    const values = await form.validateFields();
    // Don't send PAT if it's empty or the masked placeholder
    if (editingRepo && (!values.pat || values.pat === '••••••••')) {
      delete values.pat;
    }
    try {
      if (editingRepo) {
        await api.request({
          url: 'gitRepositories:update',
          method: 'post',
          params: { filterByTk: editingRepo.id },
          data: values,
        });
        message.success(t('Repository updated'));
      } else {
        await api.request({
          url: 'gitRepositories:create',
          method: 'post',
          data: values,
        });
        message.success(t('Repository added'));
      }
      setModalOpen(false);
      setEditingRepo(null);
      form.resetFields();
      await refreshRepos();
    } catch (err) {
      message.error(err?.message || t('Failed to save'));
    }
  };

  const handleDelete = async (id: number) => {
    await api.request({ url: 'gitRepositories:destroy', method: 'post', params: { filterByTk: id } });
    if (selectedRepo?.id === id) setSelectedRepo(null);
    message.success(t('Deleted'));
    await refreshRepos();
  };

  const handleClone = async (repo: any) => {
    setActionLoading(`clone-${repo.id}`);
    try {
      await api.request({
        url: 'gitManager:clone',
        method: 'post',
        params: { repositoryId: repo.id },
      });
      message.success(t('Clone successful'));
      await refreshRepos();
    } catch (err) {
      message.error(err?.response?.data?.errors?.[0]?.message || t('Clone failed'));
    } finally {
      setActionLoading(null);
    }
  };

  const columns = [
    {
      title: t('Repository Name'),
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: any) => (
        <a onClick={() => setSelectedRepo(record)}>{text}</a>
      ),
    },
    { title: t('Repository URL'), dataIndex: 'repoUrl', key: 'repoUrl', ellipsis: true },
    { title: t('Local Path'), dataIndex: 'localPath', key: 'localPath', ellipsis: true },
    { title: t('Default Branch'), dataIndex: 'defaultBranch', key: 'defaultBranch', width: 120 },
    {
      title: (
        <Tooltip title={t('Auto-poll new merge requests every 5 minutes')}>
          <Space size={4}>
            <RobotOutlined />
            {t('Auto Review')}
          </Space>
        </Tooltip>
      ),
      dataIndex: 'autoReview',
      key: 'autoReview',
      width: 110,
      render: (v: boolean, record: any) => (
        <Switch
          size="small"
          checked={!!v}
          onChange={async (checked) => {
            try {
              await api.request({
                url: 'gitRepositories:update',
                method: 'post',
                params: { filterByTk: record.id },
                data: { autoReview: checked },
              });
              await refreshRepos();
            } catch (err: any) {
              message.error(err?.message || t('Failed to save'));
            }
          }}
        />
      ),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string) => {
        const statusMap: Record<string, { color: string; label: string }> = {
          connected: { color: 'green', label: t('Connected') },
          error: { color: 'red', label: t('Error') },
        };
        const info = statusMap[status] || { color: 'default', label: t('Disconnected') };
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: '',
      key: 'actions',
      width: 200,
      render: (_: any, record: any) => (
        <Space size="small">
          {record.status !== 'connected' && (
            <Button
              size="small"
              icon={<LinkOutlined />}
              loading={actionLoading === `clone-${record.id}`}
              onClick={() => handleClone(record)}
            >
              {t('Clone')}
            </Button>
          )}
          <Button
            size="small"
            onClick={() => {
              setEditingRepo(record);
              form.setFieldsValue({ ...record, pat: '' });
              setModalOpen(true);
            }}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this repository?')} onConfirm={() => handleDelete(record.id)}>
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
            setEditingRepo(null);
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t('Add Repository')}
        </Button>
      </div>

      <Table
        dataSource={repos}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={false}
        rowClassName={(record) => (selectedRepo?.id === record.id ? 'ant-table-row-selected' : '')}
      />

      <Modal
        title={editingRepo ? t('Edit Repository') : t('Add Repository')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => {
          setModalOpen(false);
          setEditingRepo(null);
        }}
        width={520}
      >
        <Form form={form} layout="vertical" initialValues={{ defaultBranch: 'main' }}>
          <Form.Item name="name" label={t('Repository Name')} rules={[{ required: true }]}>
            <Input placeholder="my-project" />
          </Form.Item>
          <Form.Item name="repoUrl" label={t('Repository URL')} rules={[{ required: true }]}>
            <Input placeholder="https://gitlab.com/user/repo.git" />
          </Form.Item>
          <Form.Item name="username" label={t('Username')} rules={[{ required: true }]} extra={t('GitLab username for PAT authentication')}>
            <Input placeholder="gitlab-username" />
          </Form.Item>
          <Form.Item name="localPath" label={t('Local Path')} rules={[{ required: true }]}>
            <Input placeholder="my-project" />
          </Form.Item>
          <Form.Item name="pat" label={t('Personal Access Token')} rules={editingRepo ? [] : [{ required: true }]}>
            <Input.Password placeholder={editingRepo ? 'Leave empty to keep current' : 'ghp_xxxx...'} />
          </Form.Item>
          <Form.Item name="defaultBranch" label={t('Default Branch')}>
            <Input placeholder="main" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
