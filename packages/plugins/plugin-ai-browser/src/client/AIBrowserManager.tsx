import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Table,
  Tag,
  Button,
  Space,
  Card,
  Tabs,
  Typography,
  Popconfirm,
  message,
  Badge,
  Input,
  Modal,
  Form,
  InputNumber,
  Switch,
  Drawer,
  Descriptions,
  Tooltip,
} from 'antd';
import {
  GlobalOutlined,
  UserOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  DeleteOutlined,
  EyeOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  EditOutlined,
  SearchOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './locale';

const { Title, Text } = Typography;
const { TextArea } = Input;

function getRecordValue(record: any, key: string) {
  return record?.[key] ?? record?.dataValues?.[key];
}

function linesToArray(value?: string) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function arrayToLines(value?: string[]) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function parseJson(value: string | undefined, fallback: Record<string, any>) {
  if (!value?.trim()) return fallback;
  return JSON.parse(value);
}

function stringifyJson(value: any) {
  return JSON.stringify(value || {}, null, 2);
}

function matchesSearch(record: any, search: string, fields: string[]) {
  const keyword = search.trim().toLowerCase();
  if (!keyword) return true;
  return fields.some((field) => String(getRecordValue(record, field) || '').toLowerCase().includes(keyword));
}

/**
 * AIBrowserManager - admin page for managing sessions, profiles, workflow caches.
 * Registered in plugin settings under "AI Browser".
 */
export const AIBrowserManager: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const [activeTab, setActiveTab] = useState('sessions');
  const [sessions, setSessions] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [caches, setCaches] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [driverStatus, setDriverStatus] = useState<any>(null);
  const [sessionSearch, setSessionSearch] = useState('');
  const [cacheSearch, setCacheSearch] = useState('');
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<any>(null);
  const [profileForm] = Form.useForm();
  const [cacheDetailOpen, setCacheDetailOpen] = useState(false);
  const [cacheDetail, setCacheDetail] = useState<any>(null);
  const [cacheSteps, setCacheSteps] = useState<any[]>([]);
  const [cacheFingerprints, setCacheFingerprints] = useState<any[]>([]);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.resource('aiBrowserSessions').list({ sort: ['-createdAt'], pageSize: 100 });
      setSessions(res?.data?.data || []);
    } catch (err: any) {
      message.error(err?.message || 'Failed to load browser sessions');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.resource('aiBrowserProfiles').list({ sort: ['-updatedAt'], pageSize: 100 });
      setProfiles(res?.data?.data || []);
    } catch (err: any) {
      message.error(err?.message || 'Failed to load browser profiles');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadCaches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.resource('aiBrowserWorkflowCaches').list({
        sort: ['-confidence', '-updatedAt'],
        pageSize: 100,
      });
      setCaches(res?.data?.data || []);
    } catch (err: any) {
      message.error(err?.message || 'Failed to load workflow cache');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadDriverStatus = useCallback(async () => {
    try {
      const res = await api.resource('aiBrowser').getDriverStatus();
      setDriverStatus(res?.data?.data || res?.data);
    } catch {
      setDriverStatus({ available: false });
    }
  }, [api]);

  useEffect(() => {
    loadDriverStatus();
    loadSessions();
  }, [loadDriverStatus, loadSessions]);

  useEffect(() => {
    if (activeTab === 'sessions') loadSessions();
    else if (activeTab === 'profiles') loadProfiles();
    else if (activeTab === 'cache') loadCaches();
  }, [activeTab, loadCaches, loadProfiles, loadSessions]);

  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) =>
        matchesSearch(session, sessionSearch, ['id', 'title', 'status', 'currentUrl', 'conversationId', 'ownerId']),
      ),
    [sessions, sessionSearch],
  );

  const filteredCaches = useMemo(
    () => caches.filter((cache) => matchesSearch(cache, cacheSearch, ['id', 'name', 'domain', 'urlPattern', 'taskIntent'])),
    [caches, cacheSearch],
  );

  const statusColors: Record<string, string> = {
    pending: 'default',
    running: 'processing',
    completed: 'success',
    failed: 'error',
    stopped: 'warning',
    expired: 'default',
  };

  const openProfileModal = (profile?: any) => {
    const policy = getRecordValue(profile, 'defaultPolicy') || {};
    setEditingProfile(profile || null);
    profileForm.setFieldsValue({
      ownerId: getRecordValue(profile, 'ownerId'),
      name: getRecordValue(profile, 'name') || '',
      description: getRecordValue(profile, 'description') || '',
      enabled: profile ? getRecordValue(profile, 'enabled') !== false : true,
      allowedDomains: arrayToLines(policy.allowedDomains),
      deniedDomains: arrayToLines(policy.deniedDomains),
      maxDurationSeconds: policy.maxDurationSeconds || 1800,
      idleTimeoutSeconds: policy.idleTimeoutSeconds || 120,
      maxTabs: policy.maxTabs || 3,
      allowDownloads: Boolean(policy.allowDownloads),
      allowFormSubmit: policy.allowFormSubmit !== false,
      allowLogin: Boolean(policy.allowLogin),
      allowDestructiveActions: Boolean(policy.allowDestructiveActions),
      launchOptions: stringifyJson(getRecordValue(profile, 'launchOptions')),
      metadata: stringifyJson(getRecordValue(profile, 'metadata')),
    });
    setProfileModalOpen(true);
  };

  const saveProfile = async () => {
    try {
      const values = await profileForm.validateFields();
      const defaultPolicy = {
        allowedDomains: linesToArray(values.allowedDomains),
        deniedDomains: linesToArray(values.deniedDomains),
        maxDurationSeconds: values.maxDurationSeconds,
        idleTimeoutSeconds: values.idleTimeoutSeconds,
        maxTabs: values.maxTabs,
        allowDownloads: values.allowDownloads,
        allowFormSubmit: values.allowFormSubmit,
        allowLogin: values.allowLogin,
        allowDestructiveActions: values.allowDestructiveActions,
      };
      const payload = {
        ownerId: values.ownerId,
        name: values.name,
        description: values.description,
        enabled: values.enabled,
        driver: 'playwright',
        defaultPolicy,
        launchOptions: parseJson(values.launchOptions, {}),
        metadata: parseJson(values.metadata, {}),
      };

      if (editingProfile) {
        await api.resource('aiBrowserProfiles').update({
          filterByTk: getRecordValue(editingProfile, 'id'),
          values: payload,
        });
      } else {
        await api.resource('aiBrowserProfiles').create({ values: payload });
      }
      message.success('Browser profile saved');
      setProfileModalOpen(false);
      setEditingProfile(null);
      loadProfiles();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.message || 'Failed to save browser profile');
    }
  };

  const disableProfile = async (profile: any) => {
    await api.resource('aiBrowserProfiles').update({
      filterByTk: getRecordValue(profile, 'id'),
      values: { enabled: false },
    });
    message.success('Browser profile disabled');
    loadProfiles();
  };

  const stopSession = async (session: any) => {
    await api.resource('aiBrowser').stopSession({ values: { sessionId: getRecordValue(session, 'id') } });
    message.success('Browser session stopped');
    loadSessions();
  };

  const buildCacheFromSession = async (session: any) => {
    try {
      await api.resource('aiBrowser').buildWorkflowCache({
        values: {
          sessionId: getRecordValue(session, 'id'),
          name: getRecordValue(session, 'title') || `Workflow ${getRecordValue(session, 'id')}`,
          taskIntent: getRecordValue(session, 'title') || '',
        },
      });
      message.success('Workflow cache created from session steps');
      setActiveTab('cache');
      loadCaches();
    } catch (err: any) {
      message.error(err?.message || 'Failed to build workflow cache');
    }
  };

  const openCacheDetail = async (cache: any) => {
    setCacheDetail(cache);
    setCacheDetailOpen(true);
    const cacheId = getRecordValue(cache, 'id');
    const [stepsRes, fingerprintsRes] = await Promise.all([
      api.resource('aiBrowserCachedSteps').list({ filter: { workflowCacheId: cacheId }, sort: ['order'], pageSize: 100 }),
      api.resource('aiBrowserElementFingerprints').list({
        filter: { workflowCacheId: cacheId },
        sort: ['priority'],
        pageSize: 100,
      }),
    ]);
    setCacheSteps(stepsRes?.data?.data || []);
    setCacheFingerprints(fingerprintsRes?.data?.data || []);
  };

  const toggleCache = async (cache: any) => {
    await api.resource('aiBrowserWorkflowCaches').update({
      filterByTk: getRecordValue(cache, 'id'),
      values: { enabled: !getRecordValue(cache, 'enabled') },
    });
    loadCaches();
  };

  const sessionColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 120, ellipsis: true },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (s: string) => <Tag color={statusColors[s] || 'default'}>{s}</Tag>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    { title: 'Owner', dataIndex: 'ownerId', key: 'ownerId', width: 90 },
    { title: 'URL', dataIndex: 'currentUrl', key: 'currentUrl', ellipsis: true },
    {
      title: 'Started',
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 170,
      render: (d: string) => (d ? new Date(d).toLocaleString() : '-'),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 190,
      render: (_: any, record: any) => (
        <Space>
          <Tooltip title="Create workflow cache from recorded actions">
            <Button icon={<SaveOutlined />} size="small" onClick={() => buildCacheFromSession(record)} />
          </Tooltip>
          {getRecordValue(record, 'status') === 'running' && (
            <Tooltip title="Stop browser session">
              <Button icon={<PauseCircleOutlined />} size="small" onClick={() => stopSession(record)} />
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  const profileColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 110, ellipsis: true },
    { title: 'Owner', dataIndex: 'ownerId', key: 'ownerId', width: 90 },
    { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: 'Policy',
      key: 'policy',
      render: (_: any, record: any) => {
        const policy = getRecordValue(record, 'defaultPolicy') || {};
        return (
          <Space wrap>
            <Tag>{policy.allowedDomains?.length ? `${policy.allowedDomains.length} allow` : 'open allow'}</Tag>
            <Tag color={policy.deniedDomains?.length ? 'red' : 'default'}>{policy.deniedDomains?.length || 0} deny</Tag>
            <Tag>{policy.idleTimeoutSeconds || 120}s idle</Tag>
            <Tag>{policy.maxDurationSeconds || 1800}s max</Tag>
          </Space>
        );
      },
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? 'Yes' : 'No'}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 130,
      render: (_: any, record: any) => (
        <Space>
          <Button icon={<EditOutlined />} size="small" onClick={() => openProfileModal(record)} />
          <Popconfirm title="Disable this profile?" onConfirm={() => disableProfile(record)}>
            <Button icon={<DeleteOutlined />} size="small" danger />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const cacheColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
    { title: 'Domain', dataIndex: 'domain', key: 'domain', width: 170 },
    { title: 'URL Pattern', dataIndex: 'urlPattern', key: 'urlPattern', ellipsis: true },
    {
      title: t('Cache Confidence'),
      dataIndex: 'confidence',
      key: 'confidence',
      width: 130,
      render: (v: number) => `${((v || 0) * 100).toFixed(0)}%`,
    },
    { title: 'Success', dataIndex: 'successCount', key: 'successCount', width: 80 },
    { title: 'Fail', dataIndex: 'failureCount', key: 'failureCount', width: 70 },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 90,
      render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? 'Yes' : 'No'}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      render: (_: any, record: any) => (
        <Space>
          <Button icon={<EyeOutlined />} size="small" onClick={() => openCacheDetail(record)} />
          <Switch size="small" checked={getRecordValue(record, 'enabled') !== false} onChange={() => toggleCache(record)} />
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <Space>
          <GlobalOutlined style={{ fontSize: 24 }} />
          <Title level={4} style={{ margin: 0 }}>{t('AI Browser Automation')}</Title>
          {driverStatus && (
            <Badge
              status={driverStatus.available ? 'success' : 'error'}
              text={driverStatus.available ? `${driverStatus.driver} connected` : 'Driver offline'}
            />
          )}
        </Space>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'sessions',
              label: <span><GlobalOutlined /> {t('Browser Sessions')}</span>,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Input
                      allowClear
                      prefix={<SearchOutlined />}
                      placeholder="Search sessions by id, owner, status, URL"
                      value={sessionSearch}
                      onChange={(event) => setSessionSearch(event.target.value)}
                      style={{ width: 360 }}
                    />
                    <Button icon={<ReloadOutlined />} onClick={loadSessions}>{t('Refresh')}</Button>
                  </Space>
                  <Table
                    dataSource={filteredSessions}
                    columns={sessionColumns}
                    rowKey="id"
                    loading={loading}
                    size="small"
                    pagination={{ pageSize: 20 }}
                  />
                </Space>
              ),
            },
            {
              key: 'profiles',
              label: <span><UserOutlined /> {t('Browser Profiles')}</span>,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Text type="secondary">Latest enabled profile for a user is applied automatically to new chat browser sessions.</Text>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => openProfileModal()}>
                      New profile
                    </Button>
                  </Space>
                  <Table
                    dataSource={profiles}
                    columns={profileColumns}
                    rowKey="id"
                    loading={loading}
                    size="small"
                    pagination={{ pageSize: 20 }}
                  />
                </Space>
              ),
            },
            {
              key: 'cache',
              label: <span><DatabaseOutlined /> {t('Workflow Cache')}</span>,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Input
                      allowClear
                      prefix={<SearchOutlined />}
                      placeholder="Search cache by name, domain, URL, intent"
                      value={cacheSearch}
                      onChange={(event) => setCacheSearch(event.target.value)}
                      style={{ width: 360 }}
                    />
                    <Button icon={<ReloadOutlined />} onClick={loadCaches}>{t('Refresh')}</Button>
                  </Space>
                  <Table
                    dataSource={filteredCaches}
                    columns={cacheColumns}
                    rowKey="id"
                    loading={loading}
                    size="small"
                    pagination={{ pageSize: 20 }}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Space>

      <Modal
        open={profileModalOpen}
        title={editingProfile ? 'Edit browser profile' : 'New browser profile'}
        onCancel={() => setProfileModalOpen(false)}
        onOk={saveProfile}
        width={760}
        okText="Save"
      >
        <Form form={profileForm} layout="vertical">
          <Space style={{ width: '100%' }} size="large" align="start">
            <Form.Item name="ownerId" label="User ID" rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="enabled" label="Enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="name" label="Profile name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input />
          </Form.Item>
          <Space style={{ width: '100%' }} size="large" align="start">
            <Form.Item name="allowedDomains" label="Whitelist domains" style={{ flex: 1 }}>
              <TextArea rows={5} placeholder={'github.com\n*.google.com\n*.example.*'} />
            </Form.Item>
            <Form.Item name="deniedDomains" label="Blacklist domains" style={{ flex: 1 }}>
              <TextArea rows={5} placeholder={'*.ads.example.com\ninternal.*'} />
            </Form.Item>
          </Space>
          <Space wrap>
            <Form.Item name="idleTimeoutSeconds" label="Idle timeout">
              <InputNumber min={30} addonAfter="sec" />
            </Form.Item>
            <Form.Item name="maxDurationSeconds" label="Max duration">
              <InputNumber min={60} addonAfter="sec" />
            </Form.Item>
            <Form.Item name="maxTabs" label="Max tabs">
              <InputNumber min={1} max={20} />
            </Form.Item>
          </Space>
          <Space wrap>
            <Form.Item name="allowDownloads" label="Downloads" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="allowFormSubmit" label="Form submit" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="allowLogin" label="Login" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="allowDestructiveActions" label="Destructive actions" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="launchOptions" label="Launch options JSON">
            <TextArea rows={4} />
          </Form.Item>
          <Form.Item name="metadata" label="Metadata JSON">
            <TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer open={cacheDetailOpen} title="Workflow cache detail" width={720} onClose={() => setCacheDetailOpen(false)}>
        {cacheDetail && (
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Name">{getRecordValue(cacheDetail, 'name')}</Descriptions.Item>
              <Descriptions.Item label="Domain">{getRecordValue(cacheDetail, 'domain') || '-'}</Descriptions.Item>
              <Descriptions.Item label="URL pattern">{getRecordValue(cacheDetail, 'urlPattern') || '-'}</Descriptions.Item>
              <Descriptions.Item label="Intent">{getRecordValue(cacheDetail, 'taskIntent') || '-'}</Descriptions.Item>
            </Descriptions>
            <Table
              title={() => 'Cached steps'}
              dataSource={cacheSteps}
              rowKey="id"
              size="small"
              pagination={false}
              columns={[
                { title: '#', dataIndex: 'order', width: 60 },
                { title: 'Action', dataIndex: 'actionType', width: 90 },
                { title: 'Selector / target', dataIndex: 'targetKey', ellipsis: true },
                { title: 'Confidence', dataIndex: 'confidence', width: 100, render: (v: number) => `${((v || 0) * 100).toFixed(0)}%` },
              ]}
            />
            <Table
              title={() => 'Element fingerprints'}
              dataSource={cacheFingerprints}
              rowKey="id"
              size="small"
              pagination={false}
              columns={[
                { title: 'Target', dataIndex: 'targetKey', ellipsis: true },
                { title: 'CSS selector', dataIndex: 'cssSelector', ellipsis: true },
                { title: 'Confidence', dataIndex: 'confidence', width: 100, render: (v: number) => `${((v || 0) * 100).toFixed(0)}%` },
              ]}
            />
          </Space>
        )}
      </Drawer>
    </Card>
  );
};

export default AIBrowserManager;
