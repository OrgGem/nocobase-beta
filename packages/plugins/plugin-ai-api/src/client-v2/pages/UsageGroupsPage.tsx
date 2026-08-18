import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
  Row,
  Col,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';

interface UserSummary {
  id: string | number;
  nickname?: string;
  username?: string;
  email?: string;
}

interface EnabledLlmService {
  llmService: string;
  llmServiceTitle?: string;
  enabledModels?: { label: string; value: string }[];
}

interface UsageGroup {
  id: string | number;
  name: string;
  isDefault: boolean;
  quotaMode: 'share' | 'per_user';
  rateLimitPerMinute: number;
  enabled: boolean;
  periodType: 'daily' | 'monthly';
  timezone: string;
  requestLimit?: string;
  totalTokenLimit?: string;
  costLimit?: string;
  currency: string;
  rejectUnpricedModel: boolean;
  missingUsageBehavior: 'allow' | 'use_reserved';
  contextOverflowBehavior: 'reject' | 'truncate';
  allowedLlmServices: string[];
  allowAllModels: boolean;
  allowedModels: string[];
}

interface GroupMember {
  id: string | number;
  groupId: string | number;
  userId: string | number;
  user?: UserSummary;
}

export default function UsageGroupsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<UsageGroup>();
  const [memberForm] = Form.useForm<{ userId: string | number }>();
  const selectedServices = Form.useWatch('allowedLlmServices', form);
  const allowAllModels = Form.useWatch('allowAllModels', form);
  const [rows, setRows] = useState<UsageGroup[]>([]);
  const [services, setServices] = useState<EnabledLlmService[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<UsageGroup>();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [unassignedUsers, setUnassignedUsers] = useState<UserSummary[]>([]);
  const [searchUserKeyword, setSearchUserKeyword] = useState('');
  const [searchedGroup, setSearchedGroup] = useState<UsageGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await ctx.api.request({
        url: 'aiApiUsageGroups:list',
        method: 'get',
        params: { pageSize: 200, sort: '-updatedAt' },
      });
      setRows(unwrapData<UsageGroup[]>(response, []));
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
    try {
      const servicesResponse = await ctx.api.request({ url: 'ai:listAllEnabledModels', method: 'get' });
      setServices(unwrapData<EnabledLlmService[]>(servicesResponse, []));
    } catch (error) {
      setServices([]);
      message.error(`${t('Failed to load models')}: ${errorMessage(error)}`);
    }
  }, [ctx.api, t]);

  const loadMembers = useCallback(
    async (groupId: string | number) => {
      setMembersLoading(true);
      try {
        const response = await ctx.api.request({
          url: 'aiApiGroupMembers:list',
          method: 'get',
          params: { filter: { groupId }, pageSize: 1000, appends: ['user'] },
        });
        setMembers(unwrapData<GroupMember[]>(response, []));
      } catch (error) {
        message.error(errorMessage(error));
      } finally {
        setMembersLoading(false);
      }
    },
    [ctx.api],
  );

  const loadUnassignedUsers = useCallback(
    async (keyword?: string) => {
      try {
        const response = await ctx.api.request({
          url: 'aiApiUsageGroups:listUnassignedUsers',
          method: 'get',
          params: { keyword, pageSize: 100 },
        });
        const rows = unwrapData<UserSummary[]>(response, []);
        setUnassignedUsers(rows);
      } catch (error) {
        message.error(errorMessage(error));
      }
    },
    [ctx.api],
  );

  useEffect(() => {
    load();
  }, [load]);

  const showCreate = () => {
    setEditing(undefined);
    setMembers([]);
    form.setFieldsValue({
      name: '',
      quotaMode: 'per_user',
      rateLimitPerMinute: 60,
      enabled: true,
      periodType: 'monthly',
      timezone: 'UTC',
      currency: 'USD',
      rejectUnpricedModel: true,
      missingUsageBehavior: 'use_reserved',
      contextOverflowBehavior: 'reject',
      allowedLlmServices: [],
      allowAllModels: true,
      allowedModels: [],
    } as UsageGroup);
    setOpen(true);
  };

  const showEdit = async (record: UsageGroup) => {
    setEditing(record);
    form.setFieldsValue(record);
    setOpen(true);
    await loadMembers(record.id);
    if (!record.isDefault) {
      await loadUnassignedUsers();
    }
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await ctx.api.request({
        url: editing ? `aiApiUsageGroups:update/${editing.id}` : 'aiApiUsageGroups:create',
        method: 'post',
        data: values,
      });
      message.success(t('Saved successfully'));
      setOpen(false);
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (record: UsageGroup) => {
    try {
      await ctx.api.request({
        url: `aiApiUsageGroups:destroy/${record.id}`,
        method: 'post',
      });
      message.success(t('Deleted successfully'));
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const addMember = async () => {
    if (!editing) return;
    const values = await memberForm.validateFields();
    try {
      await ctx.api.request({
        url: 'aiApiUsageGroups:addMember',
        method: 'post',
        data: { groupId: editing.id, userId: values.userId },
      });
      message.success(t('Member added'));
      memberForm.resetFields();
      await loadMembers(editing.id);
      await loadUnassignedUsers();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const removeMember = async (member: GroupMember) => {
    try {
      await ctx.api.request({
        url: 'aiApiUsageGroups:removeMember',
        method: 'post',
        data: { groupId: member.groupId, userId: member.userId },
      });
      message.success(t('Member removed'));
      if (editing) {
        await loadMembers(editing.id);
        await loadUnassignedUsers();
      }
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const searchGroupByUser = async () => {
    if (!searchUserKeyword.trim()) return;
    try {
      const response = await ctx.api.request({
        url: 'aiApiUsageGroups:searchUsers',
        method: 'get',
        params: { keyword: searchUserKeyword, pageSize: 1 },
      });
      const users = unwrapData<UserSummary[]>(response, []);
      if (users.length === 0) {
        message.warning(t('User not found'));
        setSearchedGroup(null);
        return;
      }
      const groupResponse = await ctx.api.request({
        url: 'aiApiUsageGroups:getByUser',
        method: 'get',
        params: { userId: users[0].id },
      });
      setSearchedGroup(unwrapData<UsageGroup>(groupResponse, null));
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const userLabel = (user?: UserSummary) => user?.nickname || user?.username || user?.email || String(user?.id ?? '');

  const serviceOptions = useMemo(
    () =>
      services.map((service) => ({ label: service.llmServiceTitle || service.llmService, value: service.llmService })),
    [services],
  );

  // Model IDs are "serviceName/modelId", matching what the gateway enforces and what
  // GET /v1/models returns, so admins never have to type them by hand.
  const modelOptions = useMemo(() => {
    const picked = new Set(selectedServices || []);
    return services
      .filter((service) => picked.has(service.llmService))
      .flatMap((service) =>
        (service.enabledModels || []).map((model) => ({
          label: `${service.llmServiceTitle || service.llmService} / ${model.label || model.value}`,
          value: `${service.llmService}/${model.value}`,
        })),
      );
  }, [services, selectedServices]);

  const serviceLabel = (name: string) => serviceOptions.find((option) => option.value === name)?.label || name;

  const columns: ColumnsType<UsageGroup> = [
    { title: t('Name'), dataIndex: 'name', key: 'name', width: 180 },
    {
      title: t('Default'),
      dataIndex: 'isDefault',
      key: 'isDefault',
      width: 100,
      render: (isDefault: boolean) => (isDefault ? <Tag color="blue">{t('Default')}</Tag> : null),
    },
    { title: t('Mode'), dataIndex: 'quotaMode', key: 'quotaMode', width: 120 },
    { title: t('Rate limit/min'), dataIndex: 'rateLimitPerMinute', key: 'rateLimitPerMinute', width: 140 },
    {
      title: t('Model access'),
      key: 'modelAccess',
      width: 240,
      render: (_, record) => {
        const groupServices = record.allowedLlmServices || [];
        const groupModels = record.allowedModels || [];
        const openServices = groupServices.length === 0;
        const openModels = record.allowAllModels !== false;
        if (openServices && openModels) {
          return <Tag color="blue">{t('All models')}</Tag>;
        }
        return (
          <Space size={[0, 4]} wrap>
            <Tag>{openServices ? t('All services') : groupServices.map((name) => serviceLabel(name)).join(', ')}</Tag>
            <Tag color={openModels ? 'blue' : undefined}>
              {openModels ? t('All models') : groupModels.length ? groupModels.join(', ') : t('No models')}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: t('Status'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'default'}>{enabled ? t('Enabled') : t('Disabled')}</Tag>
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space size={0}>
          <Button type="link" onClick={() => showEdit(record)}>
            {t('Edit')}
          </Button>
          {!record.isDefault && (
            <Popconfirm title={t('Delete this group?')} onConfirm={() => remove(record)}>
              <Button type="link" danger>
                {t('Delete')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const memberColumns: ColumnsType<GroupMember> = [
    {
      title: t('User'),
      key: 'user',
      render: (_, record) => userLabel(record.user) || String(record.userId),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Popconfirm title={t('Remove member?')} onConfirm={() => removeMember(record)}>
          <Button type="link" danger>
            {t('Remove')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card
      title={t('Usage groups')}
      extra={
        <Button type="primary" onClick={showCreate}>
          {t('Add group')}
        </Button>
      }
    >
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Input.Search
            placeholder={t('Search group by user')}
            value={searchUserKeyword}
            onChange={(e) => setSearchUserKeyword(e.target.value)}
            onSearch={searchGroupByUser}
            enterButton
          />
        </Col>
        <Col span={12}>
          {searchedGroup && (
            <Tag color="blue">
              {t('User belongs to')}: {searchedGroup.name}
            </Tag>
          )}
        </Col>
      </Row>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} scroll={{ x: 700 }} />
      <Modal
        title={editing ? t('Edit group') : t('Add group')}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        destroyOnClose
        width={720}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input disabled={editing?.isDefault} />
          </Form.Item>
          <Form.Item name="quotaMode" label={t('Mode')} rules={[{ required: true }]}>
            <Select
              disabled={Boolean(editing)}
              options={[
                { label: t('Share'), value: 'share' },
                { label: t('Per user'), value: 'per_user' },
              ]}
            />
          </Form.Item>
          <Form.Item name="rateLimitPerMinute" label={t('Rate limit per minute')} rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="periodType" label={t('Period')} rules={[{ required: true }]}>
            <Select
              options={[
                { label: t('Daily'), value: 'daily' },
                { label: t('Monthly'), value: 'monthly' },
              ]}
            />
          </Form.Item>
          <Form.Item name="timezone" label={t('Timezone')} rules={[{ required: true }]}>
            <Input placeholder="UTC" />
          </Form.Item>
          <Form.Item name="requestLimit" label={t('Request limit')}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="totalTokenLimit" label={t('Token limit')}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="costLimit" label={t('Cost limit')}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="currency" label={t('Currency')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="rejectUnpricedModel" label={t('Reject unpriced models')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="missingUsageBehavior" label={t('Missing usage behavior')} rules={[{ required: true }]}>
            <Select
              options={[
                { label: t('Use reserved estimate'), value: 'use_reserved' },
                { label: t('Allow without token charge'), value: 'allow' },
              ]}
            />
          </Form.Item>
          <Form.Item name="contextOverflowBehavior" label={t('Context overflow behavior')} rules={[{ required: true }]}>
            <Select
              options={[
                { label: t('Reject request'), value: 'reject' },
                { label: t('Truncate oldest conversation turns'), value: 'truncate' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="allowedLlmServices"
            label={t('Allowed LLM services')}
            extra={t('Leave empty to allow every service enabled in the general configuration.')}
          >
            <Select mode="multiple" allowClear showSearch optionFilterProp="label" options={serviceOptions} />
          </Form.Item>
          <Form.Item name="allowAllModels" label={t('Allow all models')} valuePropName="checked">
            <Switch />
          </Form.Item>
          {allowAllModels === false && (
            <Form.Item name="allowedModels" label={t('Allowed models')}>
              <Select mode="multiple" allowClear showSearch optionFilterProp="label" options={modelOptions} />
            </Form.Item>
          )}
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
        {editing && (
          <Card title={t('Members')} size="small" style={{ marginTop: 24 }}>
            {editing.isDefault ? (
              <>
                <Alert
                  type="info"
                  showIcon
                  message={t(
                    'Users who do not belong to any other group automatically use this default group — no need to add members.',
                  )}
                  style={{ marginBottom: members.length > 0 ? 12 : 0 }}
                />
                {members.length > 0 && (
                  <Table
                    rowKey="id"
                    columns={memberColumns}
                    dataSource={members}
                    loading={membersLoading}
                    pagination={false}
                    size="small"
                  />
                )}
              </>
            ) : (
              <>
                <Form form={memberForm} layout="inline">
                  <Form.Item name="userId" label={t('User')} rules={[{ required: true }]} style={{ minWidth: 240 }}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      options={unassignedUsers.map((user) => ({ label: userLabel(user), value: user.id }))}
                      onFocus={() => loadUnassignedUsers()}
                    />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" onClick={addMember}>
                      {t('Add member')}
                    </Button>
                  </Form.Item>
                </Form>
                <Table
                  rowKey="id"
                  columns={memberColumns}
                  dataSource={members}
                  loading={membersLoading}
                  pagination={false}
                  size="small"
                />
              </>
            )}
          </Card>
        )}
      </Modal>
    </Card>
  );
}
