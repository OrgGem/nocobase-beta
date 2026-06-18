/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { Card, Switch, Select, Space, Typography, Spin, Divider } from 'antd';

const { Text } = Typography;

interface AiEmployee {
  username: string;
  nickname: string;
}

interface RolePermRecord {
  id?: number;
  roleName: string;
  enabled: boolean;
  allowAllEmployees: boolean;
  allowedEmployees: string[];
}

/**
 * Permission tab shown in Settings → Users & Permissions → [Role] → "AI API" tab.
 * Lets admins control whether a role can use the AI API and which AI Employees it may access.
 */
export function AiApiRolePermissions({ role }: { role: any }) {
  const api = useApp().apiClient;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [employees, setEmployees] = useState<AiEmployee[]>([]);
  const [record, setRecord] = useState<RolePermRecord | null>(null);

  const roleName = role?.name;

  useEffect(() => {
    if (!roleName) return;
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleName]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [permRes, empRes] = await Promise.all([
        api.request({
          url: 'aiApiRolePermissions',
          params: { filter: { roleName }, paginate: false },
        }),
        api.request({ url: 'aiEmployees:list', params: { paginate: false } }),
      ]);

      const existing = permRes?.data?.data?.[0];
      setRecord(
        existing
          ? {
              id: existing.id,
              roleName: existing.roleName,
              enabled: !!existing.enabled,
              allowAllEmployees: existing.allowAllEmployees !== false,
              allowedEmployees: existing.allowedEmployees || [],
            }
          : {
              roleName,
              enabled: false,
              allowAllEmployees: true,
              allowedEmployees: [],
            },
      );

      setEmployees(
        (empRes?.data?.data || []).map((e: any) => ({
          username: e.username,
          nickname: e.nickname || e.username,
        })),
      );
    } catch (err) {
      console.error('Failed to load AI API role permissions:', err);
    } finally {
      setLoading(false);
    }
  };

  const save = async (patch: Partial<RolePermRecord>) => {
    if (!record) return;
    const next = { ...record, ...patch };
    setRecord(next);
    setSaving(true);
    try {
      if (next.id) {
        await api.request({
          url: `aiApiRolePermissions/${next.id}`,
          method: 'PUT',
          data: next,
        });
      } else {
        const res = await api.request({
          url: 'aiApiRolePermissions',
          method: 'POST',
          data: next,
        });
        const created = res?.data?.data;
        if (created?.id) {
          setRecord({ ...next, id: created.id });
        }
      }
    } catch (err) {
      console.error('Failed to save AI API role permissions:', err);
      // Revert on error
      setRecord(record);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spin />;

  return (
    <Card bordered={false}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space>
          <Switch checked={!!record?.enabled} loading={saving} onChange={(checked) => save({ enabled: checked })} />
          <Text strong>Allow this role to use the AI API</Text>
        </Space>

        {record?.enabled && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <Space>
              <Switch
                checked={!!record?.allowAllEmployees}
                loading={saving}
                onChange={(checked) => save({ allowAllEmployees: checked })}
              />
              <Text>Allow all AI Employees</Text>
            </Space>

            {!record?.allowAllEmployees && (
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                  Select which AI Employees this role may use:
                </Text>
                <Select
                  mode="multiple"
                  allowClear
                  style={{ width: '100%', maxWidth: 480 }}
                  placeholder="Select allowed AI Employees"
                  value={record?.allowedEmployees || []}
                  options={employees.map((e) => ({
                    label: `${e.nickname} (${e.username})`,
                    value: e.username,
                  }))}
                  onChange={(vals) => save({ allowedEmployees: vals })}
                  disabled={saving}
                />
              </div>
            )}
          </>
        )}
      </Space>
    </Card>
  );
}
