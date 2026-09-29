import React, { useCallback, useEffect, useState } from 'react';
import { AutoComplete, Button, Card, Form, Input, Modal, Popconfirm, Space, Switch, Table, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useApp } from '@nocobase/client-v2';

interface TenantRow {
  id: number;
  name: string;
  displayName?: string;
  pathPrefix: string;
  appName?: string;
  enabled: boolean;
}

interface TenantFormValues {
  name: string;
  displayName?: string;
  pathPrefix: string;
  appName?: string;
  enabled: boolean;
}

// Mirrors the server guard in src/server/plugin.ts: a tenant slug is a lowercase path segment that must not
// collide with the gateway's reserved routes. Kept inline (not shared) so the v2 client bundle never imports server code.
const PATH_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PATH_PREFIX_MAX_LENGTH = 32;
const RESERVED_SEGMENTS = ['api', 'dist', 'static', 'storage', 'v', 'admin'];

const validatePathPrefix = (value: string, t: (key: string) => string): Promise<void> => {
  const prefix = (value || '').trim().toLowerCase();
  if (!prefix) {
    return Promise.reject(new Error(t('Path prefix is required')));
  }
  if (prefix.length > PATH_PREFIX_MAX_LENGTH) {
    return Promise.reject(
      new Error(t('Path prefix must be at most {{max}} characters', { max: PATH_PREFIX_MAX_LENGTH })),
    );
  }
  if (!PATH_PREFIX_PATTERN.test(prefix)) {
    return Promise.reject(
      new Error(t('Use only lowercase letters, digits and hyphens, starting with a letter or digit')),
    );
  }
  if (RESERVED_SEGMENTS.includes(prefix)) {
    return Promise.reject(new Error(t('This path prefix is reserved and cannot be used')));
  }
  return Promise.resolve();
};

export const TenantsSettingsPage: React.FC = () => {
  const app = useApp();
  const t = useCallback(
    (key: string, opts?: Record<string, unknown>) => app.i18n.t(key, { ns: 'plugin-tenant-path', ...opts }),
    [app],
  );
  const [form] = Form.useForm<TenantFormValues>();

  const [rows, setRows] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<TenantRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [appOptions, setAppOptions] = useState<{ value: string }[]>([]);
  const watchedAppName = Form.useWatch('appName', form);

  const fetchAppOptions = useCallback(async () => {
    const collectNames = (payload: unknown): string[] => {
      const data = (payload as { data?: { data?: unknown[] } })?.data?.data;
      const arr = Array.isArray(data) ? data : Array.isArray(payload) ? (payload as unknown[]) : [];
      return arr.map((r) => String((r as Record<string, unknown>)?.name ?? '').trim()).filter(Boolean);
    };
    try {
      const res = await app.apiClient.request({ url: 'applications:list', method: 'get', params: { paginate: false } });
      const names = collectNames(res?.data);
      if (names.length > 0) {
        setAppOptions(names.map((n) => ({ value: n })));
        return;
      }
    } catch {
      // applications collection only exists when plugin-multi-app-manager is enabled
    }
    try {
      const res = await app.apiClient.request({ url: 'tenantPath:listApps', method: 'get' });
      const names = collectNames(res?.data);
      if (names.length > 0) {
        setAppOptions(names.map((n) => ({ value: n })));
      }
    } catch {
      // no inventory available — keep free-text only
    }
  }, [app]);

  useEffect(() => {
    fetchAppOptions();
  }, [fetchAppOptions]);

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      const response = await app.apiClient.request<{ data: { data: TenantRow[] } }>({
        url: 'tenants:list',
        method: 'get',
        params: { pageSize: 200, sort: 'sort' },
      });
      const data = response?.data?.data;
      setRows(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('[plugin-tenant-path] Failed to load tenants:', error);
      message.error(t('Failed to load tenants'));
    } finally {
      setLoading(false);
    }
  }, [app, t]);

  useEffect(() => {
    fetchTenants();
  }, [fetchTenants]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true });
    setModalOpen(true);
  };

  const openEdit = (record: TenantRow) => {
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      displayName: record.displayName,
      pathPrefix: record.pathPrefix,
      appName: record.appName,
      enabled: record.enabled,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await app.apiClient.request({
          url: `tenants:update?filterByTk=${editing.id}`,
          method: 'post',
          data: values,
        });
      } else {
        await app.apiClient.request({
          url: 'tenants:create',
          method: 'post',
          data: values,
        });
      }
      message.success(t('Saved successfully'));
      setModalOpen(false);
      await fetchTenants();
    } catch (error) {
      console.error('[plugin-tenant-path] Failed to save tenant:', error);
      message.error(t('Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (record: TenantRow) => {
    try {
      await app.apiClient.request({
        url: `tenants:destroy?filterByTk=${record.id}`,
        method: 'delete',
      });
      message.success(t('Deleted successfully'));
      await fetchTenants();
    } catch (error) {
      console.error('[plugin-tenant-path] Failed to delete tenant:', error);
      message.error(t('Delete failed'));
    }
  };

  const columns: ColumnsType<TenantRow> = [
    { title: t('Name'), dataIndex: 'name' },
    { title: t('Display name'), dataIndex: 'displayName' },
    { title: t('Path prefix'), dataIndex: 'pathPrefix' },
    { title: t('App name'), dataIndex: 'appName' },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      render: (value: boolean) => (value ? t('Yes') : t('No')),
    },
    {
      title: t('Actions'),
      render: (_, record) => (
        <Space>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this tenant?')} onConfirm={() => handleDelete(record)}>
            <Button size="small" type="link" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Card
        title={t('Tenants')}
        extra={
          <Button type="primary" onClick={openCreate}>
            {t('Add tenant')}
          </Button>
        }
      >
        <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={false} />
      </Card>

      <Modal
        title={editing ? t('Edit tenant') : t('Add tenant')}
        open={modalOpen}
        confirmLoading={saving}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="displayName" label={t('Display name')}>
            <Input />
          </Form.Item>
          <Form.Item
            name="pathPrefix"
            label={t('Path prefix')}
            extra={t('URL segment that replaces the client prefix, e.g. /acme/app')}
            rules={[
              { required: true, message: t('Path prefix is required') },
              {
                validator: async (_rule: unknown, value: string) => validatePathPrefix(value, t),
              },
            ]}
          >
            <Input maxLength={PATH_PREFIX_MAX_LENGTH} />
          </Form.Item>
          <Form.Item
            name="appName"
            label={t('App name')}
            extra={
              watchedAppName &&
              String(watchedAppName).trim() &&
              !appOptions.some((o) => o.value === String(watchedAppName).trim()) &&
              appOptions.length > 0
                ? t('This app is not registered yet and will be bootstrapped on first request')
                : t('Leave empty to use the path prefix as app name')
            }
          >
            <AutoComplete
              options={appOptions}
              placeholder={t('Select or type an app name')}
              allowClear
              filterOption={(inputValue, option) =>
                String(option?.value ?? '')
                  .toLowerCase()
                  .includes(inputValue.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TenantsSettingsPage;
