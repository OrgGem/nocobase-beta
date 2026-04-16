import React, { useState } from 'react';
import { Table, Switch, Input, Tag, Button, Drawer, message, Space } from 'antd';
import { ReloadOutlined, EyeOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

export const WorkflowList: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId } = useCurrentInstance();
  const [search, setSearch] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);

  const { data, loading, refresh } = useN8nRequest('n8nWorkflows', 'list', { filter: { search } });

  const workflows = data?.data || data || [];

  const handleToggleActive = async (id: string, active: boolean) => {
    try {
      const action = active ? 'activate' : 'deactivate';
      await api.request({ url: `n8nWorkflows:${action}`, params: { instanceId, filterByTk: id } });
      message.success(t(active ? 'Activated' : 'Deactivated'));
      refresh();
    } catch (err: any) {
      message.error(err.message || t('Failed'));
    }
  };

  const handleViewDetail = async (id: string) => {
    const res = await api.request({ url: 'n8nWorkflows:get', params: { instanceId, filterByTk: id } });
    setDetail(res?.data);
    setDetailOpen(true);
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: t('Active'),
      dataIndex: 'active',
      key: 'active',
      width: 80,
      render: (active: boolean, record: any) => (
        <Switch checked={active} onChange={(checked) => handleToggleActive(record.id, checked)} size="small" />
      ),
    },
    {
      title: t('Tags'),
      dataIndex: 'tags',
      key: 'tags',
      render: (tags: any[]) =>
        tags?.map((tag: any) => (
          <Tag key={tag.id || tag.name} color="blue">
            {tag.name}
          </Tag>
        )),
    },
    {
      title: t('Created'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
    {
      title: t('Updated'),
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 80,
      render: (_: any, record: any) => (
        <Button type="link" icon={<EyeOutlined />} onClick={() => handleViewDetail(record.id)} />
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Input.Search
          placeholder={t('Search workflows...')}
          onSearch={(v) => setSearch(v)}
          allowClear
          style={{ width: 300 }}
        />
        <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table columns={columns} dataSource={workflows} rowKey="id" loading={loading} pagination={{ pageSize: 20 }} />
      <Drawer
        title={detail?.name || t('Workflow Detail')}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={640}
      >
        {detail && <pre style={{ fontSize: 12, overflow: 'auto' }}>{JSON.stringify(detail, null, 2)}</pre>}
      </Drawer>
    </div>
  );
};
