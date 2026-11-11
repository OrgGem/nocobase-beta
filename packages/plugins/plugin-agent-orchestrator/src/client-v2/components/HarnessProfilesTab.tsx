/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useApiClient as useAPIClient, useRequest } from '../hooks/useApiRequest';
import { useT } from '../skill-hub/locale';

const { Text } = Typography;

type ProfileVersion = {
  id: number;
  profileId: number;
  version: number;
  schemaVersion: number;
  status: 'draft' | 'published';
  settings: Record<string, unknown>;
  publishedAt?: string | null;
  createdAt?: string | null;
};

type ProfileRow = {
  id: number;
  tag: string;
  title?: string;
  description?: string;
  enabled?: boolean;
  settings?: Record<string, unknown>;
  currentVersion?: ProfileVersion | null;
};

type ProfileFormValues = {
  tag?: string;
  title?: string;
  description?: string;
  enabled?: boolean;
};

type NativeScope = 'chat' | 'api' | 'workflow' | 'sub-agent';
type CapabilityStatus = 'enforced' | 'observe-only' | 'unsupported';

type CapabilityMatrix = {
  scopes: NativeScope[];
  nativeCapabilities: Array<{
    id: string;
    labelKey: string;
    settings: string[];
    byScope: Record<NativeScope, { status: CapabilityStatus; reasonKey: string }>;
  }>;
  scopedCapabilities: Array<{
    id: string;
    labelKey: string;
    settings: string[];
    status: CapabilityStatus;
    scopeKey: string;
    detailKey: string;
  }>;
  telemetrySettings: { settings: string[]; noteKey: string };
  noteKey: string;
};

const STATUS_COLORS: Record<CapabilityStatus, string> = {
  enforced: 'green',
  'observe-only': 'gold',
  unsupported: 'default',
};

const STATUS_LABELS: Record<CapabilityStatus, string> = {
  enforced: 'Enforced',
  'observe-only': 'Observe only',
  unsupported: 'Unsupported',
};

const DEFAULT_SETTINGS = {
  nativeObserverEnabled: true,
  memoryInjectionEnabled: true,
  memoryScopes: ['public', 'user', 'agent_user'],
  maxMemoryContextChars: 6000,
  tracingRetentionDays: 30,
};

const parseSettings = (value: string) => {
  const text = String(value || '').trim();
  if (!text) return {};
  return JSON.parse(text);
};

const formatSettings = (settings: unknown) => JSON.stringify(settings || {}, null, 2);

const formatDate = (value?: string | null) => (value ? new Date(value).toLocaleString() : '-');

function errorMessage(error: unknown, fallback: string) {
  const response = error as { response?: { data?: { errors?: { message?: string }[] } } };
  return response?.response?.data?.errors?.[0]?.message || (error as Error)?.message || fallback;
}

