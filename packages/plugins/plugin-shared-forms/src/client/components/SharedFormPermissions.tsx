/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useAPIClient, useRequest } from '@nocobase/client';
import { Card, Switch, Typography, Spin, Space } from 'antd';
import React from 'react';
import { useSharedFormTranslation, NAMESPACE } from '../locale';

const { Text } = Typography;

/**
 * Tab component shown inside Settings → Users & Permissions → [Role] → "Shared Forms" tab.
 * Lets admins toggle whether a role can access sharedForms:getMeta (mapped to "view" via actionAlias).
 *
 * Uses the standard rolesResources / rolesResourcesActions tables — same as any other resource
 * configured via Action permissions.
 */
export function SharedFormPermissions({ role }: { role: any }) {
  const { t } = useSharedFormTranslation();
  const apiClient = useAPIClient();

  // Fetch current permission record for this role + sharedForms resource
  const { data, loading, refresh } = useRequest<any>(
    {
      url: 'rolesResources',
      params: {
        filter: {
          roleName: role?.name,
          name: 'sharedForms',
        },
        appends: ['actions'],
      },
    },
    { refreshDeps: [role?.name] },
  );

  const record = data?.data?.[0];
  const hasViewAction = record?.actions?.some((a: any) => a.name === 'view');

  const handleToggle = async (checked: boolean) => {
    if (!record) {
      // Create the resource record with view action
      await apiClient.request({
        url: 'rolesResources',
        method: 'POST',
        data: {
          roleName: role.name,
          name: 'sharedForms',
          usingActionsConfig: true,
          actions: checked ? [{ name: 'view' }] : [],
        },
      });
    } else if (checked && !hasViewAction) {
      // Add view action
      await apiClient.request({
        url: `rolesResources/${record.id}/actions`,
        method: 'POST',
        data: { name: 'view' },
      });
    } else if (!checked && hasViewAction) {
      // Remove all actions (disable access)
      const viewAction = record.actions.find((a: any) => a.name === 'view');
      if (viewAction) {
        await apiClient.request({
          url: `rolesResources/${record.id}/actions/${viewAction.id}`,
          method: 'DELETE',
        });
      }
    }
    await refresh();
  };

  if (loading) {
    return <Spin />;
  }

  return (
    <Card bordered={false}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Text type="secondary">
          {t('Allow this role to access shared forms (view form schema and submit)', { ns: NAMESPACE })}
        </Text>
        <Space>
          <Switch checked={!!hasViewAction} onChange={handleToggle} />
          <Text>{t('Allow access to shared forms', { ns: NAMESPACE })}</Text>
        </Space>
      </Space>
    </Card>
  );
}
