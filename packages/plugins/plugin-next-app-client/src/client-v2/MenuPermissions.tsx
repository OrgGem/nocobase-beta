/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import type { PermissionTabProps } from '@nocobase/plugin-acl/client-v2';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Checkbox, Space, Table } from 'antd';
import React, { useState } from 'react';
import { useT } from './locale';
import { flattenRoutes, permissionIds, type HubRoute, type RouteId } from './routes';

function PermissionsForRole({
  role,
  onRoleChange,
}: Pick<PermissionTabProps, 'onRoleChange'> & { role: NonNullable<PermissionTabProps['activeRole']> }) {
  const api = useApp().apiClient;
  const { message } = App.useApp();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const { data, loading, error, refreshAsync, refresh } = useRequest(
    async () => {
      const [routes, granted, current] = await Promise.all([
        api.request<{ data: HubRoute[] }>({
          url: 'nextAppRoutes:list',
          params: { tree: true, paginate: false, sort: 'sort', filter: { hidden: { $ne: true } } },
        }),
        api.resource('roles.nextAppRoutes', role.name).list({ paginate: false }),
        api.resource('roles').get({ filterByTk: role.name }),
      ]);
      return {
        routes: routes.data.data || [],
        ids: ((granted.data.data as HubRoute[]) || []).flatMap((route) => (route.id == null ? [] : [route.id])),
        allowNew: !!current.data.data.allowNewNextAppMenu,
      };
    },
    { refreshDeps: [api, role.name] },
  );
  const ids = data?.ids || [];
  async function saveIds(next: RouteId[]) {
    setSaving(true);
    try {
      await api.resource('roles.nextAppRoutes', role.name).set({ values: next });
      await refreshAsync();
      message.success(t('Saved successfully'));
    } catch {
      message.error(t('Failed to save'));
    } finally {
      setSaving(false);
    }
  }
  async function setAllowNew(checked: boolean) {
    setSaving(true);
    try {
      await api.resource('roles').update({ filterByTk: role.name, values: { allowNewNextAppMenu: checked } });
      const nextRole = { ...role, allowNewNextAppMenu: checked };
      onRoleChange(nextRole);
      await refreshAsync();
    } catch {
      message.error(t('Failed to save'));
    } finally {
      setSaving(false);
    }
  }
  const routes = error ? [] : data?.routes || [];
  const all = flattenRoutes(routes).flatMap((route) => (route.id == null ? [] : [route.id]));
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {error && (
        <Alert
          type="error"
          showIcon
          message={t('Failed to load permissions')}
          action={<Button onClick={refresh}>{t('Retry')}</Button>}
        />
      )}
      <Checkbox
        disabled={loading || saving || !!error}
        checked={data?.allowNew}
        onChange={(event) => setAllowNew(event.target.checked)}
      >
        {t('Automatically allow new Next App menus')}
      </Checkbox>
      <Checkbox
        disabled={loading || saving || !!error}
        checked={all.length > 0 && all.every((id) => ids.some((value) => String(id) === String(value)))}
        onChange={(event) => saveIds(event.target.checked ? all : [])}
      >
        {t('All')}
      </Checkbox>
      <Table<HubRoute>
        rowKey={(route) => String(route.id)}
        loading={loading || saving}
        dataSource={routes}
        pagination={false}
        columns={[
          { title: t('Title'), dataIndex: 'title' },
          {
            title: t('Access'),
            render: (_, route) => (
              <Checkbox
                aria-label={`${t('Access')}: ${route.title || route.id}`}
                disabled={loading || saving || !!error || route.id == null}
                checked={ids.some((id) => String(id) === String(route.id))}
                onChange={(event) =>
                  route.id != null && saveIds(permissionIds(routes, route.id, ids, event.target.checked))
                }
              />
            ),
          },
        ]}
      />
    </Space>
  );
}

export default function MenuPermissions({ activeKey, activeRole, onRoleChange }: PermissionTabProps) {
  if (activeKey !== 'next-app-menu' || !activeRole) return null;
  return <PermissionsForRole key={activeRole.name} role={activeRole} onRoleChange={onRoleChange} />;
}