export const HarnessProfilesTab: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [editingRecord, setEditingRecord] = React.useState<ProfileRow | null>(null);
  const [settingsText, setSettingsText] = React.useState('');
  const [versions, setVersions] = React.useState<ProfileVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [savingDetails, setSavingDetails] = React.useState(false);
  const [savingDraft, setSavingDraft] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [publishingVersionId, setPublishingVersionId] = React.useState<number | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [form] = Form.useForm<ProfileFormValues>();

  const { data, loading, refresh } = useRequest({
    url: 'agentHarnessProfiles:list',
    params: {
      sort: ['tag'],
      pageSize: 100,
      appends: ['currentVersion'],
    },
  });

  const { data: capabilityData, loading: capabilitiesLoading } = useRequest({
    url: 'agentHarnessProfiles:capabilities',
  });

  const rows = React.useMemo(() => {
    const raw = (data as { data?: ProfileRow[] } | undefined)?.data;
    return Array.isArray(raw) ? raw : [];
  }, [data]);

  const capabilityMatrix = (capabilityData as { data?: CapabilityMatrix } | undefined)?.data;

  const renderStatus = (status: CapabilityStatus) => (
    <Tag color={STATUS_COLORS[status]}>{t(STATUS_LABELS[status])}</Tag>
  );

  const nativeCapabilityColumns = [
    {
      title: t('Harness capability'),
      dataIndex: 'labelKey',
      key: 'labelKey',
      width: 190,
      render: (labelKey: string) => t(labelKey),
    },
    {
      title: t('Settings'),
      dataIndex: 'settings',
      key: 'settings',
      width: 190,
      render: (settings: string[]) => settings.join(', '),
    },
    ...(capabilityMatrix?.scopes || []).map((scope) => ({
      title: t(scope === 'sub-agent' ? 'Native sub-agent' : `Native ${scope}`),
      key: scope,
      width: 250,
      render: (_: unknown, record: CapabilityMatrix['nativeCapabilities'][number]) => {
        const capability = record.byScope[scope];
        return (
          <Space direction="vertical" size={2}>
            {renderStatus(capability.status)}
            <Text type="secondary">{t(capability.reasonKey)}</Text>
          </Space>
        );
      },
    })),
  ];

  const scopedCapabilityColumns = [
    {
      title: t('Harness capability'),
      dataIndex: 'labelKey',
      key: 'labelKey',
      width: 220,
      render: (labelKey: string) => t(labelKey),
    },
    {
      title: t('Settings'),
      dataIndex: 'settings',
      key: 'settings',
      width: 240,
      render: (settings: string[]) => settings.join(', '),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: CapabilityStatus) => renderStatus(status),
    },
    {
      title: t('Enforcement scope'),
      dataIndex: 'scopeKey',
      key: 'scopeKey',
      width: 240,
      render: (scopeKey: string, record: CapabilityMatrix['scopedCapabilities'][number]) => (
        <Space direction="vertical" size={2}>
          <Text>{t(scopeKey)}</Text>
          <Text type="secondary">{t(record.detailKey)}</Text>
        </Space>
      ),
    },
  ];

  const openDraft = versions.find((version) => version.status === 'draft');
  const latestPublished = versions.find((version) => version.status === 'published');

  const loadVersions = async (profileId: number) => {
    setVersionsLoading(true);
    try {
      const response = await api.request({
        url: 'agentHarnessProfiles:listVersions',
        params: { filterByTk: profileId },
      });
      const listed = (response?.data as { data?: ProfileVersion[] } | undefined)?.data;
      const next = Array.isArray(listed) ? listed : [];
      setVersions(next);
      return next;
    } catch {
      setVersions([]);
      return [];
    } finally {
      setVersionsLoading(false);
    }
  };

  const openDrawer = async (record?: ProfileRow) => {
    setEditingRecord(record || null);
    form.resetFields();
    if (record) {
      form.setFieldsValue({
        tag: record.tag,
        title: record.title,
        description: record.description,
        enabled: record.enabled !== false,
      });
      const loaded = await loadVersions(record.id);
      const draft = loaded.find((version) => version.status === 'draft');
      const published = loaded.find((version) => version.status === 'published');
      setSettingsText(formatSettings(draft?.settings ?? published?.settings ?? record.settings));
    } else {
      form.setFieldsValue({ tag: '', title: '', description: '', enabled: true });
      setSettingsText(formatSettings(DEFAULT_SETTINGS));
      setVersions([]);
    }
    setOpen(true);
  };

  const closeDrawer = () => {
    setOpen(false);
    setEditingRecord(null);
    setVersions([]);
  };

  const readEditorSettings = (): Record<string, unknown> | null => {
    try {
      return parseSettings(settingsText);
    } catch (error) {
      message.error(t('Settings JSON is invalid: {{message}}', { message: (error as Error).message }));
      return null;
    }
  };

  const saveDetails = async (values: ProfileFormValues) => {
    if (!editingRecord) return;
    setSavingDetails(true);
    try {
      await api.request({
        url: 'agentHarnessProfiles:update',
        method: 'put',
        params: { filterByTk: editingRecord.id },
        data: {
          title: values.title,
          description: values.description,
          enabled: values.enabled !== false,
        },
      });
      message.success(t('Policy profile updated'));
      refresh();
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorMessage(error, t('unknown error')) }));
    } finally {
      setSavingDetails(false);
    }
  };

  const createProfile = async (values: ProfileFormValues) => {
    const settings = readEditorSettings();
    if (!settings) return;
    setCreating(true);
    try {
      await api.request({
        url: 'agentHarnessProfiles:createProfile',
        method: 'post',
        data: {
          tag: String(values.tag || '').trim(),
          title: values.title,
          description: values.description,
          enabled: values.enabled !== false,
          settings,
        },
      });
      message.success(t('Policy profile created'));
      closeDrawer();
      refresh();
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorMessage(error, t('unknown error')) }));
    } finally {
      setCreating(false);
    }
  };

  // Saving writes the editor content into the single open draft (creating the next version
  // number when the previous draft already shipped), so the history stays one clean publish trail.
  const saveDraft = async (announce = true): Promise<ProfileVersion | null> => {
    if (!editingRecord) return null;
    const settings = readEditorSettings();
    if (!settings) return null;
    setSavingDraft(true);
    try {
      const response = await api.request({
        url: 'agentHarnessProfiles:saveDraft',
        method: 'post',
        params: { filterByTk: editingRecord.id },
        data: { settings },
      });
      const saved = (response?.data as { data?: ProfileVersion } | undefined)?.data;
      if (announce) message.success(t('Draft saved'));
      await loadVersions(editingRecord.id);
      refresh();
      return saved || null;
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorMessage(error, t('unknown error')) }));
      return null;
    } finally {
      setSavingDraft(false);
    }
  };

  const publishVersion = async (versionId: number) => {
    setPublishingVersionId(versionId);
    try {
      await api.request({
        url: 'agentHarnessProfiles:publish',
        method: 'post',
        params: { filterByTk: versionId },
        data: { versionId },
      });
      message.success(t('Version published'));
      if (editingRecord) await loadVersions(editingRecord.id);
      refresh();
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorMessage(error, t('unknown error')) }));
    } finally {
      setPublishingVersionId(null);
    }
  };

  // Publish always ships what the editor shows: persist the content as the open draft first,
  // then flip that draft to published.
  const publishDraft = async () => {
    if (!editingRecord) return;
    setPublishing(true);
    try {
      const draft = await saveDraft(false);
      if (!draft) return;
      await api.request({
        url: 'agentHarnessProfiles:publish',
        method: 'post',
        params: { filterByTk: draft.id },
        data: { versionId: draft.id },
      });
      message.success(t('Version published'));
      await loadVersions(editingRecord.id);
      refresh();
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorMessage(error, t('unknown error')) }));
    } finally {
      setPublishing(false);
    }
  };

  const validateSettings = async () => {
    const settings = readEditorSettings();
    if (!settings) return;
    try {
      const response = await api.request({
        url: 'agentHarnessProfiles:validate',
        method: 'post',
        data: { settings },
      });
      const result = (response?.data as { data?: { success?: boolean; issues?: string[] } } | undefined)?.data;
      if (result?.success) {
        message.success(t('Settings are valid'));
      } else {
        message.error(result?.issues?.join('; ') || t('Settings are invalid'));
      }
    } catch (error) {
      message.error(t('Save failed: {{message}}', { message: errorMessage(error, t('unknown error')) }));
    }
  };

  const deleteProfile = async (id: string | number) => {
    try {
      await api.request({
        url: 'agentHarnessProfiles:destroy',
        method: 'delete',
        params: { filterByTk: id },
      });
      message.success(t('Policy profile deleted'));
      refresh();
    } catch (error) {
      message.error(t('Delete failed: {{message}}', { message: errorMessage(error, t('unknown error')) }));
    }
  };

  const columns = [
    {
      title: t('Tag'),
      dataIndex: 'tag',
      key: 'tag',
      width: 140,
      render: (tag: string) => <Tag color="blue">{tag}</Tag>,
    },
    {
      title: t('Title'),
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record: ProfileRow) => title || record.tag,
    },
    {
      title: t('Version'),
      key: 'version',
      width: 110,
      render: (_: unknown, record: ProfileRow) =>
        record.currentVersion ? (
          <Tag color="green">v{record.currentVersion.version}</Tag>
        ) : (
          <Text type="secondary">{t('None')}</Text>
        ),
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (enabled: boolean, record: ProfileRow) => (
        <Switch
          size="small"
          checked={enabled !== false}
          onChange={async (checked) => {
            await api.request({
              url: 'agentHarnessProfiles:update',
              method: 'put',
              params: { filterByTk: record.id },
              data: { enabled: checked },
            });
            refresh();
          }}
        />
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 150,
      render: (_: unknown, record: ProfileRow) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openDrawer(record)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this profile?')} onConfirm={() => deleteProfile(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const versionColumns = [
    {
      title: t('Version'),
      key: 'version',
      width: 80,
      render: (_: unknown, record: ProfileVersion) => `v${record.version}`,
    },
    {
      title: t('Status'),
      key: 'status',
      width: 110,
      render: (_: unknown, record: ProfileVersion) =>
        record.status === 'published' ? (
          <Tag color="green">{t('Published')}</Tag>
        ) : (
          <Tag color="gold">{t('Draft')}</Tag>
        ),
    },
    {
      title: t('Published at'),
      key: 'publishedAt',
      render: (_: unknown, record: ProfileVersion) => formatDate(record.publishedAt),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 110,
      render: (_: unknown, record: ProfileVersion) =>
        record.status === 'draft' ? (
          <Button
            type="link"
            size="small"
            icon={<CheckOutlined />}
            loading={publishingVersionId === record.id}
            onClick={() => publishVersion(record.id)}
          >
            {t('Publish')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message={t('Native harness support')}
            description={t(capabilityMatrix?.noteKey || 'Harness capability: native enforcement boundary')}
          />
          <Table
            aria-label={t('Native harness capability matrix')}
            rowKey="id"
            size="small"
            loading={capabilitiesLoading}
            dataSource={capabilityMatrix?.nativeCapabilities || []}
            columns={nativeCapabilityColumns}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
          <Text strong>{t('Scoped plugin-owned enforcement')}</Text>
          <Table
            aria-label={t('Plugin-owned harness capabilities')}
            rowKey="id"
            size="small"
            loading={capabilitiesLoading}
            dataSource={capabilityMatrix?.scopedCapabilities || []}
            columns={scopedCapabilityColumns}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
          <Alert
            type="info"
            showIcon
            message={t('Telemetry settings are plugin-local')}
            description={t(
              capabilityMatrix?.telemetrySettings.noteKey || 'Harness capability: telemetry settings scope',
            )}
          />
          <Text type="secondary">{capabilityMatrix?.telemetrySettings.settings.join(', ')}</Text>
        </Space>
      </Card>

      <Card bordered={false}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <Text type="secondary">
              {t('Harness profiles keep versioned settings; native runtime support is shown above by capability.')}
            </Text>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
              {t('New Policy')}
            </Button>
          </div>
          <Table
            rowKey="id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
        </Space>
      </Card>

      <Drawer
        title={editingRecord ? t('Edit Policy Profile') : t('New Policy Profile')}
        width={640}
        open={open}
        onClose={closeDrawer}
        extra={
          editingRecord ? undefined : (
            <Space>
              <Button onClick={closeDrawer}>{t('Cancel')}</Button>
              <Button type="primary" loading={creating} onClick={() => form.submit()}>
                {t('Create')}
              </Button>
            </Space>
          )
        }
      >
        <Form form={form} layout="vertical" onFinish={editingRecord ? saveDetails : createProfile}>
          <Form.Item name="tag" label={t('Tag')} rules={[{ required: !editingRecord, message: t('Tag is required') }]}>
            <Input placeholder={t('default')} disabled={Boolean(editingRecord)} />
          </Form.Item>
          <Form.Item name="title" label={t('Title')}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          {editingRecord && (
            <Form.Item>
              <Button loading={savingDetails} onClick={() => form.submit()}>
                {t('Save details')}
              </Button>
            </Form.Item>
          )}
        </Form>

        <Divider orientation="left">{t('Settings draft')}</Divider>
        {editingRecord && (
          <Space size={16} style={{ marginBottom: 12 }} wrap>
            <Text>
              {t('Current version')}:{' '}
              {latestPublished ? (
                <Tag color="green">v{latestPublished.version}</Tag>
              ) : (
                <Text type="secondary">{t('None')}</Text>
              )}
            </Text>
            {openDraft && (
              <Tag color="gold">
                {t('Open draft')}: v{openDraft.version}
              </Tag>
            )}
          </Space>
        )}
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          {t('Saving updates the open draft (or creates one). Publishing makes the draft the active version.')}
        </Text>
        <Input.TextArea
          aria-label={t('Settings JSON')}
          rows={12}
          spellCheck={false}
          value={settingsText}
          onChange={(event) => setSettingsText(event.target.value)}
        />
        <Space style={{ marginTop: 12 }} wrap>
          {editingRecord ? (
            <>
              <Button icon={<SaveOutlined />} loading={savingDraft} onClick={() => saveDraft()}>
                {t('Save draft')}
              </Button>
              <Button type="primary" icon={<CheckOutlined />} loading={publishing} onClick={publishDraft}>
                {t('Publish')}
              </Button>
            </>
          ) : null}
          <Button onClick={validateSettings}>{t('Validate')}</Button>
        </Space>

        {editingRecord && (
          <>
            <Divider orientation="left">{t('Version history')}</Divider>
            <Table
              rowKey="id"
              size="small"
              loading={versionsLoading}
              dataSource={versions}
              columns={versionColumns}
              pagination={false}
            />
          </>
        )}
      </Drawer>
    </div>
  );
};
