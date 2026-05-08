import React, { useCallback, useEffect, useState } from 'react';
import {
  Table, Button, Space, Modal, Form, Input, Select, Switch, Tag, Popconfirm, message, Empty, Tooltip,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, BranchesOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useGitManager } from '../context/GitManagerContext';
import { AIEmployeeSelect } from './AIEmployeeSelect';
import { LLMServiceSelect } from './LLMServiceSelect';
import { LLMModelSelect } from './LLMModelSelect';
import { useT } from '../locale';

const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Manual',
  onMergeRequestCreated: 'On MR Created',
  both: 'Both',
};

const POST_LABELS: Record<string, string> = {
  auto: 'Auto',
  manual: 'Manual',
  disabled: 'Disabled',
};

export const ReviewFlows: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { repos } = useGitManager();
  const [flows, setFlows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'gitReviewFlows:list', params: { pageSize: 100 } });
      setFlows(data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      // Normalize empty string to null for repositoryId
      if (values.repositoryId === undefined || values.repositoryId === '') {
        values.repositoryId = null;
      }
      if (editing?.id) {
        await api.request({
          url: 'gitReviewFlows:update',
          method: 'post',
          params: { filterByTk: editing.id },
          data: values,
        });
        message.success(t('Flow updated'));
      } else {
        await api.request({ url: 'gitReviewFlows:create', method: 'post', data: values });
        message.success(t('Flow created'));
      }
      setOpen(false);
      setEditing(null);
      form.resetFields();
      load();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.response?.data?.errors?.[0]?.message || err?.message || t('Failed to save'));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.request({ url: 'gitReviewFlows:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('Flow deleted'));
      load();
    } catch (err: any) {
      message.error(err?.message || t('Failed to delete'));
    }
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      enabled: true,
      triggerMode: 'manual',
      postMode: 'manual',
    });
    setOpen(true);
  };

  const openEdit = (record: any) => {
    setEditing(record);
    form.setFieldsValue(record);
    setOpen(true);
  };

  const columns = [
    {
      title: t('Name'),
      dataIndex: 'name',
      render: (v: string, r: any) => (
        <Space>
          <span style={{ fontWeight: 500 }}>{v}</span>
          {!r.enabled && <Tag color="default">{t('Disabled')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('Repository'),
      dataIndex: 'repositoryId',
      render: (v: number | null) => {
        if (v == null) return <Tag color="purple">{t('Global')}</Tag>;
        const repo = repos.find((r: any) => r.id === v);
        return repo ? (
          <Space size={4}>
            <BranchesOutlined />
            {repo.name}
          </Space>
        ) : (
          `#${v}`
        );
      },
    },
    {
      title: t('AI Employee'),
      dataIndex: 'aiEmployeeUsername',
      render: (v: string) => (v ? <Tag color="blue">@{v}</Tag> : <span style={{ color: '#999' }}>—</span>),
    },
    {
      title: t('Trigger'),
      dataIndex: 'triggerMode',
      render: (v: string) => <Tag>{t(TRIGGER_LABELS[v] || v)}</Tag>,
    },
    {
      title: t('Post'),
      dataIndex: 'postMode',
      render: (v: string) => {
        const color = v === 'auto' ? 'green' : v === 'manual' ? 'orange' : 'default';
        return <Tag color={color}>{t(POST_LABELS[v] || v)}</Tag>;
      },
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: any, record: any) => (
        <Space>
          <Tooltip title={t('Edit')}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          </Tooltip>
          <Popconfirm title={t('Delete this flow?')} onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Add Review Flow')}
        </Button>
        <Button onClick={load} loading={loading}>
          {t('Refresh')}
        </Button>
      </div>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={flows}
        columns={columns}
        locale={{ emptyText: <Empty description={t('No review flows yet')} /> }}
        pagination={{ pageSize: 20 }}
      />

      <Modal
        title={editing?.id ? t('Edit Review Flow') : t('Add Review Flow')}
        open={open}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
          form.resetFields();
        }}
        onOk={handleSave}
        width={640}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input placeholder={t('e.g. Default review flow')} />
          </Form.Item>
          <Form.Item name="repositoryId" label={t('Repository')} extra={t('Leave empty to apply to all repositories')}>
            <Select
              allowClear
              placeholder={t('All repositories (global)')}
              options={repos.map((r: any) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
          <Form.Item name="aiEmployeeUsername" label={t('AI Employee')} rules={[{ required: true }]}>
            <AIEmployeeSelect placeholder={t('Select an AI employee')} />
          </Form.Item>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="llmService" label={t('LLM Service (optional)')} style={{ flex: 1, marginRight: 8 }}>
              <LLMServiceSelect placeholder={t('Override flow LLM service')} />
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(prevValues, currentValues) => prevValues.llmService !== currentValues.llmService}
            >
              {({ getFieldValue }) => {
                const llmService = getFieldValue('llmService');
                return (
                  <Form.Item name="model" label={t('Model (optional)')} style={{ flex: 1 }}>
                    {llmService ? (
                      <LLMModelSelect llmService={llmService} placeholder={t('Override LLM model')} />
                    ) : (
                      <Input placeholder={t('Select an LLM service first')} disabled />
                    )}
                  </Form.Item>
                );
              }}
            </Form.Item>
          </Space.Compact>
          <Form.Item
            name="triggerMode"
            label={t('Trigger Mode')}
            rules={[{ required: true }]}
            extra={t('Auto modes require enabling Auto Review on the repository')}
          >
            <Select
              options={[
                { value: 'manual', label: t('Manual') },
                { value: 'onMergeRequestCreated', label: t('On Merge Request Created') },
                { value: 'both', label: t('Both') },
              ]}
            />
          </Form.Item>
          <Form.Item name="postMode" label={t('Post Mode')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'auto', label: t('Auto post to MR') },
                { value: 'manual', label: t('Manual approval before posting') },
                { value: 'disabled', label: t('Do not post') },
              ]}
            />
          </Form.Item>
          <Form.Item name="branchFilter" label={t('Branch Filter (regex, optional)')}>
            <Input placeholder="^(feature|hotfix)/.*$" />
          </Form.Item>
          <Form.Item name="instructions" label={t('Additional Instructions (optional)')}>
            <Input.TextArea rows={4} placeholder={t('Extra guidance appended to every review prompt')} />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
