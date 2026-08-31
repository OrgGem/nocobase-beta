import React, { useMemo, useState } from 'react';
import { Table, Button, Switch, Empty, Space, Popconfirm, Typography, message, Spin } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { useT } from './locale';
import { collectEmbeddablePlugins, normalizeAllowedRecords } from './EmbedSettingsPluginSelect';
import type { AllowedPluginRecord } from './types';

const { Title } = Typography;

export const EmbedSettingsManager: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [togglingIds, setTogglingIds] = useState<Set<number>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set());
  const [addingPlugin, setAddingPlugin] = useState<string | null>(null);

  const { data, loading, refresh } = useRequest(() => api.resource('embedAllowedPlugins').list({ pageSize: 200 }));

  const allPlugins = useMemo(() => collectEmbeddablePlugins(app), [app]);

  const allowedRecords: AllowedPluginRecord[] = normalizeAllowedRecords(data);
  const allowedKeys = new Set(allowedRecords.map((r) => r.pluginName));

  const availablePlugins = allPlugins.filter((p) => !allowedKeys.has(p.value));

  const handleAdd = async (pluginName: string, title: string) => {
    setAddingPlugin(pluginName);
    try {
      await api.resource('embedAllowedPlugins').create({
        values: { pluginName, title, enabled: true },
      });
      message.success(t('Saved successfully'));
      refresh();
    } catch (error) {
      console.error('[EmbedSettingsManager] Failed to add plugin:', error);
      message.error(t('Save failed'));
    } finally {
      setAddingPlugin(null);
    }
  };

  const handleToggle = async (id: number, enabled: boolean) => {
    setTogglingIds((prev) => new Set(prev).add(id));
    try {
      await api.resource('embedAllowedPlugins').update({
        filterByTk: id,
        values: { enabled },
      });
      message.success(t('Saved successfully'));
      refresh();
    } catch (error) {
      console.error('[EmbedSettingsManager] Failed to toggle plugin:', error);
      message.error(t('Save failed'));
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleRemove = async (id: number) => {
    setRemovingIds((prev) => new Set(prev).add(id));
    try {
      await api.resource('embedAllowedPlugins').destroy({
        filterByTk: id,
      });
      message.success(t('Saved successfully'));
      refresh();
    } catch (error) {
      console.error('[EmbedSettingsManager] Failed to remove plugin:', error);
      message.error(t('Save failed'));
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const columns = [
    {
      title: t('Plugin name'),
      dataIndex: 'pluginName',
      key: 'pluginName',
    },
    {
      title: t('Display title'),
      dataIndex: 'title',
      key: 'title',
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean, record: AllowedPluginRecord) => (
        <Switch
          checked={enabled}
          loading={togglingIds.has(record.id)}
          onChange={(val) => handleToggle(record.id, val)}
        />
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 100,
      render: (_: unknown, record: AllowedPluginRecord) => (
        <Popconfirm title={t('Confirm remove?')} onConfirm={() => handleRemove(record.id)}>
          <Button type="link" danger icon={<DeleteOutlined />} loading={removingIds.has(record.id)} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={5} style={{ margin: 0 }}>
          {t('Allowed plugins for embedding')}
        </Title>
      </div>

      {availablePlugins.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Space wrap>
            {availablePlugins.map((p) => (
              <Button
                key={p.value}
                size="small"
                icon={<PlusOutlined />}
                loading={addingPlugin === p.value}
                onClick={() => handleAdd(p.value, p.label)}
              >
                {p.label}
              </Button>
            ))}
          </Space>
        </div>
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={allowedRecords}
        columns={columns}
        pagination={false}
        locale={{ emptyText: <Empty description={t('No plugins registered yet')} /> }}
      />
    </div>
  );
};
