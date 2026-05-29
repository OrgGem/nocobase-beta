import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Popconfirm, Space, Spin, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, ExclamationCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT } from './utils';

interface PluginRecord {
  name: string;
  packageName?: string;
  displayName?: string;
  description?: string;
  version?: string;
  enabled?: boolean;
  installed?: boolean;
  loaded?: boolean;
  protected?: boolean;
}

function getErrorMessage(err: any, fallback: string) {
  return err?.response?.data?.errors?.[0]?.message || err?.message || fallback;
}

export function PluginOperations() {
  const t = useT();
  const api = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'clusterManagerPlugins:list' });
      const data = Array.isArray(res?.data?.data?.data)
        ? res.data.data.data
        : Array.isArray(res?.data?.data)
        ? res.data.data
        : Array.isArray(res?.data)
        ? res.data
        : [];
      setPlugins(data);
    } catch (err: any) {
      message.error(getErrorMessage(err, t('Failed to load plugins')));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredPlugins = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const list = Array.isArray(plugins) ? plugins : [];
    if (!keyword) return list;
    return list.filter((plugin) =>
      [plugin.name, plugin.packageName, plugin.displayName, plugin.description]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword)),
    );
  }, [plugins, search]);

  const handleForceDisable = async (record: PluginRecord) => {
    const key = `${record.name}:disable`;
    setActionKey(key);
    try {
      const res = await api.request({
        url: 'clusterManagerPlugins:forceDisable',
        method: 'post',
        data: { name: record.name },
      });
      message.success(res?.data?.data?.message || res?.data?.message || t('Plugin force disabled'));
      await fetchData();
    } catch (err: any) {
      message.error(getErrorMessage(err, t('Failed to force disable plugin')));
    } finally {
      setActionKey(null);
    }
  };

  const handleForceRemove = async (record: PluginRecord) => {
    const key = `${record.name}:remove`;
    setActionKey(key);
    try {
      const res = await api.request({
        url: 'clusterManagerPlugins:forceRemove',
        method: 'post',
        data: { name: record.name },
      });
      message.success(res?.data?.data?.message || res?.data?.message || t('Plugin force removed'));
      await fetchData();
    } catch (err: any) {
      message.error(getErrorMessage(err, t('Failed to force remove plugin')));
    } finally {
      setActionKey(null);
    }
  };

  const columns = [
    {
      title: t('Plugin'),
      dataIndex: 'displayName',
      key: 'displayName',
      render: (_: string, record: PluginRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.displayName || record.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.packageName || record.name}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Name'),
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (name: string) => <code style={{ fontSize: 12 }}>{name}</code>,
    },
    {
      title: t('Status'),
      key: 'status',
      width: 260,
      render: (_: any, record: PluginRecord) => (
        <Space wrap size={[4, 4]}>
          <Tag color={record.enabled ? 'green' : 'default'}>
            {record.enabled ? t('Enabled') : t('Disabled')}
          </Tag>
          <Tag color={record.installed ? 'blue' : 'default'}>
            {record.installed ? t('Installed') : t('Not installed')}
          </Tag>
          <Tag color={record.loaded ? 'processing' : 'default'}>
            {record.loaded ? t('Loaded') : t('Not loaded')}
          </Tag>
          {record.protected && <Tag color="red">{t('Protected')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('Version'),
      dataIndex: 'version',
      key: 'version',
      width: 120,
      render: (version: string) => version || '-',
    },
    {
      title: t('Description'),
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (description: string) => description || '-',
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 250,
      render: (_: any, record: PluginRecord) => (
        <Space>
          <Popconfirm
            title={t('Force disable this plugin?')}
            description={t('This updates the plugin registry directly. Restart or reload is required to fully unload runtime hooks.')}
            disabled={record.protected || !record.enabled}
            onConfirm={() => handleForceDisable(record)}
            okText={t('Force disable')}
            cancelText={t('Cancel')}
          >
            <Button
              size="small"
              icon={<StopOutlined />}
              disabled={record.protected || !record.enabled}
              loading={actionKey === `${record.name}:disable`}
            >
              {t('Force disable')}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t('Force remove this plugin?')}
            description={t('This removes the plugin registry record. Package files are not deleted. Restart or reload is required.')}
            disabled={record.protected}
            onConfirm={() => handleForceRemove(record)}
            okText={t('Force remove')}
            cancelText={t('Cancel')}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={record.protected}
              loading={actionKey === `${record.name}:remove`}
            >
              {t('Force remove')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message={t('Force operations bypass plugin lifecycle hooks')}
          description={t('Use this only when the normal plugin manager cannot disable or remove a broken plugin. Restart or reload the app after a successful operation.')}
        />
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchData}>
            {t('Refresh')}
          </Button>
          <Input.Search
            allowClear
            placeholder={t('Search plugins')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: 320 }}
          />
        </Space>
        <Table
          rowKey="name"
          size="small"
          dataSource={filteredPlugins}
          columns={columns}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1100 }}
        />
      </Space>
    </Spin>
  );
}
