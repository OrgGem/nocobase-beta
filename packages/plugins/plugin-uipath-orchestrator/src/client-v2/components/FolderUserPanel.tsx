/**
 * Folder & User Panel — folder tree, user list, sync button
 */

import React from 'react';
import { Alert, Table, Card, Button, message, Tag } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useCurrentInstance } from '../context/InstanceContext';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

type FolderRow = {
  folderId: number;
  folderKey?: string | null;
  displayName?: string;
  fullyQualifiedName?: string;
  lastSyncedAt?: string;
};

export const FolderUserPanel: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { instanceId, instances, setFolder, folders, foldersLoading, refreshFolders, refreshInstances } =
    useCurrentInstance();
  const { data: users, loading: uLoading, error: usersError } = useUiPathRequest('uipathUsers', 'list');
  const userRows = toUiPathArray(users);
  const currentInstance = instances.find((instance) => instance.id === instanceId);

  const handleSyncFolders = async () => {
    if (!instanceId) return;
    try {
      await api.request({ url: 'uipathFolders:sync', params: { instanceId } });
      message.success(t('Folders synced'));
      refreshFolders();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleSetDefaultFolder = async (folder: FolderRow) => {
    if (!instanceId) return;
    try {
      await api.request({
        url: 'uipathFolders:setDefault',
        params: {
          instanceId,
          folderId: folder.folderId,
          folderKey: folder.folderKey,
          folderPath: folder.fullyQualifiedName,
        },
      });
      setFolder(folder.folderId, folder.folderKey || null, folder.fullyQualifiedName || null);
      refreshInstances();
      message.success(t('Saved'));
    } catch (err: any) {
      message.error(err.message);
    }
  };

  return (
    <div>
      <Card
        title={t('Folders')}
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Button icon={<SyncOutlined />} onClick={handleSyncFolders} size="small">
            {t('Sync')}
          </Button>
        }
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
            {
              title: t('Default'),
              width: 120,
              render: (_: unknown, row: FolderRow) =>
                String(currentInstance?.defaultFolderId || '') === String(row.folderId) ? (
                  <Tag color="green">{t('Default')}</Tag>
                ) : (
                  <Button size="small" onClick={() => handleSetDefaultFolder(row)}>
                    {t('Default')}
                  </Button>
                ),
            },
            {
              title: t('Synced'),
              dataIndex: 'lastSyncedAt',
              width: 180,
              render: (v: string) => (v ? new Date(v).toLocaleString() : '-'),
            },
          ]}
        />
      </Card>
      <Card title={t('Users')} size="small">
        {usersError ? (
          <Alert
            type="error"
            showIcon
            message={t('Failed')}
            description={usersError.message}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Table
          dataSource={userRows}
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
