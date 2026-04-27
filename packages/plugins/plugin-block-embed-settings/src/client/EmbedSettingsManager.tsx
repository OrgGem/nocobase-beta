import React, { useMemo } from 'react';
import { Table, Button, Switch, Empty, Space, Popconfirm, Typography } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAPIClient, useApp, useCompile, useRequest } from '@nocobase/client';
import { useT } from './locale';
import { collectEmbeddablePlugins, normalizeAllowedRecords } from './EmbedSettingsPluginSelect';

const { Title } = Typography;

export const EmbedSettingsManager: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const app = useApp();
  const compile = useCompile();

  const { data, loading, refresh } = useRequest<any>({
    resource: 'embedAllowedPlugins',
    action: 'list',
    params: { pageSize: 200 },
  });

  const allPlugins = useMemo(() => collectEmbeddablePlugins(app, compile), [app, compile]);

  const allowedRecords: any[] = normalizeAllowedRecords(data);
  const allowedKeys = new Set(allowedRecords.map((r: any) => r.pluginName));

  const availablePlugins = allPlugins.filter((p) => !allowedKeys.has(p.value));

  const handleAdd = async (pluginName: string, title: string) => {
    await api.resource('embedAllowedPlugins').create({
      values: { pluginName, title, enabled: true },
    });
    refresh();
  };

  const handleToggle = async (id: number, enabled: boolean) => {
    await api.resource('embedAllowedPlugins').update({
      filterByTk: id,
      values: { enabled },
    });
    refresh();
  };

  const handleRemove = async (id: number) => {
    await api.resource('embedAllowedPlugins').destroy({
      filterByTk: id,
    });
    refresh();
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
      render: (enabled: boolean, record: any) => (
        <Switch checked={enabled} onChange={(val) => handleToggle(record.id, val)} />
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 100,
      render: (_: any, record: any) => (
        <Popconfirm title={t('Confirm remove?')} onConfirm={() => handleRemove(record.id)}>
          <Button type="link" danger icon={<DeleteOutlined />} />
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
