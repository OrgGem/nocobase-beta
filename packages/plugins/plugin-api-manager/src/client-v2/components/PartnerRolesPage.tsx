import { Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

interface PartnerRoleRow {
  id: number;
  partnerId: number;
  roleName: string;
  partner?: { id: number; name: string };
}

interface PartnerOption {
  id: number;
  name: string;
}

interface RoleOption {
  name: string;
  title?: string;
}

interface CreateFormValues {
  partnerId: number;
  roleName: string;
}

/**
 * Manages apiPartnerRoles: the binding between a NocoBase role and a plugin
 * Partner. App Bearer tokens carrying a bound role may only call routes that
 * belong to the same partner (gateway tenant isolation).
 */
export const PartnerRolesPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [rows, setRows] = useState<PartnerRoleRow[]>([]);
  const [partners, setPartners] = useState<PartnerOption[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [rolesAvailable, setRolesAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<CreateFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // roles:list requires the plugin-acl snippet, which the API Manager
      // permission does not necessarily include. Load it best-effort and fall
      // back to a free-text role name input when it is not accessible.
      const [bindingsRes, partnersRes, rolesRes] = await Promise.allSettled([
        api.request({
          url: 'apiPartnerRoles:list',
          params: { paginate: false, sort: ['-createdAt'], appends: ['partner'] },
        }),
        api.request({ url: 'apiPartners:list', params: { paginate: false } }),
        api.request({ url: 'roles:list', params: { paginate: false } }),
      ]);
      if (bindingsRes.status === 'rejected') throw bindingsRes.reason;
      if (partnersRes.status === 'rejected') throw partnersRes.reason;
      setRows((bindingsRes.value?.data?.data ?? []) as PartnerRoleRow[]);
      setPartners((partnersRes.value?.data?.data ?? []) as PartnerOption[]);
      if (rolesRes.status === 'fulfilled') {
        setRoles((rolesRes.value?.data?.data ?? []) as RoleOption[]);
        setRolesAvailable(true);
      } else {
        setRoles([]);
        setRolesAvailable(false);
      }
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load partner roles') as string));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    form.resetFields();
    setModalOpen(true);
  };

  const onSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await api.request({ url: 'apiPartnerRoles:create', method: 'post', data: values });
      message.success(t('Partner role saved') as string);
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save partner role') as string));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: number) => {
    try {
      await api.request({ url: 'apiPartnerRoles:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('Partner role deleted') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete partner role') as string));
    }
  };

  const partnerName = (record: PartnerRoleRow) =>
    record.partner?.name ?? partners.find((p) => p.id === record.partnerId)?.name ?? '-';
  const roleTitle = (roleName: string) => roles.find((r) => r.name === roleName)?.title ?? roleName;

  const columns = [
    {
      title: t('Role') as string,
      dataIndex: 'roleName',
      key: 'roleName',
      render: (roleName: string) => <Tag color="purple">{roleTitle(roleName)}</Tag>,
    },
    {
      title: t('Partner') as string,
      key: 'partner',
      render: (_: unknown, record: PartnerRoleRow) => partnerName(record),
    },
    {
      title: t('Actions') as string,
      key: 'actions',
      render: (_: unknown, record: PartnerRoleRow) => (
        <Space>
          <Popconfirm title={t('Delete') + '?'} onConfirm={() => onDelete(record.id)}>
            <Button size="small" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Bind Role to Partner')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={load}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={false} />
      <Modal
        title={t('Bind Role to Partner') as string}
        open={modalOpen}
        onOk={onSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText={t('Save') as string}
        cancelText={t('Cancel') as string}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="roleName"
            label={t('Role') as string}
            rules={[{ required: true, message: t('Role is required') as string }]}
            extra={rolesAvailable ? undefined : (t('Roles could not be loaded — enter the role name manually') as string)}
          >
            {rolesAvailable ? (
              <Select
                showSearch
                options={roles.map((r) => ({ value: r.name, label: r.title ?? r.name }))}
                placeholder={t('Select Role') as string}
              />
            ) : (
              <Input placeholder={t('Role name') as string} autoComplete="off" />
            )}
          </Form.Item>
          <Form.Item
            name="partnerId"
            label={t('Partner') as string}
            rules={[{ required: true, message: t('Partner is required') as string }]}
          >
            <Select
              options={partners.map((p) => ({ value: p.id, label: p.name }))}
              placeholder={t('Select Partner') as string}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default PartnerRolesPage;