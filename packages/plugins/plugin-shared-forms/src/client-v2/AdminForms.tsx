/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { useFlowContext } from '@nocobase/flow-engine';
import { uid } from '@nocobase/utils/client';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { collectionBinding } from '../shared/v2Config';
import { formModelOptions } from './models';
import { useT } from './locale';

export interface FormRecord {
  key: string;
  title: string;
  collection: string;
  description?: string;
  enabled: boolean;
  v2Config?: unknown;
  allowedRoles?: { name: string }[];
}
export default function AdminForms() {
  const app = useApp();
  const api = app.apiClient;
  const ctx = useFlowContext();
  const t = useT();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormRecord>();
  const [editing, setEditing] = useState<FormRecord>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data, loading, error, refresh, refreshAsync } = useRequest(
    async () =>
      (
        await api.request<{ data: FormRecord[] }>({
          url: 'sharedForms:list',
          params: { paginate: false, sort: '-createdAt' },
        })
      ).data.data || [],
    { refreshDeps: [api] },
  );
  const options = ctx.dataSourceManager.getDataSources().flatMap((source) =>
    source
      .getCollections()
      .filter((collection) => !!collection.filterTargetKey && !collection.options.hidden)
      .map((collection) => ({
        value: `${source.key}:${collection.name}`,
        label: `${source.displayName || source.key} / ${collection.title || collection.name}`,
      })),
  );
  function edit(record?: FormRecord) {
    setEditing(record);
    form.resetFields();
    form.setFieldsValue(record || { enabled: false });
    setOpen(true);
  }
  async function save() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const binding = collectionBinding(values.collection);
      const config = {
        version: 2,
        model: formModelOptions(binding.dataSourceKey, binding.collectionName),
        successMessage: t('Submitted successfully!'),
      };
      await api.request({
        url: `sharedForms:${editing ? 'update' : 'create'}`,
        method: 'post',
        params: editing ? { filterByTk: editing.key } : undefined,
        data: editing ? values : { ...values, key: uid(), type: 'form', v2Config: config },
      });
      setOpen(false);
      await refreshAsync();
      message.success(t('Saved successfully'));
    } catch {
      message.error(t('Save failed'));
    } finally {
      setSaving(false);
    }
  }
  async function remove(key: string) {
    try {
      await api.resource('sharedForms').destroy({ filterByTk: key });
      await refreshAsync();
    } catch {
      message.error(t('Delete failed'));
    }
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {error && <Alert type="error" message={t('Unable to load shared forms')} />}
      <Space>
        <Button type="primary" onClick={() => edit()}>
          {t('Add New')}
        </Button>
        <Button onClick={refresh}>{t('Refresh')}</Button>
      </Space>
      <Table<FormRecord>
        rowKey="key"
        loading={loading}
        dataSource={error ? [] : data}
        columns={[
          { title: t('Title'), dataIndex: 'title' },
          { title: t('Collection'), dataIndex: 'collection' },
          { title: t('Client'), render: (_, record) => <Tag>{record.v2Config ? 'V2' : 'V1'}</Tag> },
          { title: t('Enabled'), dataIndex: 'enabled', render: (value) => t(value ? 'Yes' : 'No') },
          {
            title: t('Actions'),
            render: (_, record) => (
              <Space>
                <Link to={`/admin/settings/shared-forms/${record.key}`}>{t('Configure')}</Link>
                <Button onClick={() => edit(record)}>{t('Edit')}</Button>
                <Popconfirm title={t('Are you sure you want to delete it?')} onConfirm={() => remove(record.key)}>
                  <Button danger>{t('Delete')}</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        title={t(editing ? 'Edit' : 'Add New')}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="collection" label={t('Collection')} rules={[{ required: true }]}>
            <Select disabled={!!editing} showSearch optionFilterProp="label" options={options} />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enable form')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
