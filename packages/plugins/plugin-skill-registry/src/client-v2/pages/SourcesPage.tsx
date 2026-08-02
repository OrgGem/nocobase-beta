import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  type TableColumnsType,
  Tag,
} from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import { type NocoBaseListBody, type NocoBaseResponse, unwrapRecords } from './api';

type RegistrySource = {
  id: string;
  name: string;
  providerType: 'skill-hub' | 'git-manager';
  namespace: string;
  status: string;
  syncPolicy: 'manual' | 'interval';
  syncIntervalMinutes?: number;
  enabled: boolean;
  updatedAt?: string;
  providerConfig?: Record<string, unknown>;
};

type GitRepository = {
  id: string | number;
  name: string;
  repoUrl?: string;
  defaultBranch?: string;
  registryExportEnabled?: boolean;
};

interface SourceFormValues {
  namespace: string;
  providerConfigText: string;
  name: string;
  providerType: 'skill-hub' | 'git-manager';
  syncPolicy: 'manual' | 'interval';
  syncIntervalMinutes?: number;
  enabled: boolean;
  repositoryId?: string | number;
  gitRef?: string;
  rootPath?: string;
  advancedConfig?: boolean;
}

export function shouldLoadGitRepositories(input: {
  canManage: boolean;
  open: boolean;
  providerType: SourceFormValues['providerType'] | undefined;
  advancedConfig: boolean | undefined;
}): boolean {
  return input.canManage && input.open && input.providerType === 'git-manager' && !input.advancedConfig;
}

const gitManagerDefaults = {
  gitRef: 'main',
  rootPath: '.kiro/skills',
};

const skillHubConfigSample = JSON.stringify({ skillDefinitionIds: [] }, null, 2);

