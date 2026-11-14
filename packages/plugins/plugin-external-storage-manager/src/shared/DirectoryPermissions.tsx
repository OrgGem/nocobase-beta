// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Table, Typography, message } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  permissionActions,
  readDirectories,
  readPermissionState,
  type Directory,
  type DirectoryId,
  type DirectoryPermissions as DirectoryPermissionsData,
  type PermissionAction,
} from './permissionsData';

export type PermissionRequestOptions = {
  url?: string;
  method?: 'get' | 'post';
  params?: Record<string, unknown>;
  resource?: string;
  action?: string;
  data?: Record<string, unknown>;
};

type Role = { name: string; title?: string };

type RoleWrites = { revision: number; pending?: Promise<unknown> };
const writesByClient = new WeakMap<object, Map<string, RoleWrites>>();

function getRoleWrites(apiClient: object, roleName: string): RoleWrites {
  let roles = writesByClient.get(apiClient);
  if (!roles) {
    roles = new Map();
    writesByClient.set(apiClient, roles);
  }
  let writes = roles.get(roleName);
  if (!writes) {
    writes = { revision: 0 };
    roles.set(roleName, writes);
  }
  return writes;
}

export function DirectoryPermissions({
  role,
  request,
  apiClient,
}: {
  role: Role;
  request: (options: PermissionRequestOptions) => Promise<unknown>;
  apiClient: object;
}) {
  const { t } = useTranslation('plugin-external-storage-manager');
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [permissions, setPermissions] = useState<DirectoryPermissionsData>({ view: [], update: [], destroy: [] });
  const [readOnlyActions, setReadOnlyActions] = useState<PermissionAction[]>(permissionActions);
  const [supported, setSupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  const savingRef = useRef(false);
  const loadedRevision = useRef(-1);
  const roleWrites = useMemo(() => getRoleWrites(apiClient, role.name), [apiClient, role.name]);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        while (active) {
          if (roleWrites.pending) {
            try {
              await roleWrites.pending;
            } catch {
              // The previous editor may have unmounted; reload after either result.
            }
            continue;
          }
          const revision = roleWrites.revision;
          const [directoryResponse, permissionsResponse] = await Promise.all([
            request({
              resource: 'externalStorageDirectories',
              action: 'list',
              params: { paginate: false, sort: ['sort', 'name'] },
            }),
            request({ url: 'extStorage:rolePermissions', method: 'get', params: { roleName: role.name } }),
          ]);
          if (!active) return;
          if (roleWrites.pending || roleWrites.revision !== revision) continue;
          const rows = readDirectories(directoryResponse);
          const state = readPermissionState(permissionsResponse);
          loadedRevision.current = revision;
          setDirectories(rows);
          setPermissions(state.permissions);
          setReadOnlyActions(state.readOnlyActions);
          setSupported(state.supported);
          break;
        }
      } catch {
        if (active) setError('Failed to load external storage permissions');
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [request, role.name, reload, roleWrites]);

  async function toggle(id: DirectoryId, action: PermissionAction, checked: boolean) {
    if (loading || savingRef.current || error || !supported || readOnlyActions.includes(action)) return;
    if (roleWrites.pending || loadedRevision.current !== roleWrites.revision) {
      setLoading(true);
      setReload((value) => value + 1);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const current = permissions[action].filter((value) => String(value) !== String(id));
    const next = checked ? [...current, id] : current;
    roleWrites.revision += 1;
    const pending: Promise<unknown> = Promise.resolve()
      .then(() =>
        request({
          url: 'extStorage:updateRolePermissions',
          method: 'post',
          data: { roleName: role.name, values: { [action]: next } },
        }),
      )
      .finally(() => {
        if (roleWrites.pending === pending) roleWrites.pending = undefined;
      });
    roleWrites.pending = pending;
    try {
      await pending;
      if (!mounted.current) return;
      setLoading(true);
      setReload((value) => value + 1);
      message.success(t('Permissions updated'));
    } catch {
      if (mounted.current) {
        setError('Failed to update permissions');
        message.error(t('Failed to update permissions'));
      }
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  const actions: Array<{ key: PermissionAction; title: string }> = [
    { key: 'view', title: t('Read (View & Download)') },
    { key: 'update', title: t('Write (Upload & Mkdir)') },
    { key: 'destroy', title: t('Delete') },
  ];

  return (
    <div style={{ padding: 16 }}>
      {error && (
        <Alert
          type="error"
          showIcon
          message={t(error)}
          action={<Button onClick={() => setReload((value) => value + 1)}>{t('Retry')}</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      {!loading && !error && !supported && (
        <Alert
          type="warning"
          showIcon
          message={t('The storage server cannot safely edit these permissions. Update the server plugin and retry.')}
          style={{ marginBottom: 16 }}
        />
      )}
      {!loading && !error && supported && readOnlyActions.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t('Some permissions use advanced scopes and must be managed in the role permissions editor.')}
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
        size="small"
        bordered
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
                disabled={loading || saving || !!error || !supported || readOnlyActions.includes(key)}
                indeterminate={readOnlyActions.includes(key)}
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
