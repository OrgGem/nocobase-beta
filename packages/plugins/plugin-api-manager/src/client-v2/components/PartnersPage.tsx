import { Button, Form, Input, Modal, Popconfirm, Space, Switch, Table, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

interface PartnerRow {
  id: number;
  name: string;
  contactEmail?: string;
  notes?: string;
  enabled: boolean;
}

export const PartnersPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [rows, setRows] = useState<PartnerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PartnerRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'apiPartners:list', params: { paginate: false, sort: ['-createdAt'] } });
      const data = (res?.data?.data ?? []) as PartnerRow[];
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load partners') as string));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true });
    setModalOpen(true);
  };

  const openEdit = (record: PartnerRow) => {
    setEditing(record);
    form.setFieldsValue(record);
    setModalOpen(true);
  };

  const onSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.request({
          url: 'apiPartners:update',
          method: 'post',
          params: { filterByTk: editing.id },
          data: values,
        });
      } else {
        await api.request({ url: 'apiPartners:create', method: 'post', data: values });
      }
      message.success(t('Partner saved') as string);
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save partner') as string));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: number) => {
    try {
      await api.request({ url: 'apiPartners:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('Partner deleted') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save partner') as string));
    }
  };

  const onToggleEnabled = async (record: PartnerRow, enabled: boolean) => {
    try {
      await api.request({
        url: 'apiPartners:update',
        method: 'post',
        params: { filterByTk: record.id },
        data: { enabled },
      });
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save partner') as string));
    }
  };

  const columns = [
    { title: t('Name') as string, dataIndex: 'name', key: 'name' },
    { title: t('Contact Email') as string, dataIndex: 'contactEmail', key: 'contactEmail' },
    {
      title: t('Enabled') as string,
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean, record: PartnerRow) => (
        <Switch size="small" checked={enabled} onChange={(v) => onToggleEnabled(record, v)} />
      ),
    },
    {
      title: t('Actions') as string,
      key: 'actions',
      render: (_: unknown, record: PartnerRow) => (
        <Space>
          <Button size="small" onClick={() => openEdit(record)}>
            {t('Edit Partner')}
          </Button>
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
          {t('Create Partner')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={load}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={false} />
      <Modal
        title={editing ? (t('Edit Partner') as string) : (t('Create Partner') as string)}
        open={modalOpen}
        onOk={onSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText={t('Save') as string}
        cancelText={t('Cancel') as string}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name') as string} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="contactEmail" label={t('Contact Email') as string}>
            <Input />
          </Form.Item>
          <Form.Item name="notes" label={t('Notes') as string}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled') as string} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default PartnersPage;
