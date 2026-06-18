/**
 * MemorySettingsPage — Admin settings page for the User Memory plugin.
 *
 * Provides:
 * - Global enable/disable toggle
 * - LLM service/model selection for synthesis
 * - Cron schedule configuration
 * - Token budget settings
 * - Manual sync trigger for all users
 * - User profile list with individual sync controls
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Card,
  Switch,
  Button,
  Input,
  InputNumber,
  Form,
  message,
  Table,
  Tag,
  Space,
  Typography,
  Divider,
  Modal,
  Tabs,
  Select,
} from 'antd';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../../client-v2/locale';
import {
  SyncOutlined,
  SettingOutlined,
  UserOutlined,
  HistoryOutlined,
  DeleteOutlined,
  EyeOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

const MemorySettingsPage: React.FC = () => {
  const app = useApp();
  const api = app.apiClient;
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<any>(null);
  const [myProfile, setMyProfile] = useState<any>(null);
  const [syncLogs, setSyncLogs] = useState<any[]>([]);
  const [llmServices, setLlmServices] = useState<any[]>([]);
  const [selectedService, setSelectedService] = useState<string | undefined>(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const [form] = Form.useForm();

  // Load settings
  const loadSettings = useCallback(async () => {
    try {
      const { data } = await api.request({ url: 'userMemoryAdmin:getSettings' });
      setIsAdmin(true);
      setSettings(data?.data || {});
      form.setFieldsValue(data?.data || {});
      setSelectedService(data?.data?.llmService);
    } catch (e) {
      setIsAdmin(false);
    }
  }, [api, form]);

  // Load available LLM services and their models
  const loadLlmServices = useCallback(async () => {
    try {
      const res = await api.request({ url: 'ai:listAllEnabledModels' });
      setLlmServices(res?.data?.data || []);
    } catch (e) {
      console.warn('Failed to load LLM services:', e);
    }
  }, [api]);

  // Load my profile
  const loadMyProfile = useCallback(async () => {
    try {
      const { data } = await api.request({ url: 'userMemory:getProfile' });
      setMyProfile(data?.data || null);
    } catch (e) {
      console.warn('Failed to load profile:', e);
    }
  }, [api]);

  // Load all profiles (admin)
  const loadProfiles = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const { data } = await api.request({ url: 'userMemoryAdmin:listProfiles' });
      setProfiles(data?.data?.rows || []);
    } catch (e) {
      // silently ignore for non-admin
    }
  }, [api, isAdmin]);

  // Load sync logs
  const loadSyncLogs = useCallback(async () => {
    try {
      const { data } = await api.request({ url: 'userMemory:getSyncLogs' });
      setSyncLogs(data?.data?.rows || []);
    } catch (e) {
      console.warn('Failed to load sync logs:', e);
    }
  }, [api]);

  useEffect(() => {
    loadSettings();
    loadMyProfile();
    loadProfiles();
    loadSyncLogs();
    if (isAdmin) {
      loadLlmServices();
    }
  }, [loadSettings, loadMyProfile, loadProfiles, loadSyncLogs, loadLlmServices, isAdmin]);

  // Save settings
  const handleSaveSettings = useCallback(
    async (values: any) => {
      setLoading(true);
      try {
        await api.request({
          url: 'userMemoryAdmin:updateSettings',
          method: 'post',
          data: values,
        });
        message.success('Settings saved');
        loadSettings();
      } catch (e) {
        message.error('Failed to save settings');
      } finally {
        setLoading(false);
      }
    },
    [api, loadSettings],
  );

  // Sync now (my profile)
  const handleSyncNow = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'userMemory:syncNow', method: 'post' });
      if (data?.data?.result === 'rate_limited') {
        message.warning(data.data.message || 'Please wait before syncing again');
      } else {
        message.success('Sync completed');
      }
      loadMyProfile();
      loadSyncLogs();
    } catch (e) {
      message.error('Sync failed');
    } finally {
      setLoading(false);
    }
  }, [api, loadMyProfile, loadSyncLogs]);

  // Sync all users (admin)
  const handleSyncAll = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'userMemoryAdmin:syncAll', method: 'post' });
      message.success(
        `Sync complete: ${data?.data?.processed || 0} processed, ${data?.data?.skipped || 0} skipped, ${
          data?.data?.errors || 0
        } errors`,
      );
      loadProfiles();
    } catch (e) {
      message.error('Batch sync failed');
    } finally {
      setLoading(false);
    }
  }, [api, loadProfiles]);

  // Toggle memory
  const handleToggle = useCallback(
    async (enabled: boolean) => {
      try {
        await api.request({
          url: 'userMemory:toggleEnabled',
          method: 'post',
          data: { enabled },
        });
        message.success(enabled ? 'Memory enabled' : 'Memory disabled');
        loadMyProfile();
      } catch (e) {
        message.error('Failed to toggle memory');
      }
    },
    [api, loadMyProfile],
  );

  // Clear memory
  const handleClearMemory = useCallback(() => {
    Modal.confirm({
      title: 'Clear Memory',
      content: 'Are you sure you want to clear your memory profile? This cannot be undone.',
      onOk: async () => {
        try {
          await api.request({ url: 'userMemory:clearMemory', method: 'post' });
          message.success('Memory cleared');
          loadMyProfile();
        } catch (e) {
          message.error('Failed to clear memory');
        }
      },
    });
  }, [api, loadMyProfile]);

  const profileColumns = useMemo(
    () => [
      { title: 'User ID', dataIndex: 'userId', key: 'userId' },
      {
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        render: (status: string) => (
          <Tag color={status === 'idle' ? 'green' : status === 'processing' ? 'blue' : 'red'}>{status}</Tag>
        ),
      },
      { title: 'Version', dataIndex: 'memoryVersion', key: 'memoryVersion' },
      {
        title: 'Enabled',
        dataIndex: 'enabled',
        key: 'enabled',
        render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? 'Yes' : 'No'}</Tag>,
      },
      {
        title: 'Last Synced',
        dataIndex: 'lastSyncedAt',
        key: 'lastSyncedAt',
        render: (v: string) => (v ? new Date(v).toLocaleString() : 'Never'),
      },
      {
        title: 'Actions',
        key: 'actions',
        render: (_: any, record: any) => (
          <Button size="small" icon={<EyeOutlined />} onClick={() => setSelectedProfile(record)}>
            View
          </Button>
        ),
      },
    ],
    [],
  );

  const logColumns = useMemo(
    () => [
      {
        title: 'Date',
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (v: string) => new Date(v).toLocaleString(),
      },
      { title: 'Type', dataIndex: 'syncType', key: 'syncType' },
      {
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        render: (v: string) => <Tag color={v === 'success' ? 'green' : v === 'error' ? 'red' : 'default'}>{v}</Tag>,
      },
      { title: 'Conversations', dataIndex: 'conversationsProcessed', key: 'conversationsProcessed' },
      { title: 'Messages', dataIndex: 'messagesProcessed', key: 'messagesProcessed' },
      { title: 'Version', key: 'version', render: (_: any, r: any) => `v${r.previousVersion} → v${r.newVersion}` },
      { title: 'Summary', dataIndex: 'changeSummary', key: 'changeSummary', ellipsis: true },
    ],
    [],
  );

  const modelOptions = useMemo(() => {
    const serviceObj = llmServices.find((s) => s.llmService === selectedService);
    if (!serviceObj) return [];
    return (serviceObj.enabledModels || []).map((m: any) => ({
      value: m.value,
      label: m.label || m.value,
    }));
  }, [selectedService, llmServices]);

  // Build tab items (modern Ant Design 5.x API — no deprecated TabPane)
  const tabItems = useMemo(() => {
    const items: any[] = [
      {
        key: 'my-profile',
        label: (
          <span>
            <UserOutlined /> My Profile
          </span>
        ),
        children: (
          <Card>
            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <Space>
                <Text strong>Memory:</Text>
                <Switch
                  checked={myProfile?.enabled}
                  onChange={handleToggle}
                  checkedChildren="Enabled"
                  unCheckedChildren="Disabled"
                />
                <Button icon={<SyncOutlined spin={loading} />} onClick={handleSyncNow} loading={loading}>
                  Sync Now
                </Button>
                <Button icon={<DeleteOutlined />} onClick={handleClearMemory} danger>
                  Clear
                </Button>
              </Space>

              {myProfile?.lastSyncedAt && (
                <Text type="secondary">
                  Last synced: {new Date(myProfile.lastSyncedAt).toLocaleString()} | Version: v{myProfile.memoryVersion}
                </Text>
              )}

              <Divider />

              {myProfile?.memoryContent ? (
                <div
                  style={{
                    background: '#f6f8fa',
                    padding: 16,
                    borderRadius: 8,
                    fontFamily: 'monospace',
                    fontSize: 13,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 500,
                    overflow: 'auto',
                  }}
                >
                  {myProfile.memoryContent}
                </div>
              ) : (
                <Text type="secondary">
                  No memory profile yet. Chat with AI employees to build your memory profile, then sync.
                </Text>
              )}
            </Space>
          </Card>
        ),
      },
    ];

    // Admin-only tabs
    if (isAdmin) {
      items.push(
        {
          key: 'settings',
          label: (
            <span>
              <SettingOutlined /> Settings
            </span>
          ),
          children: (
            <Card>
              <Form form={form} layout="vertical" onFinish={handleSaveSettings} initialValues={settings}>
                <Form.Item name="enabled" label="Global Enable" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="syncSchedule" label="Sync Schedule (Cron)">
                  <Input placeholder="0 0 3 * * *" />
                </Form.Item>
                <Form.Item name="llmService" label="LLM Service (for synthesis)">
                  <Select
                    placeholder="Select LLM Service (or empty for default)"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={llmServices.map((svc) => ({
                      value: svc.llmService,
                      label: svc.llmServiceTitle || svc.llmService,
                    }))}
                    onChange={(val) => {
                      setSelectedService(val);
                      form.setFieldValue('llmModel', undefined);
                    }}
                  />
                </Form.Item>
                <Form.Item name="llmModel" label="LLM Model">
                  <Select
                    placeholder="Select LLM Model (or empty for default)"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={modelOptions}
                    disabled={!selectedService}
                  />
                </Form.Item>
                <Form.Item name="maxTokens" label="Max Tokens (memory budget)">
                  <InputNumber min={100} max={4000} />
                </Form.Item>
                <Form.Item name="maxConversationsPerSync" label="Max Conversations Per Sync">
                  <InputNumber min={5} max={200} />
                </Form.Item>
                <Form.Item name="syncLogRetentionDays" label="Log Retention (days)">
                  <InputNumber min={1} max={365} />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit" loading={loading}>
                    Save Settings
                  </Button>
                </Form.Item>
              </Form>
            </Card>
          ),
        },
        {
          key: 'profiles',
          label: (
            <span>
              <UserOutlined /> All Profiles
            </span>
          ),
          children: (
            <Card>
              <Space style={{ marginBottom: 16 }}>
                <Button icon={<SyncOutlined />} onClick={handleSyncAll} loading={loading} type="primary">
                  Sync All Users
                </Button>
                <Button onClick={loadProfiles}>Refresh</Button>
              </Space>
              <Table dataSource={profiles} columns={profileColumns} rowKey="id" size="small" />
            </Card>
          ),
        },
      );
    }

    // Sync history tab (visible to all)
    items.push({
      key: 'logs',
      label: (
        <span>
          <HistoryOutlined /> Sync History
        </span>
      ),
      children: (
        <Card>
          <Button onClick={loadSyncLogs} style={{ marginBottom: 16 }}>
            Refresh
          </Button>
          <Table dataSource={syncLogs} columns={logColumns} rowKey="id" size="small" />
        </Card>
      ),
    });

    return items;
  }, [
    myProfile,
    loading,
    isAdmin,
    settings,
    profiles,
    syncLogs,
    form,
    handleToggle,
    handleSyncNow,
    handleClearMemory,
    handleSaveSettings,
    handleSyncAll,
    loadProfiles,
    loadSyncLogs,
    profileColumns,
    logColumns,
    llmServices,
    selectedService,
    modelOptions,
  ]);

  return (
    <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
      <Title level={3}>🧠 User Memory</Title>
      <Paragraph type="secondary">
        Automatically synthesizes user chat history into personalized memory profiles that help AI employees provide
        more accurate and friendly responses.
      </Paragraph>

      <Tabs defaultActiveKey="my-profile" items={tabItems} />

      {/* Profile viewer modal */}
      <Modal
        title="Memory Profile"
        open={!!selectedProfile}
        onCancel={() => setSelectedProfile(null)}
        footer={null}
        width={700}
      >
        {selectedProfile && (
          <div
            style={{
              background: '#f6f8fa',
              padding: 16,
              borderRadius: 8,
              fontFamily: 'monospace',
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              maxHeight: 500,
              overflow: 'auto',
            }}
          >
            {selectedProfile.memoryContent || 'No memory content'}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default MemorySettingsPage;
