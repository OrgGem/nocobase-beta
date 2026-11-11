/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
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
import type { ColumnsType } from 'antd/es/table';
import { useApiClient, useRequest } from '../hooks/useApiRequest';
import { useT } from '../skill-hub/locale';
import { useAIEmployees } from './AIEmployeesContext';

type PolicyScope = 'department' | 'user' | 'employee';
type PolicySettings = {
  instruction?: string;
  systemPrompt?: string | null;
  allowedModels?: string[];
  allow?: boolean;
  maxMonthlyTokens?: number | null;
  maxMonthlyCost?: number | null;
};
type PolicyVersion = {
  id: string | number;
  policyId: string | number;
  version: number;
  revision?: number;
  status: 'draft' | 'published';
  settings?: PolicySettings;
  publishedAt?: string | null;
  publishedById?: string | number | null;
};
type PolicyRecord = {
  id: string | number;
  scope: PolicyScope;
  scopeId: string;
  employeeUsername?: string | null;
  modelKey?: string | null;
  currentVersion?: PolicyVersion | null;
  draft?: PolicyVersion | null;
};
type PolicyValues = {
  scope: PolicyScope;
  scopeId: string;
  employeeUsername?: string;
  modelKey?: string;
  instruction?: string;
  access?: 'inherit' | 'allow' | 'deny';
  systemPromptMode?: 'keep' | 'set' | 'clear';
  systemPrompt?: string;
  restrictModels?: boolean;
  allowedModels?: string[];
  maxMonthlyTokens?: number | null;
  maxMonthlyCost?: number | null;
};
type TargetValues = { userId: string; employeeUsername: string; modelKey?: string };
type AuditEvent = {
  id: number | string;
  action: string;
  actorId?: string | number | null;
  userId?: string | number | null;
  departmentId?: string | number | null;
  employeeUsername?: string | null;
  policyId?: string | number | null;
  versionId?: string | number | null;
  createdAt?: string | null;
};
type PreviewResult = {
  departmentId?: string | number | null;
  employeeUsername?: string;
  userId?: string | number;
  instruction?: string;
  promptMode?: string;
  warnings?: string[];
  managed?: boolean;
  originalPrompt?: string | null;
  projectedPrompt?: string | null;
  nativePromptHash?: string | null;
  conflict?: boolean;
  policies?: Array<{
    id: string | number;
    scope: PolicyScope;
    scopeId: string;
    modelKey?: string | null;
    version: number;
    settings: PolicySettings;
  }>;
};
type ListResult<T> = { data?: T[]; meta?: { count?: number } };

function responseData<T>(response: { data?: unknown }): T | undefined {
  const body = response.data;
  if (!body || typeof body !== 'object' || !('data' in body)) return undefined;
  const nested = body.data;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && 'data' in nested) {
    return nested.data as T;
  }
  return nested as T;
}

function errorText(error: unknown, fallback: string) {
  const result = error as { response?: { data?: { errors?: Array<{ message?: string }> } }; message?: string };
  return result?.response?.data?.errors?.[0]?.message || result?.message || fallback;
}

