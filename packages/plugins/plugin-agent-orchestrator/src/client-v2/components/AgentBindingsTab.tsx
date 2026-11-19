/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo, useRef, useState } from 'react';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Alert,
  Card,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { AIEmployeeSelect } from './AIEmployeeSelect';
import { useAIEmployees } from './AIEmployeesContext';
import { useApiClient, useRequest } from '../hooks/useApiRequest';
import { useT } from '../skill-hub/locale';

type BindingRecord = {
  id: string | number;
  leaderUsername: string;
  subAgentUsername: string;
  harnessTag?: string;
  enabled?: boolean;
  maxDepth?: number;
  timeout?: number;
  routingEnabled?: boolean;
  routingRole?: 'specialist' | 'worker' | null;
  routingPrompt?: string | null;
  llmService?: string | null;
  model?: string | null;
};

type ProfileRecord = { tag: string; title?: string; enabled?: boolean };
type ModelService = {
  llmService: string;
  llmServiceTitle?: string;
  enabledModels: Array<{ value: string; label?: string }>;
};
type RoutingPreview = {
  username: string;
  role: 'specialist' | 'worker';
  model: { llmService: string; model: string };
  fallback: boolean;
  profile: { tag: string; version: number };
  specialist?: {
    username: string;
    model: { llmService: string; model: string };
    fallback: boolean;
    profile: { tag: string; version: number };
  };
};

type BindingForm = Omit<BindingRecord, 'id'>;

function rowsFromResponse<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const response = value as { data?: unknown } | undefined;
  return Array.isArray(response?.data) ? (response.data as T[]) : [];
}

function errorText(error: unknown): string {
  const response = error as { response?: { data?: { errors?: Array<{ message?: string }> } }; message?: string };
  return response?.response?.data?.errors?.[0]?.message || response?.message || 'Unknown error';
}

