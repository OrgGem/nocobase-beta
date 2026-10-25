/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import type { PermissionTabProps, Role } from '@nocobase/plugin-acl/client-v2';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Space, Switch, Typography } from 'antd';
import React, { useState } from 'react';
import { useT } from './locale';

interface PermissionRecord {
  id: string | number;
  usingActionsConfig?: boolean;
  actions: { id: string | number; name: string }[];
}
function PermissionForRole({ role }: { role: Role }) {
  const api = useApp().apiClient;
  const t = useT();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const { data, loading, error, refresh, refreshAsync } = useRequest(
    async () =>
      (
        await api.request<{ data: PermissionRecord[] }>({
          url: 'rolesResources:list',
          params: { filter: { roleName: role.name, name: 'sharedForms' }, appends: ['actions'], paginate: false },
        })
      ).data.data[0],
    { refreshDeps: [api, role.name] },
  );
  const view = data?.actions?.find((action) => action.name === 'view');
  const hasAccess =
    role.name === 'root' || (data?.usingActionsConfig ? !!view : !!role.strategy?.actions?.includes('view'));
  async function toggle(checked: boolean) {
    setSaving(true);
    try {
      if (!data)
        await api.resource('rolesResources').create({
          values: {
            roleName: role.name,
            name: 'sharedForms',
            usingActionsConfig: true,
            actions: checked ? [{ name: 'view' }] : [],
          },
        });
      else {
        if (!data.usingActionsConfig)
          await api.resource('rolesResources').update({ filterByTk: data.id, values: { usingActionsConfig: true } });
        if (checked && !view)
          await api.resource('rolesResources.actions', data.id).create({ values: { name: 'view' } });
        else if (!checked && view)
          await api.resource('rolesResources.actions', data.id).destroy({ filterByTk: view.id });
      }
      await refreshAsync();
      message.success(t('Saved successfully'));
    } catch {
      message.error(t('Save failed'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Space direction="vertical">
      {error && (
        <Alert
          type="error"
          message={t('Unable to load permissions')}
          action={<Button onClick={refresh}>{t('Retry')}</Button>}
        />
      )}
      <Typography.Text>{t('Allow this role to access shared forms (view form schema and submit)')}</Typography.Text>
      <Switch
        aria-label={t('Allow access to shared forms')}
        disabled={loading || saving || !!error || role.name === 'root'}
        loading={loading || saving}
        checked={hasAccess}
        onChange={toggle}
      />
    </Space>
  );
}
export default function Permissions({ activeRole, activeKey }: PermissionTabProps) {
  return activeRole && activeKey === 'sharedForms' ? (
    <PermissionForRole key={activeRole.name} role={activeRole} />
  ) : null;
}