export const EmployeeGovernanceTab: React.FC = () => {
  const api = useApiClient();
  const t = useT();
  const { employees } = useAIEmployees();
  const [form] = Form.useForm<PolicyValues>();
  const [targetForm] = Form.useForm<TargetValues>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyRecord | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [page, setPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const scope = Form.useWatch('scope', form);
  const modelKey = Form.useWatch('modelKey', form);
  const restrictModels = Form.useWatch('restrictModels', form);
  const systemPromptMode = Form.useWatch('systemPromptMode', form);

  const listParams = useMemo(() => ({ page, pageSize: 20 }), [page]);
  const { data, loading, error, refresh } = useRequest<ListResult<PolicyRecord>>(
    { url: 'agentGovernance:list', params: listParams },
    { refreshDeps: [listParams] },
  );
  const auditParams = useMemo(() => ({ page: auditPage, pageSize: 20 }), [auditPage]);
  const auditRequest = useRequest<ListResult<AuditEvent>>(
    { url: 'agentGovernance:events', params: auditParams },
    { refreshDeps: [auditParams] },
  );
  const employeeOptions = useMemo(
    () => employees.map((employee) => ({ value: employee.username, label: employee.nickname || employee.username })),
    [employees],
  );

  const loadVersions = async (policyId: string | number) => {
    setVersionsLoading(true);
    try {
      const response = await api.request({ url: 'agentGovernance:listVersions', params: { filterByTk: policyId } });
      const result = responseData<PolicyVersion[]>(response);
      setVersions(Array.isArray(result) ? result : []);
    } catch (error) {
      setVersions([]);
      message.error(t('Unable to load policy versions') + ': ' + errorText(error, t('unknown error')));
    } finally {
      setVersionsLoading(false);
    }
  };

  const openEditor = (record?: PolicyRecord) => {
    const settings = record?.draft?.settings || record?.currentVersion?.settings || {};
    setEditing(record || null);
    setVersions([]);
    form.resetFields();
    form.setFieldsValue({
      scope: record?.scope || 'department',
      scopeId: record?.scopeId || '',
      employeeUsername: record?.employeeUsername || undefined,
      modelKey: record?.modelKey || undefined,
      instruction: settings.instruction || '',
      access: settings.allow === true ? 'allow' : settings.allow === false ? 'deny' : 'inherit',
      systemPromptMode:
        settings.systemPrompt === null ? 'clear' : typeof settings.systemPrompt === 'string' ? 'set' : 'keep',
      systemPrompt: settings.systemPrompt ?? undefined,
      restrictModels: Array.isArray(settings.allowedModels),
      allowedModels: settings.allowedModels,
      maxMonthlyTokens: settings.maxMonthlyTokens,
      maxMonthlyCost: settings.maxMonthlyCost,
    });
    setDrawerOpen(true);
    if (record) loadVersions(record.id);
  };

  const saveDraft = async (values: PolicyValues) => {
    const settings: PolicySettings = {
      maxMonthlyTokens: values.maxMonthlyTokens ?? null,
      maxMonthlyCost: values.maxMonthlyCost ?? null,
    };
    const selectedModel = values.modelKey?.trim();
    if (values.access === 'allow') settings.allow = true;
    if (values.access === 'deny') settings.allow = false;
    if (!selectedModel) settings.instruction = values.instruction || '';
    if (values.restrictModels) settings.allowedModels = values.allowedModels || [];
    if (!selectedModel && values.scope === 'employee' && values.systemPromptMode === 'set')
      settings.systemPrompt = values.systemPrompt || '';
    if (!selectedModel && values.scope === 'employee' && values.systemPromptMode === 'clear')
      settings.systemPrompt = null;
    setBusy(true);
    try {
      await api.request({
        url: 'agentGovernance:saveDraft',
        method: 'post',
        data: {
          scope: values.scope,
          scopeId: String(values.scopeId).trim(),
          employeeUsername: values.scope === 'employee' ? undefined : values.employeeUsername || undefined,
          modelKey: selectedModel || undefined,
          settings,
        },
      });
      message.success(t('Draft saved'));
      setDrawerOpen(false);
      refresh();
      auditRequest.refresh();
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorText(error, t('unknown error')) }));
    } finally {
      setBusy(false);
    }
  };

  const publish = async (policy: PolicyRecord) => {
    setBusy(true);
    try {
      if (!policy.draft) throw new Error(t('Policy has no draft to publish.'));
      await api.request({
        url: 'agentGovernance:publish',
        method: 'post',
        data: { policyId: policy.id, versionId: policy.draft.id, revision: policy.draft.revision ?? 1 },
      });
      message.success(t('Version published'));
      refresh();
      auditRequest.refresh();
      if (editing?.id === policy.id) await loadVersions(policy.id);
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorText(error, t('unknown error')) }));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (version: PolicyVersion) => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.request({
        url: 'agentGovernance:rollback',
        method: 'post',
        data: { policyId: editing.id, version: version.version },
      });
      message.success(t('Policy version restored'));
      await loadVersions(editing.id);
      setDrawerOpen(false);
      refresh();
      auditRequest.refresh();
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorText(error, t('unknown error')) }));
    } finally {
      setBusy(false);
    }
  };

  const targetAction = async (action: 'preview' | 'apply' | 'restore' | 'release') => {
    let values: TargetValues;
    try {
      values = await targetForm.validateFields();
    } catch {
      return;
    }
    if (
      action === 'release' &&
      (!preview?.managed ||
        !preview.conflict ||
        String(preview.userId) !== values.userId.trim() ||
        preview.employeeUsername !== values.employeeUsername)
    ) {
      message.error(t('Preview the current conflict before releasing'));
      return;
    }
    setBusy(true);
    try {
      const response = await api.request({
        url: `agentGovernance:${action}`,
        method: 'post',
        data: {
          userId: values.userId.trim(),
          employeeUsername: values.employeeUsername,
          ...(action === 'preview' && values.modelKey?.trim() ? { modelKey: values.modelKey.trim() } : {}),
          ...(action === 'release' ? { expectedHash: preview?.nativePromptHash ?? null } : {}),
        },
      });
      if (action === 'restore') {
        const restored = responseData<{ restored?: boolean; orphaned?: boolean }>(response);
        setPreview(null);
        message.success(
          t(
            restored?.orphaned
              ? 'Orphaned instruction binding removed'
              : restored?.restored
                ? 'Original user instruction restored'
                : 'No managed instruction found',
          ),
        );
      } else if (action === 'release') {
        const released = responseData<{ released?: boolean }>(response);
        setPreview(null);
        message.success(t(released?.released ? 'Instruction management released' : 'No managed instruction found'));
      } else {
        setPreview(responseData<PreviewResult>(response) || null);
        if (action === 'apply') message.success(t('Managed instruction applied'));
      }
      if (action !== 'preview') auditRequest.refresh();
    } catch (error) {
      message.error(t('Operation failed: {{message}}', { message: errorText(error, t('unknown error')) }));
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnsType<PolicyRecord> = [
    { title: t('Scope'), dataIndex: 'scope', render: (value: string) => t(`Governance scope: ${value}`) },
    { title: t('Scope ID'), dataIndex: 'scopeId' },
    { title: t('Model selector'), dataIndex: 'modelKey', render: (value: string | null) => value || t('All models') },
    {
      title: t('Employee'),
      dataIndex: 'employeeUsername',
      render: (value: string | null) => value || t('All employees'),
    },
    {
      title: t('Published version'),
      key: 'currentVersion',
      render: (_, row) => (row.currentVersion ? <Tag color="green">{row.currentVersion.version}</Tag> : '—'),
    },
    { title: t('Draft'), key: 'draft', render: (_, row) => (row.draft ? <Tag>{row.draft.version}</Tag> : '—') },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_, row) => (
        <Space>
          <Button onClick={() => openEditor(row)}>{t('Edit')}</Button>
          {row.draft && (
            <Popconfirm title={t('Publish this governance draft?')} onConfirm={() => publish(row)}>
              <Button disabled={busy}>{t('Publish')}</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];
  const versionColumns: ColumnsType<PolicyVersion> = [
    {
      title: t('Version'),
      dataIndex: 'version',
      render: (version: number) => (
        <Space>
          {version}
          {editing?.scope === 'employee' && !editing.modelKey && version === 1 && (
            <Tag>{t('Original employee prompt')}</Tag>
          )}
        </Space>
      ),
    },
    { title: t('Status'), dataIndex: 'status', render: (status: string) => t(status) },
    {
      title: t('Published at'),
      dataIndex: 'publishedAt',
      render: (value: string | null) => (value ? new Date(value).toLocaleString() : '—'),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_, version) =>
        version.status === 'published' && (
          <Popconfirm title={t('Publish a copy of this version?')} onConfirm={() => rollback(version)}>
            <Button size="small" disabled={busy}>
              {t('Restore version')}
            </Button>
          </Popconfirm>
        ),
    },
  ];
  const auditColumns: ColumnsType<AuditEvent> = [
    {
      title: t('Time'),
      dataIndex: 'createdAt',
      render: (value: string | null) => (value ? new Date(value).toLocaleString() : '—'),
    },
    { title: t('Action'), dataIndex: 'action', render: (value: string) => t(`Governance audit: ${value}`) },
    { title: t('Administrator ID'), dataIndex: 'actorId', render: (value: string | number | null) => value ?? '—' },
    { title: t('User ID'), dataIndex: 'userId', render: (value: string | number | null) => value ?? '—' },
    { title: t('Department ID'), dataIndex: 'departmentId', render: (value: string | number | null) => value ?? '—' },
    { title: t('Employee'), dataIndex: 'employeeUsername', render: (value: string | null) => value || '—' },
    { title: t('Policy ID'), dataIndex: 'policyId', render: (value: string | number | null) => value ?? '—' },
    { title: t('Version ID'), dataIndex: 'versionId', render: (value: string | number | null) => value ?? '—' },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={t('Governance capability scope')}
        description={t('Governance capability scope description')}
      />
      <Card
        title={t('Governance policies')}
        extra={
          <Button type="primary" onClick={() => openEditor()}>
            {t('Create policy')}
          </Button>
        }
      >
        {Boolean(error) && <Alert type="error" showIcon message={t('Unable to load governance policies')} />}
        <Table<PolicyRecord>
          rowKey="id"
          columns={columns}
          dataSource={data?.data || []}
          loading={loading}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: page,
            pageSize: 20,
            total: data?.meta?.count || 0,
            showSizeChanger: false,
            onChange: setPage,
          }}
        />
      </Card>
      <Card title={t('Preview and apply managed instruction')}>
        <Alert
          type="warning"
          showIcon
          message={t('Managed instruction visibility')}
          description={t('Managed instruction visibility description')}
          style={{ marginBottom: 16 }}
        />
        <Form form={targetForm} layout="vertical" onValuesChange={() => setPreview(null)}>
          <Space wrap align="start">
            <Form.Item
              name="userId"
              label={t('User ID')}
              rules={[{ required: true, whitespace: true, pattern: /^\d+$/, message: t('Enter a user ID') }]}
            >
              <Input inputMode="numeric" />
            </Form.Item>
            <Form.Item
              name="employeeUsername"
              label={t('Employee')}
              rules={[{ required: true, message: t('Select an employee') }]}
            >
              <Select showSearch optionFilterProp="label" options={employeeOptions} style={{ minWidth: 220 }} />
            </Form.Item>
            <Form.Item name="modelKey" label={t('Model selector')} extra={t('Preview model selector hint')}>
              <Input allowClear />
            </Form.Item>
          </Space>
          <Space wrap>
            <Button loading={busy} onClick={() => targetAction('preview')}>
              {t('Preview effective policy')}
            </Button>
            <Popconfirm title={t('Apply managed instruction to this user?')} onConfirm={() => targetAction('apply')}>
              <Button type="primary" loading={busy}>
                {t('Apply managed instruction')}
              </Button>
            </Popconfirm>
            <Popconfirm title={t('Restore original user instruction?')} onConfirm={() => targetAction('restore')}>
              <Button loading={busy}>{t('Restore original instruction')}</Button>
            </Popconfirm>
            {preview?.managed && preview.conflict && (
              <Popconfirm
                title={t('Release instruction management?')}
                description={t('Release instruction management description')}
                onConfirm={() => targetAction('release')}
              >
                <Button danger loading={busy}>
                  {t('Release instruction management')}
                </Button>
              </Popconfirm>
            )}
          </Space>
        </Form>
        {preview && (
          <Descriptions bordered column={1} size="small" style={{ marginTop: 16 }}>
            <Descriptions.Item label={t('Department ID')}>{preview.departmentId ?? t('Unknown')}</Descriptions.Item>
            <Descriptions.Item label={t('Prompt mode')}>{preview.promptMode || '—'}</Descriptions.Item>
            <Descriptions.Item label={t('Managed')}>{preview.managed ? t('Yes') : t('No')}</Descriptions.Item>
            {preview.conflict && (
              <Descriptions.Item label={t('Conflict')}>
                <Alert type="warning" showIcon message={t('Managed prompt conflict')} />
              </Descriptions.Item>
            )}
            <Descriptions.Item label={t('Effective policies')}>
              {preview.policies?.length
                ? preview.policies.map((policy) => (
                    <div key={policy.id}>
                      <Typography.Text>
                        {t(`Governance scope: ${policy.scope}`)} {policy.scopeId}
                        {policy.modelKey ? ` (${policy.modelKey})` : ''} v{policy.version}
                      </Typography.Text>
                      {policy.settings.allow !== undefined && (
                        <Tag color={policy.settings.allow ? 'default' : 'red'}>
                          {t(policy.settings.allow ? 'Policy access: allow' : 'Policy access: deny')}
                        </Tag>
                      )}
                      {policy.settings.maxMonthlyTokens != null && (
                        <Tag>
                          {t('Monthly token limit')}: {policy.settings.maxMonthlyTokens}
                        </Tag>
                      )}
                      {policy.settings.maxMonthlyCost != null && (
                        <Tag>
                          {t('Monthly cost limit (USD)')}: {policy.settings.maxMonthlyCost}
                        </Tag>
                      )}
                      {Array.isArray(policy.settings.allowedModels) && (
                        <Tag>
                          {t('Allowed models')}:{' '}
                          {policy.settings.allowedModels.length
                            ? policy.settings.allowedModels.join(', ')
                            : t('No models allowed')}
                        </Tag>
                      )}
                    </div>
                  ))
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label={t('Effective instruction')}>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {preview.instruction || '—'}
              </Typography.Paragraph>
            </Descriptions.Item>
            <Descriptions.Item label={t('Projected native prompt')}>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {preview.projectedPrompt || '—'}
              </Typography.Paragraph>
            </Descriptions.Item>
            {Boolean(preview.warnings?.length) && (
              <Descriptions.Item label={t('Warnings')}>
                {preview.warnings?.map((warning) => t(warning)).join('; ')}
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Card>
      <Card title={t('Governance audit')}>
        {Boolean(auditRequest.error) && <Alert type="error" showIcon message={t('Unable to load governance audit')} />}
        <Table<AuditEvent>
          rowKey="id"
          columns={auditColumns}
          dataSource={auditRequest.data?.data || []}
          loading={auditRequest.loading}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: auditPage,
            pageSize: 20,
            total: auditRequest.data?.meta?.count || 0,
            showSizeChanger: false,
            onChange: setAuditPage,
          }}
        />
      </Card>
      <Drawer
        title={editing ? t('Edit governance policy') : t('Create policy')}
        open={drawerOpen}
        width={720}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={saveDraft}>
          <Form.Item name="scope" label={t('Scope')} rules={[{ required: true }]}>
            <Select
              disabled={Boolean(editing)}
              options={[
                { value: 'department', label: t('Governance scope: department') },
                { value: 'user', label: t('Governance scope: user') },
                { value: 'employee', label: t('Governance scope: employee') },
              ]}
            />
          </Form.Item>
          {scope === 'employee' ? (
            <Form.Item
              name="scopeId"
              label={t('Employee')}
              rules={[{ required: true, message: t('Select an employee') }]}
            >
              <Select disabled={Boolean(editing)} showSearch optionFilterProp="label" options={employeeOptions} />
            </Form.Item>
          ) : (
            <Form.Item
              name="scopeId"
              label={scope === 'user' ? t('User ID') : t('Department ID')}
              rules={[{ required: true, whitespace: true, pattern: /^\d+$/, message: t('Enter a scope ID') }]}
            >
              <Input disabled={Boolean(editing)} inputMode="numeric" />
            </Form.Item>
          )}
          {scope !== 'employee' && (
            <Form.Item
              name="employeeUsername"
              label={t('Limit policy to employee')}
              extra={t('Leave empty to apply to all employees')}
            >
              <Select
                allowClear
                disabled={Boolean(editing)}
                showSearch
                optionFilterProp="label"
                options={employeeOptions}
              />
            </Form.Item>
          )}
          <Form.Item name="modelKey" label={t('Model selector')} extra={t('Model selector format hint')}>
            <Input disabled={Boolean(editing)} allowClear />
          </Form.Item>
          <Form.Item name="access" label={t('Policy access')} extra={t('Policy access hint')}>
            <Select
              options={[
                { value: 'inherit', label: t('Policy access: inherit') },
                { value: 'allow', label: t('Policy access: allow') },
                { value: 'deny', label: t('Policy access: deny') },
              ]}
            />
          </Form.Item>
          {!modelKey?.trim() && (
            <Form.Item
              name="instruction"
              label={t('Managed instruction')}
              extra={t('Managed instruction content hint')}
            >
              <Input.TextArea rows={5} />
            </Form.Item>
          )}
          {!modelKey?.trim() && scope === 'employee' && (
            <>
              <Form.Item
                name="systemPromptMode"
                label={t('Employee system prompt action')}
                extra={t('Employee system prompt scope hint')}
              >
                <Select
                  options={[
                    { value: 'keep', label: t('Keep current system prompt') },
                    { value: 'set', label: t('Set employee system prompt') },
                    { value: 'clear', label: t('Use employee default system prompt') },
                  ]}
                />
              </Form.Item>
              {systemPromptMode === 'set' && (
                <Form.Item name="systemPrompt" label={t('Employee system prompt')}>
                  <Input.TextArea rows={5} />
                </Form.Item>
              )}
            </>
          )}
          <Form.Item name="restrictModels" valuePropName="checked" label={t('Restrict allowed models')}>
            <Switch aria-label={t('Restrict allowed models')} />
          </Form.Item>
          {restrictModels && (
            <Form.Item name="allowedModels" label={t('Allowed models')} extra={t('Allowed model format hint')}>
              <Select mode="tags" tokenSeparators={[',']} />
            </Form.Item>
          )}
          <Form.Item name="maxMonthlyTokens" label={t('Monthly token limit')}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="maxMonthlyCost" label={t('Monthly cost limit (USD)')}>
            <InputNumber min={0} precision={8} style={{ width: '100%' }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>
            {t('Save draft')}
          </Button>
        </Form>
        {editing && (
          <Card title={t('Version history')} style={{ marginTop: 24 }}>
            <Table<PolicyVersion>
              rowKey="id"
              size="small"
              columns={versionColumns}
              dataSource={versions}
              loading={versionsLoading}
              pagination={false}
            />
          </Card>
        )}
      </Drawer>
    </Space>
  );
};