export const AgentBindingsTab: React.FC = () => {
  const api = useApiClient();
  const t = useT();
  const { employeeMap } = useAIEmployees();
  const [form] = Form.useForm<BindingForm>();
  const routingEnabled = Form.useWatch('routingEnabled', form);
  const llmService = Form.useWatch('llmService', form);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<BindingRecord | null>(null);
  const [previewSessionId, setPreviewSessionId] = useState('');
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewRequest = useRef(0);

  const bindingsRequest = useRequest({
    url: 'orchestratorConfig:list',
    params: { sort: ['leaderUsername', 'subAgentUsername'], pageSize: 200 },
  });
  const profilesRequest = useRequest({
    url: 'agentHarnessProfiles:list',
    params: { sort: ['tag'], pageSize: 100 },
  });
  const modelsRequest = useRequest({ url: 'ai:listAllEnabledModels' });

  const bindings = useMemo(() => rowsFromResponse<BindingRecord>(bindingsRequest.data), [bindingsRequest.data]);
  const profiles = useMemo(() => rowsFromResponse<ProfileRecord>(profilesRequest.data), [profilesRequest.data]);
  const services = useMemo(() => rowsFromResponse<ModelService>(modelsRequest.data), [modelsRequest.data]);
  const selectedService = services.find((service) => service.llmService === llmService);
  const profileOptions = useMemo(
    () =>
      profiles
        .filter((profile) => profile.enabled !== false)
        .map((profile) => ({
          label: profile.title ? `${profile.title} (${profile.tag})` : profile.tag,
          value: profile.tag,
        })),
    [profiles],
  );

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditing(null);
    form.resetFields();
    setPreview(null);
    setPreviewError('');
    previewRequest.current += 1;
    setPreviewLoading(false);
    setPreviewSessionId('');
  };

  const openDrawer = (binding?: BindingRecord) => {
    setEditing(binding || null);
    form.resetFields();
    setPreview(null);
    setPreviewError('');
    previewRequest.current += 1;
    setPreviewLoading(false);
    setPreviewSessionId('');
    form.setFieldsValue(
      binding || {
        enabled: true,
        harnessTag: 'default',
        maxDepth: 1,
        timeout: 120000,
        routingEnabled: false,
      },
    );
    setDrawerOpen(true);
  };

  const previewBinding = async () => {
    if (!editing || !previewSessionId.trim()) return;
    setPreviewLoading(true);
    setPreview(null);
    setPreviewError('');
    const requestId = ++previewRequest.current;
    try {
      const response = await api.request({
        url: 'agentHierarchy:preview',
        method: 'post',
        data: {
          sessionId: previewSessionId.trim(),
          username: editing.subAgentUsername,
          ...(editing.routingRole === 'worker' ? { specialistUsername: editing.leaderUsername } : {}),
        },
      });
      const result = response?.data as { data?: { data?: RoutingPreview } } | undefined;
      if (previewRequest.current === requestId) setPreview(result?.data?.data || null);
    } catch (error) {
      if (previewRequest.current === requestId) setPreviewError(t(errorText(error)));
    } finally {
      if (previewRequest.current === requestId) setPreviewLoading(false);
    }
  };

  const saveBinding = async (values: BindingForm) => {
    const payload = {
      ...values,
      leaderUsername: values.leaderUsername?.trim(),
      subAgentUsername: values.subAgentUsername?.trim(),
      harnessTag: values.harnessTag || 'default',
      enabled: values.enabled !== false,
      routingEnabled: values.routingEnabled === true,
      ...(values.routingEnabled
        ? {
            routingRole: values.routingRole,
            routingPrompt: values.routingPrompt?.trim() || null,
            llmService: values.llmService || null,
            model: values.model || null,
          }
        : {}),
    };
    try {
      if (editing) {
        await api.request({
          url: 'orchestratorConfig:update',
          method: 'put',
          params: { filterByTk: editing.id },
          data: payload,
        });
        message.success(t('Agent binding updated'));
      } else {
        await api.request({ url: 'orchestratorConfig:create', method: 'post', data: payload });
        message.success(t('Agent binding created'));
      }
      closeDrawer();
      bindingsRequest.refresh();
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorText(error) }));
    }
  };

  const removeBinding = async (id: string | number) => {
    try {
      await api.request({
        url: 'orchestratorConfig:destroy',
        method: 'delete',
        params: { filterByTk: id },
      });
      message.success(t('Agent binding deleted'));
      bindingsRequest.refresh();
    } catch (error) {
      message.error(t('Delete failed: {{message}}', { message: errorText(error) }));
    }
  };

  const columns = [
    {
      title: t('Leader (Orchestrator)'),
      dataIndex: 'leaderUsername',
      key: 'leaderUsername',
      render: (username: string) => <Tag color="blue">{employeeMap.get(username) || username}</Tag>,
    },
    {
      title: t('Sub-Agent'),
      dataIndex: 'subAgentUsername',
      key: 'subAgentUsername',
      render: (username: string) => <Tag color="green">{employeeMap.get(username) || username}</Tag>,
    },
    {
      title: t('Policy Profile'),
      dataIndex: 'harnessTag',
      key: 'harnessTag',
      render: (tag: string) => <Tag color="purple">{tag || 'default'}</Tag>,
    },
    { title: t('Max Delegation Depth'), dataIndex: 'maxDepth', key: 'maxDepth', width: 140 },
    {
      title: t('Hierarchical routing'),
      dataIndex: 'routingRole',
      key: 'routingRole',
      render: (role: BindingRecord['routingRole'], binding: BindingRecord) =>
        binding.routingEnabled ? (
          <Tag color="blue">{role === 'specialist' ? t('Specialist') : role === 'worker' ? t('Worker') : '-'}</Tag>
        ) : (
          <Tag>{t('Disabled')}</Tag>
        ),
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean, binding: BindingRecord) => (
        <Switch
          size="small"
          checked={enabled !== false}
          aria-label={t('Enabled')}
          onChange={async (checked) => {
            await api.request({
              url: 'orchestratorConfig:update',
              method: 'put',
              params: { filterByTk: binding.id },
              data: { enabled: checked },
            });
            bindingsRequest.refresh();
          }}
        />
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 150,
      render: (_: unknown, binding: BindingRecord) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openDrawer(binding)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this binding?')} onConfirm={() => removeBinding(binding.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card bordered={false}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <Typography.Text type="secondary">
            {t('Bind employees to profiles and opt in to hierarchical delegation.')}
          </Typography.Text>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
            {t('New Agent Binding')}
          </Button>
        </div>
        <Table
          rowKey="id"
          dataSource={bindings}
          loading={bindingsRequest.loading || profilesRequest.loading}
          columns={columns}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      </Space>

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        width={560}
        title={editing ? t('Edit Agent Binding') : t('New Agent Binding')}
        extra={
          <Space>
            <Button onClick={closeDrawer}>{t('Cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('Save')}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={saveBinding}>
          <Form.Item
            label={t('Leader (Orchestrator)')}
            name="leaderUsername"
            rules={[{ required: true, message: t('Leader is required') }]}
          >
            <AIEmployeeSelect placeholder={t('Select leader')} />
          </Form.Item>
          <Form.Item
            label={t('Sub-Agent')}
            name="subAgentUsername"
            rules={[{ required: true, message: t('Sub-agent is required') }]}
          >
            <AIEmployeeSelect placeholder={t('Select sub-agent')} />
          </Form.Item>
          <Form.Item
            label={t('Policy Profile')}
            name="harnessTag"
            rules={[{ required: true, message: t('Policy profile is required') }]}
          >
            <Select options={profileOptions} placeholder={t('Select policy profile')} />
          </Form.Item>
          <Form.Item label={t('Max Delegation Depth')} name="maxDepth">
            <InputNumber min={1} max={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('Timeout (ms)')} name="timeout">
            <InputNumber min={1000} max={600000} step={1000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label={t('Enable hierarchical routing')}
            name="routingEnabled"
            valuePropName="checked"
            extra={t('Applies to delegation through the hierarchical routing tool.')}
          >
            <Switch aria-label={t('Enable hierarchical routing')} />
          </Form.Item>
          {routingEnabled && (
            <>
              <Form.Item
                label={t('Target role')}
                name="routingRole"
                rules={[{ required: true, message: t('Choose a routing role for the target employee.') }]}
              >
                <Select
                  options={[
                    { value: 'specialist', label: t('Specialist') },
                    { value: 'worker', label: t('Worker') },
                  ]}
                />
              </Form.Item>
              <Form.Item
                label={t('When to delegate')}
                name="routingPrompt"
                extra={t('Describe the tasks this employee is suited to handle.')}
              >
                <Input.TextArea maxLength={4000} showCount rows={3} />
              </Form.Item>
              <Form.Item
                label={t('LLM service override')}
                name="llmService"
                dependencies={['model']}
                extra={t('Leave both model fields empty to use the target employee model.')}
                rules={[
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      return Boolean(value) === Boolean(getFieldValue('model'))
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('Select both an LLM service and a model, or leave both empty.')));
                    },
                  }),
                ]}
              >
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  loading={modelsRequest.loading}
                  options={services.map((service) => ({
                    value: service.llmService,
                    label: service.llmServiceTitle || service.llmService,
                  }))}
                  onChange={() => form.setFieldValue('model', undefined)}
                />
              </Form.Item>
              <Form.Item
                label={t('Model override')}
                name="model"
                dependencies={['llmService']}
                rules={[
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      return Boolean(value) === Boolean(getFieldValue('llmService'))
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('Select both an LLM service and a model, or leave both empty.')));
                    },
                  }),
                ]}
              >
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  loading={modelsRequest.loading}
                  disabled={!llmService}
                  options={(selectedService?.enabledModels || []).map((model) => ({
                    value: model.value,
                    label: model.label || model.value,
                  }))}
                />
              </Form.Item>
              {modelsRequest.error && (
                <Typography.Text type="danger">{t('Unable to load enabled models.')}</Typography.Text>
              )}
            </>
          )}
          <Form.Item label={t('Enabled')} name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
        {editing?.routingEnabled && (editing.routingRole === 'specialist' || editing.routingRole === 'worker') && (
          <>
            <Divider orientation="left">{t('Preview effective routing')}</Divider>
            <Typography.Paragraph type="secondary">
              {t('Preview uses the saved binding, published profile and a conversation owned by your user.')}
            </Typography.Paragraph>
            {editing.routingRole === 'worker' && (
              <>
                <Typography.Paragraph type="secondary">
                  {t('The conversation must belong to an orchestrator bound to this worker’s specialist.')}
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary">
                  {t('Preview does not check worker tools that depend on a child session.')}
                </Typography.Paragraph>
              </>
            )}
            <Input
              value={previewSessionId}
              onChange={(event) => {
                setPreviewSessionId(event.target.value);
                setPreview(null);
                setPreviewError('');
                previewRequest.current += 1;
                setPreviewLoading(false);
              }}
              aria-label={t('Conversation ID')}
              placeholder={t('Conversation ID')}
            />
            <Button
              style={{ marginTop: 12 }}
              loading={previewLoading}
              disabled={!previewSessionId.trim()}
              onClick={previewBinding}
            >
              {t('Preview effective routing')}
            </Button>
            {previewError && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 12 }}
                message={t('Preview failed: {{message}}', { message: previewError })}
              />
            )}
            {preview && (
              <>
                {preview.specialist && (
                  <Descriptions title={t('Specialist')} size="small" column={1} style={{ marginTop: 12 }}>
                    <Descriptions.Item label={t('Sub-Agent')}>{preview.specialist.username}</Descriptions.Item>
                    <Descriptions.Item label={t('Policy Profile')}>
                      {preview.specialist.profile.tag} v{preview.specialist.profile.version}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('Effective model')}>
                      {preview.specialist.model.llmService} / {preview.specialist.model.model}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('Fallback model selected')}>
                      {preview.specialist.fallback ? t('Yes') : t('No')}
                    </Descriptions.Item>
                  </Descriptions>
                )}
                <Descriptions
                  title={preview.specialist ? t('Worker') : undefined}
                  size="small"
                  column={1}
                  style={{ marginTop: 12 }}
                >
                  <Descriptions.Item label={t('Sub-Agent')}>{preview.username}</Descriptions.Item>
                  <Descriptions.Item label={t('Policy Profile')}>
                    {preview.profile.tag} v{preview.profile.version}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Effective model')}>
                    {preview.model.llmService} / {preview.model.model}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Fallback model selected')}>
                    {preview.fallback ? t('Yes') : t('No')}
                  </Descriptions.Item>
                </Descriptions>
              </>
            )}
          </>
        )}
      </Drawer>
    </Card>
  );
};
