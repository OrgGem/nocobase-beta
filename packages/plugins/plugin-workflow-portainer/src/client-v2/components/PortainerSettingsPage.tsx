/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  ApiOutlined,
  AppstoreOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Drawer,
  Flex,
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
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  PORTAINER_INSTANCES_COLLECTION,
  PORTAINER_RESOURCE,
  SECRET_MASK,
} from '../../shared/constants';
import type { PortainerEndpointSummary, PortainerInstanceSummary, PortainerStackSummary } from '../../shared/types';
import { useT } from '../locale';
import { StackDetailDrawer } from './StackDetailDrawer';

interface InstanceFormValues {
  name: string;
  baseUrl: string;
  apiKey?: string;
  gitCredentialId?: number | null;
  gitUsername?: string;
  gitAccessToken?: string;
  allowInsecureTls?: boolean;
  defaultTimeoutMs?: number;
  isDefault?: boolean;
  enabled?: boolean;
}

export function PortainerSettingsPage() {
  const t = useT();
  const api = useApp().apiClient;
  const [form] = Form.useForm<InstanceFormValues>();

  const [instances, setInstances] = useState<PortainerInstanceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PortainerInstanceSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingDraft, setTestingDraft] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  const [explorerInstance, setExplorerInstance] = useState<PortainerInstanceSummary | null>(null);
  const [endpoints, setEndpoints] = useState<PortainerEndpointSummary[]>([]);
  const [selectedEndpointId, setSelectedEndpointId] = useState<number | undefined>(undefined);
  const [stacks, setStacks] = useState<PortainerStackSummary[]>([]);
  const [loadingStacks, setLoadingStacks] = useState(false);
  const [selectedStack, setSelectedStack] = useState<PortainerStackSummary | null>(null);

  const loadInstances = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request<{ data?: PortainerInstanceSummary[] }>({
        url: `${PORTAINER_INSTANCES_COLLECTION}:list`,
        method: 'get',
        params: {
          pageSize: 100,
          sort: ['-isDefault', 'id'],
        },
      });
      setInstances(Array.isArray(res?.data?.data) ? res.data.data : []);
    } catch {
      message.error(t('Failed to load Portainer instances'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    loadInstances();
  }, [loadInstances]);

  const openCreateModal = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      allowInsecureTls: false,
      isDefault: instances.length === 0,
      enabled: true,
    });
    setModalOpen(true);
  };

  const openEditModal = (record: PortainerInstanceSummary) => {
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      baseUrl: record.baseUrl,
      apiKey: record.apiKey || SECRET_MASK,
      gitCredentialId: record.gitCredentialId ?? undefined,
      gitUsername: record.gitUsername ?? '',
      gitAccessToken: record.gitAccessToken || '',
      allowInsecureTls: Boolean(record.allowInsecureTls),
      defaultTimeoutMs: record.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      isDefault: Boolean(record.isDefault),
      enabled: record.enabled !== false,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    let values: InstanceFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.request({
          url: `${PORTAINER_INSTANCES_COLLECTION}:update`,
          method: 'post',
          params: { filterByTk: editing.id },
          data: values,
        });
        message.success(t('Portainer instance updated'));
      } else {
        await api.request({
          url: `${PORTAINER_INSTANCES_COLLECTION}:create`,
          method: 'post',
          data: values,
        });
        message.success(t('Portainer instance created'));
      }
      setModalOpen(false);
      await loadInstances();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Failed to save Portainer instance');
      message.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleTestDraft = async () => {
    const values = form.getFieldsValue();
    if (!values.baseUrl) {
      message.warning(t('Please enter a Portainer base URL first'));
      return;
    }
    setTestingDraft(true);
    try {
      const res = await api.request<{ data?: { version?: string; endpointCount?: number } }>({
        url: `${PORTAINER_RESOURCE}:testConnectionDraft`,
        method: 'post',
        data: {
          ...values,
          id: editing?.id,
        },
      });
      const info = res?.data?.data;
      message.success(
        t('Connected to Portainer v{{version}} ({{count}} environments found)', {
          version: info?.version ?? 'unknown',
          count: info?.endpointCount ?? 0,
        }),
      );
    } catch {
      message.error(t('Connection test failed. Check URL, API key, and TLS settings.'));
    } finally {
      setTestingDraft(false);
    }
  };

  const handleTestSaved = async (record: PortainerInstanceSummary) => {
    setTestingId(record.id);
    try {
      const res = await api.request<{ data?: { version?: string; endpointCount?: number } }>({
        url: `${PORTAINER_RESOURCE}:testConnection`,
        method: 'post',
        params: { filterByTk: record.id },
      });
      const info = res?.data?.data;
      message.success(
        t('Connected to Portainer v{{version}} ({{count}} environments found)', {
          version: info?.version ?? 'unknown',
          count: info?.endpointCount ?? 0,
        }),
      );
      await loadInstances();
    } catch {
      message.error(t('Connection test failed'));
      await loadInstances();
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleEnabled = async (record: PortainerInstanceSummary, enabled: boolean) => {
    try {
      await api.request({
        url: `${PORTAINER_INSTANCES_COLLECTION}:update`,
        method: 'post',
        params: { filterByTk: record.id },
        data: { enabled },
      });
      await loadInstances();
    } catch {
      message.error(t('Failed to update status'));
    }
  };

  const handleDelete = async (record: PortainerInstanceSummary) => {
    try {
      await api.request({
        url: `${PORTAINER_INSTANCES_COLLECTION}:destroy`,
        method: 'post',
        params: { filterByTk: record.id },
      });
      message.success(t('Portainer instance deleted'));
      await loadInstances();
    } catch {
      message.error(t('Failed to delete Portainer instance'));
    }
  };

  const loadExplorerData = useCallback(
    async (instanceId: number, endpointId?: number) => {
      setLoadingStacks(true);
      try {
        const [epRes, stRes] = await Promise.all([
          api.request<{ data?: PortainerEndpointSummary[] }>({
            url: `${PORTAINER_RESOURCE}:listEndpoints`,
            method: 'get',
            params: { instanceId },
          }),
          api.request<{ data?: PortainerStackSummary[] }>({
            url: `${PORTAINER_RESOURCE}:listStacks`,
            method: 'get',
            params: {
              instanceId,
              ...(endpointId ? { endpointId } : {}),
            },
          }),
        ]);
        setEndpoints(Array.isArray(epRes?.data?.data) ? epRes.data.data : []);
        setStacks(Array.isArray(stRes?.data?.data) ? stRes.data.data : []);
      } catch {
        message.error(t('Failed to load environments and stacks from Portainer'));
      } finally {
        setLoadingStacks(false);
      }
    },
    [api, t],
  );

  const openExplorer = (record: PortainerInstanceSummary) => {
    setExplorerInstance(record);
    setSelectedStack(null);
    setSelectedEndpointId(undefined);
    loadExplorerData(record.id, undefined);
  };

  const columns: ColumnsType<PortainerInstanceSummary> = [
    {
      title: t('Name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record) => (
        <Space>
          <Typography.Text strong>{name}</Typography.Text>
          {record.isDefault ? <Tag color="blue">{t('Default')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('Base URL'),
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      render: (url: string) => <Typography.Text code>{url}</Typography.Text>,
    },
    {
      title: t('Health & Version'),
      key: 'health',
      render: (_, record) => {
        if (!record.lastHealthStatus) {
          return <Tag>{t('Not tested')}</Tag>;
        }
        return record.lastHealthStatus === 'ok' ? (
          <Space size="small">
            <Tag color="success" icon={<CheckCircleOutlined />}>
              {t('Connected')}
            </Tag>
            {record.lastVersion ? <Typography.Text type="secondary">v{record.lastVersion}</Typography.Text> : null}
          </Space>
        ) : (
          <Tag color="error">{t('Unreachable')}</Tag>
        );
      },
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean, record) => (
        <Switch
          checked={enabled !== false}
          aria-label={`${t('Toggle Portainer instance')} ${record.name}`}
          onChange={(checked) => {
            handleToggleEnabled(record, checked);
          }}
        />
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 300,
      render: (_, record) => (
        <Space size="small" wrap>
          <Button
            size="small"
            htmlType="button"
            icon={<ApiOutlined />}
            loading={testingId === record.id}
            aria-label={`${t('Test connection')} ${record.name}`}
            onClick={() => {
              handleTestSaved(record);
            }}
          >
            {t('Test')}
          </Button>
          <Button
            size="small"
            htmlType="button"
            icon={<AppstoreOutlined />}
            aria-label={`${t('Browse Stacks')} ${record.name}`}
            onClick={() => openExplorer(record)}
          >
            {t('Stacks')}
          </Button>
          <Button
            size="small"
            htmlType="button"
            icon={<EditOutlined />}
            aria-label={`${t('Edit Portainer instance')} ${record.name}`}
            onClick={() => openEditModal(record)}
          />
          <Popconfirm title={t('Delete this Portainer instance?')} onConfirm={() => handleDelete(record)}>
            <Button
              size="small"
              danger
              htmlType="button"
              icon={<DeleteOutlined />}
              aria-label={`${t('Delete Portainer instance')} ${record.name}`}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const stackColumns: ColumnsType<PortainerStackSummary> = [
    {
      title: t('ID'),
      dataIndex: 'id',
      key: 'id',
      width: 72,
    },
    {
      title: t('Stack Name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: t('Endpoint'),
      dataIndex: 'endpointId',
      key: 'endpointId',
      width: 130,
      render: (epId: number) => {
        const ep = endpoints.find((item) => item.id === epId);
        return ep ? `${ep.name} (#${epId})` : `#${epId}`;
      },
    },
    {
      title: t('Source'),
      key: 'source',
      render: (_, st) => (
        <Space size="small" wrap>
          <Tag color={st.isGitStack ? 'processing' : 'purple'}>{st.isGitStack ? t('Git Stack') : t('Compose')}</Tag>
          {st.gitReference ? <Typography.Text code>{st.gitReference}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (status: number) => {
        if (status === 3) {
          return <Tag color="processing">{t('Deploying')}</Tag>;
        }
        if (status === 4) {
          return <Tag color="error">{t('Error')}</Tag>;
        }
        return <Tag color={status === 1 ? 'success' : 'default'}>{status === 1 ? t('Active') : t('Inactive')}</Tag>;
      },
    },
    {
      title: t('Env Vars'),
      dataIndex: 'envCount',
      key: 'envCount',
      width: 90,
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 105,
      render: (_, st) => (
        <Button
          size="small"
          htmlType="button"
          icon={<EyeOutlined />}
          aria-label={`${t('Detail')} ${st.name}`}
          onClick={() => setSelectedStack(st)}
        >
          {t('Detail')}
        </Button>
      ),
    },
  ];

  return (
    <Card
      title={t('Portainer Instances')}
      extra={
        <Space>
          <Button
            htmlType="button"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => {
              loadInstances();
            }}
          >
            {t('Refresh')}
          </Button>
          <Button type="primary" htmlType="button" icon={<PlusOutlined />} onClick={openCreateModal}>
            {t('Add Portainer instance')}
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t(
          'Configure Portainer servers with an Access Token (X-API-Key). Workflow nodes can select Environments and Stacks directly or receive dynamic IDs and Env variables from upstream build catalogs.',
        )}
      />

      <Table<PortainerInstanceSummary>
        rowKey="id"
        loading={loading}
        dataSource={instances}
        columns={columns}
        pagination={false}
      />

      <Modal
        open={modalOpen}
        title={editing ? t('Edit Portainer instance') : t('Add Portainer instance')}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        width={620}
        footer={
          <Flex justify="space-between" align="center">
            <Button
              htmlType="button"
              icon={<ApiOutlined />}
              loading={testingDraft}
              onClick={() => {
                handleTestDraft();
              }}
            >
              {t('Test connection')}
            </Button>
            <Space>
              <Button htmlType="button" onClick={() => setModalOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button
                type="primary"
                htmlType="button"
                loading={saving}
                onClick={() => {
                  handleSave();
                }}
              >
                {t('Save')}
              </Button>
            </Space>
          </Flex>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t('Instance name')}
            rules={[{ required: true, message: t('Instance name is required') }]}
          >
            <Input placeholder="Portainer Production" />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label={t('Portainer base URL')}
            rules={[{ required: true, message: t('Base URL is required') }]}
            extra={t('Example: https://portainer.internal:9443')}
          >
            <Input
              placeholder="https://portainer.example.com:9443"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label={t('Portainer API key (X-API-Key)')}
            rules={[{ required: !editing, message: t('API key is required') }]}
            extra={t('Generated under Portainer -> My account -> Access tokens. Encrypted at rest.')}
          >
            <Input.Password
              placeholder="ptr_..."
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Form.Item>

          <Flex gap="middle" wrap="wrap">
            <Form.Item
              name="defaultTimeoutMs"
              label={t('Default build/redeploy timeout (ms)')}
              style={{ flex: '1 1 240px' }}
            >
              <InputNumber min={MIN_TIMEOUT_MS} max={MAX_TIMEOUT_MS} step={5000} style={{ width: '100%' }} />
            </Form.Item>
          </Flex>

          <Space size="large" wrap style={{ marginBottom: 16 }}>
            <Form.Item name="isDefault" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>{t('Set as default instance')}</Checkbox>
            </Form.Item>
            <Form.Item name="allowInsecureTls" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>{t('Allow self-signed TLS certificate (:9443)')}</Checkbox>
            </Form.Item>
            <Form.Item name="enabled" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>{t('Enabled')}</Checkbox>
            </Form.Item>
          </Space>

          <Collapse
            size="small"
            items={[
              {
                key: 'git-fallback',
                label: t('Optional Git authentication fallback (when Stack has no saved GitCredentialID)'),
                children: (
                  <>
                    <Form.Item
                      name="gitCredentialId"
                      label={t('Portainer saved Git Credential ID (optional)')}
                      extra={t(
                        'Automatically detected from each Git Stack when present; set here only to supply a default ID.',
                      )}
                    >
                      <InputNumber min={1} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name="gitUsername" label={t('Fallback Git username (optional)')}>
                      <Input autoCorrect="off" autoCapitalize="none" spellCheck={false} placeholder="oauth2" />
                    </Form.Item>
                    <Form.Item
                      name="gitAccessToken"
                      label={t('Fallback Git Personal Access Token (optional)')}
                      style={{ marginBottom: 0 }}
                    >
                      <Input.Password
                        autoComplete="new-password"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Modal>

      <Drawer
        open={Boolean(explorerInstance)}
        title={explorerInstance ? `${t('Portainer Stacks')} — ${explorerInstance.name}` : t('Portainer Stacks')}
        onClose={() => {
          setSelectedStack(null);
          setExplorerInstance(null);
        }}
        width={820}
      >
        <Flex gap="small" align="center" style={{ marginBottom: 16 }}>
          <Select
            allowClear
            style={{ width: 280 }}
            placeholder={t('All environments (Endpoints)')}
            value={selectedEndpointId}
            options={endpoints.map((ep) => ({
              value: ep.id,
              label: `${ep.name} (#${ep.id})`,
            }))}
            onChange={(epId) => {
              setSelectedEndpointId(epId);
              if (explorerInstance) {
                loadExplorerData(explorerInstance.id, epId);
              }
            }}
          />
          <Button
            htmlType="button"
            icon={<ReloadOutlined />}
            loading={loadingStacks}
            onClick={() => {
              if (explorerInstance) {
                loadExplorerData(explorerInstance.id, selectedEndpointId);
              }
            }}
          >
            {t('Refresh')}
          </Button>
        </Flex>

        <Table<PortainerStackSummary>
          rowKey="id"
          size="small"
          loading={loadingStacks}
          dataSource={stacks}
          columns={stackColumns}
          pagination={{ pageSize: 15 }}
        />

        <StackDetailDrawer
          open={Boolean(selectedStack)}
          instance={explorerInstance}
          stack={selectedStack}
          endpoints={endpoints}
          onClose={() => setSelectedStack(null)}
          onStackChanged={() => {
            if (explorerInstance) {
              loadExplorerData(explorerInstance.id, selectedEndpointId);
            }
          }}
        />
      </Drawer>
    </Card>
  );
}

export default PortainerSettingsPage;
