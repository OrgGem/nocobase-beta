import React, { useState } from 'react';
import { Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import { unwrapListMeta, unwrapRecords } from './api';
import { MarkdownSkillDetailDrawer } from './MarkdownSkillDetail';

type MarkdownSkill = {
  id: string;
  namespace: string;
  slug: string;
  displayName: string;
  description?: string;
  content: string;
  tags?: string[];
  visibility: 'private' | 'shared';
  status: 'draft' | 'published';
  packageId?: string;
  updatedAt?: string;
};

type SkillFormValues = {
  namespace: string;
  slug: string;
  displayName: string;
  description: string;
  content: string;
  tags: string[];
  visibility: 'private' | 'shared';
};

export default function MarkdownSkillsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canMarkdown } = useSkillRegistryPermissions();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MarkdownSkill | null>(null);
  const [viewSkillId, setViewSkillId] = useState<string | undefined>();
  const [publishSkill, setPublishSkill] = useState<MarkdownSkill | null>(null);
  const [shareSkill, setShareSkill] = useState<MarkdownSkill | null>(null);
  const [shareSearch, setShareSearch] = useState('');
  const [form] = Form.useForm<SkillFormValues>();
  const [publishForm] = Form.useForm<{ version: string; channel: string }>();
  const pageSize = 50;

  const request = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistryAdmin:listMyMarkdownSkills',
        method: 'post',
        data: {
          page,
          pageSize,
        },
      }),
    { refreshDeps: [page] },
  );

  const skills = unwrapRecords<MarkdownSkill>(request.data);
  const total = unwrapListMeta(request.data)?.count ?? skills.length;

  const refresh = async () => {
    await request.refreshAsync();
  };

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      namespace: '',
      slug: '',
      displayName: '',
      description: '',
      content: '',
      tags: [],
      visibility: 'shared',
    });
    setOpen(true);
  };

  const openEdit = (skill: MarkdownSkill) => {
    setEditing(skill);
    form.setFieldsValue({
      namespace: skill.namespace,
      slug: skill.slug,
      displayName: skill.displayName,
      description: skill.description || '',
      content: skill.content,
      tags: skill.tags || [],
      visibility: skill.visibility || 'shared',
    });
    setOpen(true);
  };

  const saveSkill = async () => {
    if (!canMarkdown) {
      return;
    }
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        tags: values.tags || [],
      };
      if (editing) {
        await ctx.api.request({
          url: 'skillRegistryAdmin:updateMarkdown',
          method: 'post',
          params: { filterByTk: editing.id },
          data: payload,
        });
      } else {
        await ctx.api.request({
          url: 'skillRegistryAdmin:createMarkdown',
          method: 'post',
          data: payload,
        });
      }
      ctx.message.success(editing ? t('Skill updated') : t('Skill created'));
      setOpen(false);
      await refresh();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  const handlePublish = async () => {
    if (!publishSkill) {
      return;
    }
    try {
      const values = await publishForm.validateFields();
      await ctx.api.request({
        url: 'skillRegistryAdmin:publishMarkdown',
        method: 'post',
        data: { markdownSkillId: publishSkill.id, version: values.version, channel: values.channel || 'stable' },
      });
      ctx.message.success(t('Skill published'));
      setPublishSkill(null);
      await refresh();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  const usersRequest = useRequest(
    () =>
      ctx.api.request({
        url: 'users:list',
        method: 'get',
        params: {
          filter: shareSearch
            ? { $or: [{ nickname: { $includes: shareSearch } }, { email: { $includes: shareSearch } }] }
            : {},
          pageSize: 200,
        },
      }),
    { refreshDeps: [shareSearch, shareSkill?.id] },
  );

  const sharesRequest = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistryAdmin:listMarkdownShares',
        method: 'post',
        data: { markdownSkillId: shareSkill?.id },
      }),
    { ready: Boolean(shareSkill), refreshDeps: [shareSkill?.id] },
  );

  const sharedUserIds = new Set(
    unwrapRecords<{ userId: string | number }>(sharesRequest.data).map((item) => String(item.userId)),
  );

  const shareWithUser = async (userId: string | number) => {
    if (!shareSkill) {
      return;
    }
    try {
      await ctx.api.request({
        url: 'skillRegistryAdmin:shareMarkdown',
        method: 'post',
        data: { markdownSkillId: shareSkill.id, userId },
      });
      ctx.message.success(t('Shared'));
      await sharesRequest.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  const unshareUser = async (userId: string | number) => {
    if (!shareSkill) {
      return;
    }
    try {
      await ctx.api.request({
        url: 'skillRegistryAdmin:unshareMarkdown',
        method: 'post',
        data: { markdownSkillId: shareSkill.id, userId },
      });
      ctx.message.success(t('Unshared'));
      await sharesRequest.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  const columns: TableColumnsType<MarkdownSkill> = [
    {
      title: t('Name'),
      key: 'displayName',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.displayName}</Typography.Text>
          <Typography.Text type="secondary">{`${record.namespace}/${record.slug}`}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Status'),
      key: 'status',
      render: (_, record) => <Tag>{record.status}</Tag>,
    },
    {
      title: t('Visibility'),
      key: 'visibility',
      render: (_, record) => <Tag>{record.visibility}</Tag>,
    },
    { title: t('Updated'), key: 'updatedAt', render: (_, record) => record.updatedAt || '—' },
    {
      title: t('Run'),
      key: 'actions',
      render: (_, record) => (
        <Space wrap>
          <Button onClick={() => setViewSkillId(record.id)}>{t('View')}</Button>
          <Button onClick={() => openEdit(record)}>{t('Edit')}</Button>
          <Button
            onClick={() => {
              publishForm.setFieldsValue({ version: '', channel: 'stable' });
              setPublishSkill(record);
            }}
          >
            {t('Publish')}
          </Button>
          {record.visibility === 'shared' ? <Button onClick={() => setShareSkill(record)}>{t('Share')}</Button> : null}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('Markdown skills')}
      extra={
        <Space>
          <Button onClick={refresh} loading={request.loading}>
            {t('Refresh')}
          </Button>
          {canMarkdown ? (
            <Button type="primary" onClick={openCreate}>
              {t('Create skill')}
            </Button>
          ) : null}
        </Space>
      }
    >
      <Table
        aria-label={t('Markdown skills')}
        rowKey="id"
        loading={request.loading}
        dataSource={skills}
        pagination={{ current: page, pageSize, total, onChange: setPage }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
        columns={columns}
      />
      <Modal
        title={editing ? t('Edit skill') : t('Create skill')}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={saveSkill}
        okText={t('Save')}
        cancelText={t('Cancel')}
        width="min(900px, 95vw)"
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            namespace: '',
            slug: '',
            displayName: '',
            description: '',
            content: '',
            tags: [],
            visibility: 'shared',
          }}
        >
          <Form.Item name="namespace" label={t('Namespace')} rules={[{ required: true }]}>
            <Input placeholder="acme" />
          </Form.Item>
          <Form.Item name="slug" label={t('Slug')} rules={[{ required: true }]}>
            <Input placeholder="my-skill" />
          </Form.Item>
          <Form.Item name="displayName" label={t('Display name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="content"
            label={t('Markdown content')}
            rules={[{ required: true }]}
            extra={t('Only markdown content is accepted.')}
          >
            <Input.TextArea rows={10} />
          </Form.Item>
          <Form.Item name="tags" label={t('Tags')}>
            <Select mode="tags" />
          </Form.Item>
          <Form.Item name="visibility" label={t('Visibility')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'shared', label: t('Shared') },
                { value: 'private', label: t('Private') },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('Publish skill')}
        open={Boolean(publishSkill)}
        onCancel={() => setPublishSkill(null)}
        onOk={handlePublish}
        okText={t('Publish')}
        cancelText={t('Cancel')}
      >
        <Form form={publishForm} layout="vertical" initialValues={{ version: '', channel: 'stable' }}>
          <Form.Item name="version" label={t('Version')} rules={[{ required: true }]}>
            <Input placeholder="1.0.0" autoFocus />
          </Form.Item>
          <Form.Item name="channel" label={t('Channel')} rules={[{ required: true }]}>
            <Input placeholder="stable" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('Share skill')}
        open={Boolean(shareSkill)}
        onCancel={() => setShareSkill(null)}
        footer={null}
        width="min(900px, 95vw)"
      >
        {shareSkill ? (
          <>
            <Input.Search
              placeholder={t('Search users')}
              value={shareSearch}
              onChange={(event) => setShareSearch(event.target.value)}
              style={{ marginBottom: 16 }}
            />
            <Table
              aria-label={t('Users')}
              rowKey="id"
              loading={usersRequest.loading || sharesRequest.loading}
              dataSource={unwrapRecords<{ id: string | number; nickname?: string; email?: string; username?: string }>(
                usersRequest.data,
              )}
              pagination={false}
              scroll={{ y: 300 }}
              locale={{ emptyText: t('No data') }}
              columns={[
                {
                  title: t('User'),
                  key: 'user',
                  render: (_, record) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text>{record.nickname || record.username || record.id}</Typography.Text>
                      {record.email ? <Typography.Text type="secondary">{record.email}</Typography.Text> : null}
                    </Space>
                  ),
                },
                {
                  title: t('Actions'),
                  key: 'actions',
                  render: (_, record) => {
                    const isShared = sharedUserIds.has(String(record.id));
                    return isShared ? (
                      <Button onClick={() => unshareUser(record.id)}>{t('Unshare')}</Button>
                    ) : (
                      <Button onClick={() => shareWithUser(record.id)}>{t('Share')}</Button>
                    );
                  },
                },
              ]}
            />
          </>
        ) : null}
      </Modal>
      <MarkdownSkillDetailDrawer skillId={viewSkillId} onClose={() => setViewSkillId(undefined)} />
    </Card>
  );
}
