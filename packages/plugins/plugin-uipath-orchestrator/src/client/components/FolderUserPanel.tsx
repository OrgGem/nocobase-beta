/**
 * Folder & User Panel — folder tree, user list, sync button
 */

import React from 'react';
import { Table, Card, Button, Space, message } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useCurrentInstance } from '../context/InstanceContext';
import { useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

export const FolderUserPanel: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId, folders, foldersLoading } = useCurrentInstance();
  const { data: users, loading: uLoading } = useUiPathRequest('uipathUsers', 'list');

  const handleSyncFolders = async () => {
    try {
      await api.request({ url: 'uipathFolders:sync', params: { instanceId } });
      message.success(t('Folders synced'));
      window.location.reload();
    } catch (err: any) { message.error(err.message); }
  };

  return (
    <div>
      <Card title={t('Folders')} size="small" style={{ marginBottom: 16 }}
        extra={<Button icon={<SyncOutlined />} onClick={handleSyncFolders} size="small">{t('Sync')}</Button>}
      >
        <Table
          dataSource={folders || []}
          rowKey="folderId"
          loading={foldersLoading}
          size="small"
          pagination={false}
          columns={[
            { title: t('Name'), dataIndex: 'displayName' },
            { title: t('Path'), dataIndex: 'fullyQualifiedName', ellipsis: true },
            { title: t('Key'), dataIndex: 'folderKey', width: 200 },
            { title: t('Synced'), dataIndex: 'lastSyncedAt', width: 180, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
          ]}
        />
      </Card>
      <Card title={t('Users')} size="small">
        <Table
          dataSource={users || []}
          rowKey="Id"
          loading={uLoading}
          size="small"
          pagination={{ pageSize: 50 }}
          columns={[
            { title: t('Username'), dataIndex: 'UserName', ellipsis: true },
            { title: t('Name'), dataIndex: 'Name', ellipsis: true },
            { title: t('Email'), dataIndex: 'EmailAddress', ellipsis: true },
            { title: t('Type'), dataIndex: 'Type', width: 100 },
          ]}
        />
      </Card>
    </div>
  );
};
