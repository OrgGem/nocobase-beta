/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Checkbox, Drawer, Form, Input, Radio, Select, Space, Table, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { uid } from '@formily/shared';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';

interface SharedFormRecord {
  key: string;
  title?: string;
  description?: string;
  type?: string;
  collection?: string;
  enabled?: boolean;
}

const formTypeOptions = [{ value: 'form', label: 'Form' }];

const buildUiSchema = (formSchema: any, t: (key: string) => string) => ({
  type: 'void',
  name: uid(),
  'x-decorator': 'SharedFormMessageProvider',
  properties: {
    form: formSchema,
    promptMessage: {
      type: 'void',
      'x-component': 'h3',
      'x-component-props': {
        style: { margin: '10px 0px 10px' },
        children: '{{ t("Prompt after successful submission",{ns:"shared-forms"})}}',
      },
    },
    success: {
      type: 'void',
      'x-editable': false,
      'x-toolbar-props': { draggable: false },
      'x-settings': 'blockSettings:sharedMarkdown',
      'x-component': 'Markdown.Void',
      'x-decorator': 'CardItem',
      'x-component-props': {
        content: t('# Submitted successfully!\nThis is a demo text, **supports Markdown syntax**.'),
      },
      'x-decorator-props': { name: 'markdown', engine: 'handlebars' },
    },
  },
});

const formBlockSchema = (collection: string, dataSource: string) => ({
  type: 'void',
  'x-toolbar': 'BlockSchemaToolbar',
  'x-toolbar-props': { draggable: false },
  'x-settings': 'blockSettings:sharedForm',
  'x-component': 'CardItem',
  'x-decorator': 'FormBlockProvider',
  'x-decorator-props': { collection, dataSource, type: 'sharedForm' },
  'x-use-decorator-props': 'useCreateFormBlockDecoratorProps',
  properties: {
    a69vmspkv8h: {
      type: 'void',
      'x-component': 'FormV2',
      'x-use-component-props': 'useCreateFormBlockProps',
      properties: {
        grid: { type: 'void', 'x-component': 'Grid', 'x-initializer': 'form:configureFields' },
        l9xfwp6cfh1: {
          type: 'void',
          'x-component': 'ActionBar',
          'x-initializer': 'createForm:configureActions',
          'x-component-props': { layout: 'one-column' },
        },
      },
    },
  },
});

export const AdminSharedFormList = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();

  const [data, setData] = useState<SharedFormRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [collectionOptions, setCollectionOptions] = useState<{ label: string; value: string }[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.resource('sharedForms').list({
        sort: '-createdAt',
        appends: ['createdBy', 'updatedBy', 'allowedRoles'],
        paginate: false,
      });
      setData(res?.data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadCollections = useCallback(async () => {
    try {
      const res = await api.resource('collections').list({ paginate: false });
      const list = res?.data?.data || [];
      setCollectionOptions(
        list.map((c: any) => ({ value: c.name, label: c.title ? `${c.title} (${c.name})` : c.name })),
      );
    } catch {
      setCollectionOptions([]);
    }
  }, [api]);

  const openCreate = () => {
    setEditingKey(null);
    form.resetFields();
    form.setFieldsValue({ type: 'form', enabled: true });
    loadCollections();
    setDrawerOpen(true);
  };

  const openEdit = (record: SharedFormRecord) => {
    setEditingKey(record.key);
    form.resetFields();
    form.setFieldsValue({
      title: record.title,
      collection: record.collection,
      type: record.type || 'form',
      description: record.description,
      enabled: record.enabled !== false,
    });
    loadCollections();
    setDrawerOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      if (editingKey) {
        await api.resource('sharedForms').update({ filterByTk: editingKey, values });
      } else {
        const key = uid();
        const keys = String(values.collection).split(':');
        const collection = keys.pop() as string;
        const dataSource = keys.pop() || 'main';
        const schema: any = buildUiSchema(formBlockSchema(collection, dataSource), t);
        schema['x-uid'] = key;
        await api.resource('sharedForms').create({ values: { ...values, key } });
        await api.resource('uiSchemas').insert({ values: schema });
      }
      message.success(t('Saved successfully'));
      setDrawerOpen(false);
      await loadList();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (record: SharedFormRecord) => {
    await api.resource('sharedForms').destroy({ filterByTk: record.key });
    message.success(t('Deleted'));
    await loadList();
  };

  const typeLabel = useMemo(() => {
    const map = new Map(formTypeOptions.map((o) => [o.value, o.label]));
    return (type?: string) => (type ? map.get(type) || type : '');
  }, []);

  const columns = [
    { title: t('Title'), dataIndex: 'title', width: 170 },
    { title: t('Collection'), dataIndex: 'collection', width: 160 },
    { title: t('Type'), dataIndex: 'type', width: 100, render: (v: string) => typeLabel(v) },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="green">{t('Yes')}</Tag> : <Tag>{t('No')}</Tag>),
    },
    { title: t('Description'), dataIndex: 'description' },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: unknown, record: SharedFormRecord) => (
        <Space split="|">
          <Link to={`/admin/settings/shared-forms/${record.key}`}>{t('Configure')}</Link>
          <a onClick={() => openEdit(record)}>{t('Edit')}</a>
          <a
            onClick={() => {
              modal.confirm({
                title: t('Delete'),
                content: t('Are you sure you want to delete it?'),
                onOk: () => handleDelete(record),
              });
            }}
          >
            {t('Delete')}
          </a>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openCreate}>
          {t('Add New')}
        </Button>
        <Button onClick={loadList}>{t('Refresh')}</Button>
      </Space>
      <Table rowKey="key" loading={loading} dataSource={data} columns={columns} />
      <Drawer
        title={editingKey ? t('Edit') : t('Add New')}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={560}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setDrawerOpen(false)}>{t('Cancel')}</Button>
            <Button type="primary" loading={submitting} onClick={handleSubmit}>
              {t('Submit')}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="collection" label={t('Collection')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={collectionOptions}
              disabled={!!editingKey}
              onFocus={loadCollections}
            />
          </Form.Item>
          <Form.Item name="type" label={t('Type')}>
            <Radio.Group options={formTypeOptions} />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enable form')} valuePropName="checked">
            <Checkbox />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};
