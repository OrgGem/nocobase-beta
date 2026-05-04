import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Table, Checkbox, Spin, Typography, message } from 'antd';

export const ExternalStoragePermissions = ({ activeRole }) => {
  const api = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [directories, setDirectories] = useState([]);
  const [permissions, setPermissions] = useState({ view: [], update: [], destroy: [] });

  useEffect(() => {
    if (activeRole?.name) {
      loadData();
    }
  }, [activeRole?.name]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [dirRes, permRes] = await Promise.all([
        api.request({ resource: 'externalStorageDirectories', action: 'list', params: { paginate: false, sort: ['sort', 'name'] } }),
        api.request({ url: 'extStorage:rolePermissions', method: 'get', params: { roleName: activeRole.name } })
      ]);
      const fetchedPerms = permRes?.data?.data || permRes?.data || { view: [], update: [], destroy: [] };
      const unwrappedPerms = {
        view: fetchedPerms.data?.view || fetchedPerms.view || [],
        update: fetchedPerms.data?.update || fetchedPerms.update || [],
        destroy: fetchedPerms.data?.destroy || fetchedPerms.destroy || []
      };
      
      setDirectories(dirRes?.data?.data || []);
      setPermissions(unwrappedPerms);
    } catch (e) {
      console.error(e);
      message.error('Failed to load external storage permissions');
    }
    setLoading(false);
  };

  const handleToggle = async (directoryId, actionName, checked) => {
    const currentList = permissions[actionName] || [];
    let newList;
    if (checked) {
      newList = [...new Set([...currentList, directoryId])];
    } else {
      newList = currentList.filter(id => id !== directoryId);
    }
    
    // Optimistic update
    const newPermissions = { ...permissions, [actionName]: newList };
    setPermissions(newPermissions);

    setSaving(true);
      await api.request({
        url: 'extStorage:updateRolePermissions',
        method: 'post',
        data: {
          roleName: activeRole.name,
          values: newPermissions
        }
      }).then(() => {
        message.success('Permissions updated');
      }).catch(() => {
        message.error('Failed to update permissions');
        // Revert on error
      setPermissions(permissions);
    });
    setSaving(false);
  };

  const columns = [
    {
      title: 'Directory Name',
      dataIndex: 'name',
      key: 'name',
      render: (text, record) => (
        <Typography.Text strong>
          {text}
        </Typography.Text>
      ),
    },
    {
      title: 'Path',
      dataIndex: 'rootPath',
      key: 'rootPath',
      render: (text) => <Typography.Text type="secondary" code>{text}</Typography.Text>,
    },
    {
      title: 'Storage Type',
      dataIndex: 'storageType',
      key: 'storageType',
    },
    {
      title: 'Read (View & Download)',
      key: 'view',
      render: (_, record) => (
        <Checkbox
          checked={(permissions.view || []).includes(record.id)}
          onChange={(e) => handleToggle(record.id, 'view', e.target.checked)}
        />
      ),
    },
    {
      title: 'Write (Upload & Mkdir)',
      key: 'update',
      render: (_, record) => (
        <Checkbox
          checked={(permissions.update || []).includes(record.id)}
          onChange={(e) => handleToggle(record.id, 'update', e.target.checked)}
        />
      ),
    },
    {
      title: 'Delete',
      key: 'destroy',
      render: (_, record) => (
        <Checkbox
          checked={(permissions.destroy || []).includes(record.id)}
          onChange={(e) => handleToggle(record.id, 'destroy', e.target.checked)}
        />
      ),
    },
  ];

  if (loading && !directories.length) {
    return <Spin style={{ display: 'block', margin: '40px auto' }} />;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">
          Configure access permissions for each external storage directory for the role <Typography.Text strong>{activeRole?.title || activeRole?.name}</Typography.Text>.
        </Typography.Text>
      </div>
      <Table
        dataSource={directories}
        columns={columns}
        rowKey="id"
        pagination={false}
        size="small"
        bordered
      />
    </div>
  );
};
