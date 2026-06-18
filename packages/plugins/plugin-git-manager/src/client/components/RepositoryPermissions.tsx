import React, { useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { Table, Checkbox, Spin, Typography, message } from 'antd';

export const RepositoryPermissions = ({ activeRole }) => {
  const api = useApp().apiClient;
  const [loading, setLoading] = useState(false);
  const [repositories, setRepositories] = useState([]);
  const [permissions, setPermissions] = useState({ read: [], write: [] });

  useEffect(() => {
    if (activeRole?.name) {
      loadData();
    }
  }, [activeRole?.name]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [repoRes, permRes] = await Promise.all([
        api.request({
          resource: 'gitRepositories',
          action: 'list',
          params: { paginate: false, sort: ['name'] },
        }),
        api.request({
          url: 'gitManager:rolePermissions',
          method: 'get',
          params: { roleName: activeRole.name },
        }),
      ]);
      const fetchedPerms = permRes?.data?.data || permRes?.data || { read: [], write: [] };
      setRepositories(repoRes?.data?.data || []);
      setPermissions({
        read: fetchedPerms.read || [],
        write: fetchedPerms.write || [],
      });
    } catch (e) {
      console.error(e);
      message.error('Failed to load repository permissions');
    }
    setLoading(false);
  };

  const handleToggle = async (repositoryId: number, actionName: string, checked: boolean) => {
    const currentList = permissions[actionName] || [];
    const newList = checked
      ? [...new Set([...currentList, repositoryId])]
      : currentList.filter((id: number) => id !== repositoryId);

    const newPermissions = { ...permissions, [actionName]: newList };
    const prevPermissions = permissions;
    setPermissions(newPermissions);

    try {
      await api.request({
        url: 'gitManager:updateRolePermissions',
        method: 'post',
        data: {
          roleName: activeRole.name,
          values: newPermissions,
        },
      });
    } catch {
      message.error('Failed to update permissions');
      setPermissions(prevPermissions);
    }
  };

  const columns = [
    {
      title: 'Repository Name',
      dataIndex: 'name',
      key: 'name',
      render: (text: string) => <Typography.Text strong>{text}</Typography.Text>,
    },
    {
      title: 'Repository URL',
      dataIndex: 'repoUrl',
      key: 'repoUrl',
      ellipsis: true,
      render: (text: string) => <Typography.Text type="secondary">{text}</Typography.Text>,
    },
    {
      title: 'Read (List, Browse Files, View History)',
      key: 'read',
      width: 100,
      render: (_: any, record: any) => (
        <Checkbox
          checked={(permissions.read || []).includes(record.id)}
          onChange={(e) => handleToggle(record.id, 'read', e.target.checked)}
        />
      ),
    },
    {
      title: 'Write (Clone, Pull, Push, Review)',
      key: 'write',
      width: 100,
      render: (_: any, record: any) => (
        <Checkbox
          checked={(permissions.write || []).includes(record.id)}
          onChange={(e) => handleToggle(record.id, 'write', e.target.checked)}
        />
      ),
    },
  ];

  if (loading && !repositories.length) {
    return <Spin style={{ display: 'block', margin: '40px auto' }} />;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">
          Configure access permissions for each repository for the role{' '}
          <Typography.Text strong>{activeRole?.title || activeRole?.name}</Typography.Text>.
        </Typography.Text>
      </div>
      <Table
        dataSource={repositories}
        columns={columns}
        rowKey="id"
        pagination={false}
        size="small"
        bordered
      />
    </div>
  );
};
