import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Checkbox, Drawer, Form, Input, InputNumber, Popconfirm, Space, Table, Tag } from 'antd';
import React, { useState } from 'react';
import {
  categoryFields,
  categoryListFields,
  categoryValues,
  newCategory,
  type Category,
  type CategoryValues,
} from '../categories';
import { useT } from '../locale';

export default function CategoriesManager() {
  const api = useApp().apiClient;
  const t = useT();
  const { message } = App.useApp();
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Category>();
  const [form] = Form.useForm<CategoryValues>();
  const list = useRequest(
    async () => {
      const response = await api.request<{ data: Category[]; meta?: { count?: number } }>({
        url: 'ocrVerifyCategories:list',
        method: 'get',
        params: { page, pageSize, sort: ['-createdAt'], fields: categoryListFields },
      });
      return response.data;
    },
    { refreshDeps: [page, pageSize] },
  );
  const save = useRequest(
    async (values: CategoryValues) => {
      await api.request({
        url: `ocrVerifyCategories:${editing ? 'update' : 'create'}`,
        method: 'post',
        params: editing ? { filterByTk: editing.id } : undefined,
        data: categoryValues(values),
      });
      setOpen(false);
      message.success(t(editing ? 'Category updated successfully' : 'Category created successfully'));
      await list.refreshAsync();
    },
    {
      manual: true,
      onError: () => message.error(t(editing ? 'Failed to update category' : 'Failed to create category')),
    },
  );
  const destroy = useRequest(
    async (id: string | number) => {
      await api.request({ url: 'ocrVerifyCategories:destroy', method: 'post', params: { filterByTk: id } });
      await list.refreshAsync();
    },
    { manual: true, onError: () => message.error(t('Operation failed')) },
  );

  function showEditor(category?: Category) {
    setEditing(category);
    form.resetFields();
    form.setFieldsValue({ ...(category || newCategory()), callbackApiKey: '', clearCallbackApiKey: false });
    setOpen(true);
  }
  return (
    <>
      {list.error && (
        <Alert type="error" message={t('Failed to load categories')} showIcon style={{ marginBottom: 16 }} />
      )}
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={() => showEditor()}>
          {t('Add new')}
        </Button>
        <Button onClick={list.refresh}>{t('Refresh status')}</Button>
      </Space>
      <Table<Category>
        rowKey="id"
        loading={list.loading || destroy.loading}
        dataSource={list.data?.data || []}
        pagination={{
          current: page,
          pageSize,
          total: list.data?.meta?.count || 0,
          showSizeChanger: true,
          onChange: (next, size) => {
            setPage(next);
            setPageSize(size);
          },
        }}
        columns={[
          { title: t('Title'), dataIndex: 'title' },
          { title: t('Name'), dataIndex: 'name' },
          {
            title: t('Enabled'),
            dataIndex: 'enabled',
            render: (enabled: boolean) => <Tag>{t(enabled ? 'Yes' : 'No')}</Tag>,
          },
          {
            title: t('Actions'),
            render: (_: unknown, category: Category) => (
              <Space>
                <Button type="link" onClick={() => showEditor(category)}>
                  {t('Edit')}
                </Button>
                <Popconfirm title={t('Delete category?')} onConfirm={() => destroy.runAsync(category.id)}>
                  <Button type="link" danger disabled={destroy.loading}>
                    {t('Delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Drawer
        open={open}
        title={t(editing ? 'Edit category' : 'Add new category')}
        width={560}
        forceRender
        onClose={() => {
          if (!save.loading) setOpen(false);
        }}
        extra={
          <Button type="primary" loading={save.loading} onClick={() => form.submit()}>
            {t('Submit')}
          </Button>
        }
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          disabled={save.loading}
          onFinish={(values) => save.run(values)}
        >
          {categoryFields.map(([name, label, required]) => (
            <Form.Item key={name} name={name} label={t(label)} rules={required ? [{ required: true }] : undefined}>
              {name === 'description' ? <Input.TextArea rows={3} /> : <Input />}
            </Form.Item>
          ))}
          <Form.Item name="callbackTimeoutMs" label={t('Callback timeout (ms)')}>
            <InputNumber min={1000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="callbackApiKey"
            label={t('Callback API key')}
            extra={t('Leave empty to keep the existing key. Sent as X-API-Key.')}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          {editing && (
            <Form.Item name="clearCallbackApiKey" valuePropName="checked">
              <Checkbox>{t('Clear stored callback API key')}</Checkbox>
            </Form.Item>
          )}
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>{t('Enabled')}</Checkbox>
          </Form.Item>
        </Form>
      </Drawer>
    </>
  );
}
