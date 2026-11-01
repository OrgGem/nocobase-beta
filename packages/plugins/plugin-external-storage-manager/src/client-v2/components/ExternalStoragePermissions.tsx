import { useApp } from '@nocobase/client-v2';
import type { PermissionTabProps, Role } from '@nocobase/plugin-acl/client-v2';
import { Alert, App, Checkbox, Table, Typography } from 'antd';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  readDirectoryPermissions,
  type DirectoryId,
  type DirectoryPermissions,
  type PermissionAction,
} from './permissionsData';

type Directory = { id: DirectoryId; name: string; rootPath?: string; storageType?: string };

function DirectoryPermissionsTable({ role }: { role: Role }) {
  const api = useApp().apiClient;
  const { t } = useTranslation('plugin-external-storage-manager');
  const { message } = App.useApp();
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [permissions, setPermissions] = useState<DirectoryPermissions>({ view: [], update: [], destroy: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const [directoryResponse, permissionsResponse] = await Promise.all([
          api.resource('externalStorageDirectories').list({ paginate: false, sort: ['sort', 'name'] }),
          api.request({ url: 'extStorage:rolePermissions', params: { roleName: role.name } }),
        ]);
        const rows: unknown = directoryResponse?.data?.data;
        if (!active) return;
        setDirectories(
          Array.isArray(rows)
            ? rows.filter(
                (row): row is Directory =>
                  row &&
                  typeof row === 'object' &&
                  (typeof row.id === 'string' || typeof row.id === 'number') &&
                  typeof row.name === 'string',
              )
            : [],
        );
        setPermissions(readDirectoryPermissions(permissionsResponse));
        setFailed(false);
      } catch {
        if (active) setFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [api, role.name]);

  async function toggle(id: DirectoryId, action: PermissionAction, checked: boolean) {
    if (loading || saving || failed) return;
    const current = permissions[action].filter((value) => String(value) !== String(id));
    const next = { ...permissions, [action]: checked ? [...current, id] : current };
    setSaving(true);
    try {
      await api.request({
        url: 'extStorage:updateRolePermissions',
        method: 'post',
        data: { roleName: role.name, values: next },
      });
      const response = await api.request({ url: 'extStorage:rolePermissions', params: { roleName: role.name } });
      setPermissions(readDirectoryPermissions(response));
      message.success(t('Permissions updated'));
    } catch {
      setFailed(true);
      message.error(t('Failed to update permissions'));
    } finally {
      setSaving(false);
    }
  }

  const actions: Array<{ key: PermissionAction; title: string }> = [
    { key: 'view', title: t('Read (View & Download)') },
    { key: 'update', title: t('Write (Upload & Mkdir)') },
    { key: 'destroy', title: t('Delete') },
  ];
  return (
    <div style={{ padding: 16 }}>
      {failed && (
        <Alert
          type="error"
          showIcon
          message={t('Failed to load external storage permissions')}
          style={{ marginBottom: 16 }}
        />
      )}
      <Typography.Paragraph>
        {t('Configure access permissions for each external storage directory for the role')}{' '}
        <strong>{role.title || role.name}</strong>
      </Typography.Paragraph>
      <Table<Directory>
        rowKey="id"
        dataSource={directories}
        loading={loading || saving}
        pagination={false}
        columns={[
          { title: t('Directory Name'), dataIndex: 'name' },
          { title: t('Path'), dataIndex: 'rootPath' },
          { title: t('Storage Type'), dataIndex: 'storageType' },
          ...actions.map(({ key, title }) => ({
            title,
            key,
            render: (_value: unknown, directory: Directory) => (
              <Checkbox
                aria-label={`${title}: ${directory.name}`}
                disabled={loading || saving || failed}
                checked={permissions[key].some((id) => String(id) === String(directory.id))}
                onChange={(event) => toggle(directory.id, key, event.target.checked)}
              />
            ),
          })),
        ]}
      />
    </div>
  );
}

export default function ExternalStoragePermissions({ activeRole }: PermissionTabProps) {
  return activeRole ? <DirectoryPermissionsTable key={activeRole.name} role={activeRole} /> : null;
}