export default function SourcesPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canSync, canManage } = useSkillRegistryPermissions();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RegistrySource | null>(null);
  const [activeOperations, setActiveOperations] = useState<Record<string, 'discover' | 'sync'>>({});
  const [form] = Form.useForm<SourceFormValues>();
  const syncPolicy = Form.useWatch('syncPolicy', form);
  const providerType = Form.useWatch('providerType', form);
  const advancedConfig = Form.useWatch('advancedConfig', form);
  const loadGitRepositories = shouldLoadGitRepositories({ canManage, open, providerType, advancedConfig });
  const request = useRequest(() =>
    ctx.api.request<NocoBaseListBody<RegistrySource>>({ url: 'skillRegistrySources:list', method: 'get' }),
  );
  const repositoriesRequest = useRequest(
    () =>
      ctx.api.request<NocoBaseListBody<GitRepository>>({
        url: 'gitRepositories:list',
        method: 'get',
        params: { pageSize: 200, sort: ['name'] },
      }),
    { ready: loadGitRepositories },
  );
  const sources = unwrapRecords<RegistrySource>(request.data);
  const repositories = unwrapRecords<GitRepository>(repositoriesRequest.data);
  const refreshRunningOperations = useCallback(async () => {
    const response = await ctx.api.request<NocoBaseListBody<{ sourceId: string }>>({
      url: 'skillRegistrySyncRuns:list',
      method: 'get',
      params: { filter: { status: 'running' }, pageSize: 100 },
    });
    const running = unwrapRecords<{ sourceId: string }>(response);
    setActiveOperations(Object.fromEntries(running.map((run) => [String(run.sourceId), 'sync' as const])));
  }, [ctx.api]);

  useEffect(() => {
    refreshRunningOperations().catch(() => undefined);
  }, [refreshRunningOperations]);

  useEffect(() => {
    if (!Object.keys(activeOperations).length) {
      return undefined;
    }
    const timer = window.setInterval(async () => {
      try {
        await Promise.all([request.refreshAsync(), refreshRunningOperations()]);
      } catch {
        // Keep controls disabled until a later poll can confirm completion.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeOperations, refreshRunningOperations, request]);
  const columns: TableColumnsType<RegistrySource> = [
    { title: t('Name'), key: 'name', render: (_, record) => record.name },
    { title: t('Provider'), key: 'providerType', render: (_, record) => record.providerType },
    { title: t('Namespace'), key: 'namespace', render: (_, record) => record.namespace },
    { title: t('Status'), key: 'status', render: (_, record) => <Tag>{record.status}</Tag> },
    {
      title: t('Sync policy'),
      key: 'syncPolicy',
      render: (_, record) => (record.syncPolicy === 'interval' ? t('Interval') : t('Manual')),
    },
    { title: t('Updated'), key: 'updatedAt', render: (_, record) => record.updatedAt || '\u2014' },
  ];

  if (canManage) {
    columns.push({
      title: t('Edit'),
      key: 'edit',
      render: (_, record) => (
        <Button onClick={() => openEdit(record)} disabled={Boolean(activeOperations[record.id])}>
          {t('Edit')}
        </Button>
      ),
    });
  }

  if (canSync) {
    columns.push({
      title: t('Run'),
      key: 'run',
      render: (_, record) => (
        <Space>
          <Button
            onClick={() => discoverSource(record.id)}
            disabled={!record.enabled || Boolean(activeOperations[record.id])}
            loading={activeOperations[record.id] === 'discover'}
          >
            {t('Discover')}
          </Button>
          <Button
            onClick={() => syncSource(record.id)}
            disabled={!record.enabled || Boolean(activeOperations[record.id])}
            loading={activeOperations[record.id] === 'sync'}
          >
            {t('Sync')}
          </Button>
        </Space>
      ),
    });
  }

  const syncSource = async (sourceId: string) => {
    if (!canSync) {
      return;
    }
    setActiveOperations((current) => ({ ...current, [sourceId]: 'sync' }));
    try {
      await ctx.api.request<NocoBaseResponse<{ runId: string; status: string }>>({
        url: 'skillRegistryAdmin:sync',
        method: 'post',
        data: { sourceId },
      });
      ctx.message.success(t('Sync started'));
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
      setActiveOperations((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
    }
  };

  const discoverSource = async (sourceId: string) => {
    if (!canSync) {
      return;
    }
    setActiveOperations((current) => ({ ...current, [sourceId]: 'discover' }));
    try {
      const response = await ctx.api.request<NocoBaseResponse<NocoBaseResponse<{ candidates?: unknown[] }>>>({
        url: 'skillRegistryAdmin:discover',
        method: 'post',
        data: { sourceId },
      });
      // Axios data -> NocoBase envelope -> action body.
      const actionBody = response.data?.data;
      const candidates = actionBody?.candidates;
      const count = Array.isArray(candidates) ? candidates.length : 0;
      ctx.message.success(t('Discovery completed ({{count}} candidates)', { count }));
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setActiveOperations((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
    }
  };

  const openEdit = (source: RegistrySource) => {
    const config = source.providerConfig || {};
    const configKeys = Object.keys(config);
    const hasCustomGitConfig =
      source.providerType === 'git-manager' &&
      configKeys.some((key) => !['repositoryId', 'ref', 'rootPath'].includes(key));
    setEditing(source);
    form.setFieldsValue({
      name: source.name,
      providerType: source.providerType,
      namespace: source.namespace,
      providerConfigText: JSON.stringify(config, null, 2),
      repositoryId:
        typeof config.repositoryId === 'string' || typeof config.repositoryId === 'number'
          ? config.repositoryId
          : undefined,
      gitRef: typeof config.ref === 'string' ? config.ref : gitManagerDefaults.gitRef,
      rootPath: typeof config.rootPath === 'string' ? config.rootPath : gitManagerDefaults.rootPath,
      advancedConfig: hasCustomGitConfig,
      syncPolicy: source.syncPolicy,
      syncIntervalMinutes: source.syncIntervalMinutes,
      enabled: source.enabled,
    });
    setOpen(true);
  };

  const saveSource = async () => {
    if (!canManage) {
      return;
    }
    try {
      const values = await form.validateFields();
      const providerConfig =
        values.providerType === 'git-manager' && !values.advancedConfig
          ? {
              repositoryId: values.repositoryId,
              ref: values.gitRef || gitManagerDefaults.gitRef,
              rootPath: values.rootPath || gitManagerDefaults.rootPath,
            }
          : (JSON.parse(values.providerConfigText || '{}') as Record<string, unknown>);
      const sourceValues = {
        name: values.name,
        providerType: values.providerType,
        namespace: values.namespace,
        providerConfig,
        enabled: editing ? values.enabled : true,
        syncPolicy: values.syncPolicy,
        ...(values.syncPolicy === 'interval' ? { syncIntervalMinutes: values.syncIntervalMinutes } : {}),
      };
      await ctx.api.request<NocoBaseResponse<Record<string, never>>>({
        url: editing ? 'skillRegistrySources:update' : 'skillRegistrySources:create',
        method: 'post',
        params: editing ? { filterByTk: editing.id } : undefined,
        data: sourceValues,
      });
      ctx.message.success(t(editing ? 'Source updated' : 'Source created'));
      setOpen(false);
      setEditing(null);
      form.resetFields();
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  return (
    <Card
      title={t('Sources')}
      extra={
        <Space>
          <Button onClick={() => request.refresh()} loading={request.loading}>
            {t('Refresh')}
          </Button>
          {canManage ? (
            <Button
              type="primary"
              onClick={() => {
                setEditing(null);
                form.resetFields();
                form.setFieldsValue({
                  providerType: 'skill-hub',
                  providerConfigText: skillHubConfigSample,
                  syncPolicy: 'manual',
                  enabled: true,
                });
                setOpen(true);
              }}
            >
              {t('Create source')}
            </Button>
          ) : null}
        </Space>
      }
    >
      <Table
        aria-label={t('Sources')}
        rowKey="id"
        loading={request.loading}
        dataSource={sources}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
        columns={columns}
      />
      {canManage ? (
        <Modal
          title={t(editing ? 'Edit source' : 'Create source')}
          open={open}
          onCancel={() => {
            setOpen(false);
            setEditing(null);
          }}
          onOk={saveSource}
          okText={t('Save')}
          cancelText={t('Cancel')}
        >
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              name: '',
              ['providerType']: 'skill-hub',
              ['namespace']: '',
              ['providerConfigText']: skillHubConfigSample,
              ['syncPolicy']: 'manual',
              ['syncIntervalMinutes']: undefined,
              ['enabled']: true,
            }}
          >
            <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
              <Input autoFocus />
            </Form.Item>
            <Form.Item name="providerType" label={t('Provider')} rules={[{ required: true }]}>
              <Select
                disabled={Boolean(editing)}
                onChange={(value: SourceFormValues['providerType']) => {
                  if (value === 'git-manager') {
                    form.setFieldsValue({
                      repositoryId: undefined,
                      gitRef: gitManagerDefaults.gitRef,
                      rootPath: gitManagerDefaults.rootPath,
                      advancedConfig: false,
                      providerConfigText: JSON.stringify(
                        { repositoryId: 1, ref: gitManagerDefaults.gitRef, rootPath: gitManagerDefaults.rootPath },
                        null,
                        2,
                      ),
                    });
                    return;
                  }
                  form.setFieldsValue({ advancedConfig: false, providerConfigText: skillHubConfigSample });
                }}
                options={[
                  { value: 'skill-hub', label: t('Skill Hub') },
                  { value: 'git-manager', label: t('Git Manager') },
                ]}
              />
            </Form.Item>
            <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="namespace" label={t('Namespace')} rules={[{ required: true }]}>
              <Input placeholder="acme" />
            </Form.Item>
            {providerType === 'git-manager' && !advancedConfig ? (
              <>
                <Form.Item
                  name="repositoryId"
                  label={t('Git repository')}
                  rules={[{ required: true, message: t('Git repository is required') }]}
                  extra={
                    repositoriesRequest.error
                      ? t(
                          'Git repositories could not be loaded. Enable Git Manager and grant repository read permission.',
                        )
                      : t('Only repositories enabled for registry export can be selected.')
                  }
                >
                  <Select
                    showSearch
                    loading={repositoriesRequest.loading}
                    optionFilterProp="label"
                    placeholder={t('Select a Git Manager repository')}
                    options={repositories.map((repository) => ({
                      value: repository.id,
                      label: `${repository.name}${repository.defaultBranch ? ` (${repository.defaultBranch})` : ''}`,
                      disabled: !repository.registryExportEnabled,
                    }))}
                    onChange={(repositoryId) => {
                      const repository = repositories.find((item) => String(item.id) === String(repositoryId));
                      if (repository?.defaultBranch) {
                        form.setFieldValue('gitRef', repository.defaultBranch);
                      }
                    }}
                  />
                </Form.Item>
                <Form.Item name="gitRef" label={t('Git ref')} rules={[{ required: true }]}>
                  <Input placeholder="main" />
                </Form.Item>
                <Form.Item
                  name="rootPath"
                  label={t('Skills root path')}
                  rules={[{ required: true }]}
                  extra={t(
                    'Enter the folder that directly contains skills. If it contains none, the registry also checks its /skills subfolder.',
                  )}
                >
                  <Input placeholder=".kiro/skills or agent-assets" />
                </Form.Item>
              </>
            ) : null}
            {providerType === 'git-manager' ? (
              <Form.Item name="advancedConfig" label={t('Advanced JSON configuration')} valuePropName="checked">
                <Switch
                  onChange={(checked) => {
                    if (!checked) {
                      return;
                    }
                    form.setFieldValue(
                      'providerConfigText',
                      JSON.stringify(
                        {
                          repositoryId: form.getFieldValue('repositoryId') ?? 1,
                          ref: form.getFieldValue('gitRef') || gitManagerDefaults.gitRef,
                          rootPath: form.getFieldValue('rootPath') || gitManagerDefaults.rootPath,
                        },
                        null,
                        2,
                      ),
                    );
                  }}
                />
              </Form.Item>
            ) : null}
            {providerType !== 'git-manager' || advancedConfig ? (
              <Form.Item
                name="providerConfigText"
                label={t('Provider configuration (JSON)')}
                extra={
                  providerType === 'skill-hub'
                    ? t('An empty skillDefinitionIds list imports all authorized skill definitions.')
                    : t('Advanced mode saves this JSON exactly as entered.')
                }
                rules={[
                  { required: true },
                  {
                    validator: async (_, value: string) => {
                      try {
                        JSON.parse(value || '{}');
                      } catch {
                        throw new Error(t('Enter valid JSON'));
                      }
                    },
                  },
                ]}
              >
                <Input.TextArea rows={6} />
              </Form.Item>
            ) : null}
            <Form.Item name="syncPolicy" label={t('Sync policy')} rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'manual', label: t('Manual') },
                  { value: 'interval', label: t('Interval') },
                ]}
              />
            </Form.Item>
            {syncPolicy === 'interval' ? (
              <Form.Item
                name="syncIntervalMinutes"
                label={t('Sync interval (minutes)')}
                rules={[{ required: true, message: t('Sync interval is required') }]}
              >
                <InputNumber min={1} max={1440} style={{ width: '100%' }} />
              </Form.Item>
            ) : null}
          </Form>
        </Modal>
      ) : null}
    </Card>
  );
}
