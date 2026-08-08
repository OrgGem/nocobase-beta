import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Form, Modal, Popconfirm, Select, Space, Switch, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';
import type { ApiEnvelope } from './api';

interface UserSummary {
  id: string | number;
  nickname?: string;
  username?: string;
  email?: string;
}

interface EnabledLlmService {
  llmService: string;
  llmServiceTitle?: string;
  enabledModels?: { label: string; value: string }[];
}

interface UserPermission {
  id: string | number;
  userId: string | number;
  user?: UserSummary;
  enabled: boolean;
  allowedLlmServices: string[];
  allowAllModels: boolean;
  allowedModels: string[];
}

/** The modal edits everything except the server-assigned id. */
type UserPermissionFormValues = Omit<UserPermission, 'id' | 'user'>;

const PAGE_SIZE = 20;

export default function UserPermissionsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<UserPermissionFormValues>();
  const selectedServices = Form.useWatch('allowedLlmServices', form);
  const allowAllModels = Form.useWatch('allowAllModels', form);
  const [rows, setRows] = useState<UserPermission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [services, setServices] = useState<EnabledLlmService[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<UserPermission>();
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [permissionsResponse, servicesResponse] = await Promise.all([
        ctx.api.request({
          url: 'aiApiUserPermissions:list',
          method: 'get',
          params: { page, pageSize: PAGE_SIZE, appends: ['user'], sort: '-updatedAt' },
        }),
        ctx.api.request({ url: 'ai:listAllEnabledModels', method: 'get' }),
      ]);
      setRows(unwrapData<UserPermission[]>(permissionsResponse, []));
      setTotal((permissionsResponse as ApiEnvelope<UserPermission[]>)?.data?.meta?.count ?? 0);
      setServices(unwrapData<EnabledLlmService[]>(servicesResponse, []));
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [ctx.api, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Served by the plugin's own action rather than `users:list`, which belongs to the
  // pm.plugin-users snippet and would make this page unusable for a role granted only
  // pm.plugin-ai-api.user-permissions.
  const loadUsers = useCallback(
    async (keyword: string) => {
      try {
        const response = await ctx.api.request({
          url: 'aiApiUserPermissions:listUsers',
          method: 'get',
          params: { keyword, pageSize: 50, excludeGranted: !editing },
        });
        setUsers(unwrapData<UserSummary[]>(response, []));
      } catch (error) {
        message.error(errorMessage(error));
      }
    },
    [ctx.api, editing],
  );

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => loadUsers(userSearch), 300);
    return () => clearTimeout(timer);
  }, [open, userSearch, loadUsers]);

  const serviceOptions = useMemo(
    () =>
      services.map((service) => ({ label: service.llmServiceTitle || service.llmService, value: service.llmService })),
    [services],
  );

  // Model IDs are "serviceName/modelId", matching what the gateway enforces and what
  // GET /v1/models returns, so admins never have to type them by hand.
  const modelOptions = useMemo(() => {
    const picked = new Set(selectedServices || []);
    return services
      .filter((service) => picked.has(service.llmService))
      .flatMap((service) =>
        (service.enabledModels || []).map((model) => ({
          label: `${service.llmServiceTitle || service.llmService} / ${model.label || model.value}`,
          value: `${service.llmService}/${model.value}`,
        })),
      );
  }, [services, selectedServices]);

  const showCreate = () => {
    setEditing(undefined);
    setUserSearch('');
    form.setFieldsValue({
      enabled: true,
      allowedLlmServices: [],
      allowAllModels: true,
      allowedModels: [],
    });
    setOpen(true);
  };

  const showEdit = (record: UserPermission) => {
    setEditing(record);
    setUserSearch('');
    // Seed the picker with the granted user so the label renders before any search runs.
    setUsers(record.user ? [record.user] : []);
    form.setFieldsValue({
      userId: record.userId,
      enabled: record.enabled,
      allowAllModels: record.allowAllModels,
      allowedLlmServices: record.allowedLlmServices || [],
      allowedModels: record.allowedModels || [],
    });
    setOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await ctx.api.request({
        url: editing ? `aiApiUserPermissions:update/${editing.id}` : 'aiApiUserPermissions:create',
        method: 'post',
        data: values,
      });
      message.success(t('Saved successfully'));
      setOpen(false);
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (record: UserPermission) => {
    try {
      await ctx.api.request({ url: `aiApiUserPermissions:destroy/${record.id}`, method: 'post' });
      message.success(t('Deleted successfully'));
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const userLabel = (user?: UserSummary) => user?.nickname || user?.username || user?.email || String(user?.id ?? '');
  const serviceLabel = (name: string) => serviceOptions.find((option) => option.value === name)?.label || name;

  const columns: ColumnsType<UserPermission> = [
    {
      title: t('User'),
      key: 'user',
      width: 180,
      render: (_, record) => userLabel(record.user) || String(record.userId),
    },
    {
      title: t('Allowed LLM services'),
      dataIndex: 'allowedLlmServices',
      key: 'allowedLlmServices',
      render: (values: string[]) =>
        values?.length ? (
          <Space size={[0, 4]} wrap>
            {values.map((value) => (
              <Tag key={value}>{serviceLabel(value)}</Tag>
            ))}
          </Space>
        ) : (
          <Tag color="red">{t('No service allowed')}</Tag>
        ),
    },
    {
      title: t('Allowed models'),
      key: 'allowedModels',
      width: 220,
      render: (_, record) =>
        record.allowAllModels ? (
          <Tag color="blue">{t('All models of allowed services')}</Tag>
        ) : (
          <Space size={[0, 4]} wrap>
            {(record.allowedModels || []).map((value) => (
              <Tag key={value}>{value}</Tag>
            ))}
          </Space>
        ),
    },
    {
      title: t('Status'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'default'}>{enabled ? t('Enabled') : t('Disabled')}</Tag>
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space size={0}>
          <Button type="link" onClick={() => showEdit(record)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this permission?')} onConfirm={() => remove(record)}>
            <Button type="link" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('User LLM permissions')}
      extra={
        <Button type="primary" onClick={showCreate}>
          {t('Add permission')}
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t(
          'Users listed here are limited to the services selected below. Users without a record fall back to the general configuration.',
        )}
      />
      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 1000 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: setPage,
        }}
      />
      <Modal
        title={editing ? t('Edit permission') : t('Add permission')}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="userId" label={t('User')} rules={[{ required: true }]}>
            <Select
              disabled={Boolean(editing)}
              showSearch
              // Matching happens on the server, so keep every returned option visible.
              filterOption={false}
              onSearch={setUserSearch}
              notFoundContent={null}
              options={users.map((user) => ({ label: userLabel(user), value: user.id }))}
            />
          </Form.Item>
          <Form.Item
            name="allowedLlmServices"
            label={t('Allowed LLM services')}
            extra={t('Only services also enabled in the general configuration take effect.')}
          >
            <Select mode="multiple" allowClear showSearch optionFilterProp="label" options={serviceOptions} />
          </Form.Item>
          <Form.Item name="allowAllModels" label={t('Allow all models')} valuePropName="checked">
            <Switch />
          </Form.Item>
          {allowAllModels === false && (
            <Form.Item name="allowedModels" label={t('Allowed models')}>
              <Select mode="multiple" allowClear showSearch optionFilterProp="label" options={modelOptions} />
            </Form.Item>
          )}
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
