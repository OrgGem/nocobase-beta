/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { IconPicker, useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import React, { useState } from 'react';
import { useT } from './locale';
import { flattenRoutes, hubLink, hubPath, type HubRoute, type RouteId } from './routes';

type EditableRoute = HubRoute & { id: RouteId };
type RouteForm = {
  title: string;
  type: string;
  schemaUid?: string;
  parentId?: RouteId;
  icon?: string;
  showInMenu: boolean;
  options?: { url?: string; openInNewWindow?: boolean };
};

export default function NextAppRoutesManager({ configId, appPath }: { configId: RouteId; appPath: string }) {
  const app = useApp();
  const api = app.apiClient;
  const t = useT();
  const { message } = App.useApp();
  const [form] = Form.useForm<RouteForm>();
  const [editing, setEditing] = useState<EditableRoute>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const type = Form.useWatch('type', form);
  const { data, loading, error, refreshAsync, refresh } = useRequest(
    async () => {
      const [routes, desktop] = await Promise.all([
        api.request<{ data: EditableRoute[] }>({
          url: 'nextAppRoutes:list',
          params: { tree: true, paginate: false, sort: 'sort', filter: { configId, hidden: { $ne: true } } },
        }),
        api.request<{ data: HubRoute[] }>({
          url: 'desktopRoutes:listAccessible',
          params: { tree: true, paginate: false, sort: 'sort' },
        }),
      ]);
      return { routes: routes.data.data || [], desktop: desktop.data.data || [] };
    },
    { refreshDeps: [api, configId] },
  );
  const routes = error ? [] : data?.routes || [];
  const flat = flattenRoutes(routes);
  const pages = flattenRoutes(data?.desktop || []).filter((route) => route.type === 'flowPage' && route.schemaUid);

  function edit(record?: EditableRoute) {
    setEditing(record);
    form.resetFields();
    form.setFieldsValue(
      record
        ? { ...record, type: record.type || 'flowPage', showInMenu: !record.hideInMenu }
        : { type: 'flowPage', showInMenu: true },
    );
    setOpen(true);
  }

  async function save() {
    const values = await form.validateFields();
    const selectedPage = pages.find((page) => page.schemaUid === values.schemaUid);
    if (values.type === 'flowPage' && !selectedPage && values.schemaUid !== editing?.schemaUid) {
      message.error(t('Select an accessible modern page'));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: values.title,
        icon: values.icon,
        type: values.type,
        configId,
        parentId: values.parentId ?? null,
        hideInMenu: !values.showInMenu,
        schemaUid: ['flowPage', 'page', 'tabs'].includes(values.type) ? values.schemaUid : null,
        options: values.type === 'link' ? values.options : null,
      };
      await api.request({
        url: `nextAppRoutes:${editing ? 'update' : 'create'}`,
        method: 'post',
        params: editing ? { filterByTk: editing.id } : undefined,
        data: payload,
      });
      setOpen(false);
      await refreshAsync();
      message.success(t('Saved successfully'));
    } catch {
      message.error(t('Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: RouteId) {
    setSaving(true);
    try {
      await api.request({ url: 'nextAppRoutes:destroy', method: 'post', params: { filterByTk: id } });
      await refreshAsync();
      message.success(t('Deleted successfully'));
    } catch {
      message.error(t('Failed to delete'));
    } finally {
      setSaving(false);
    }
  }

  async function move(record: EditableRoute, direction: -1 | 1) {
    const siblings = flat.filter((route) => String(route.parentId ?? '') === String(record.parentId ?? ''));
    const index = siblings.findIndex((route) => String(route.id) === String(record.id));
    const target = siblings[index + direction];
    if (!target) return;
    setSaving(true);
    try {
      await api.request({
        url: 'nextAppRoutes:move',
        method: 'post',
        params: {
          sourceId: record.id,
          targetId: target.id,
          sortField: 'sort',
          method: direction < 0 ? 'insertBefore' : 'insertAfter',
        },
      });
      await refreshAsync();
    } catch {
      message.error(t('Failed to move'));
    } finally {
      setSaving(false);
    }
  }

  const columns: TableColumnsType<EditableRoute> = [
    { title: t('Title'), dataIndex: 'title' },
    {
      title: t('Type'),
      dataIndex: 'type',
      render: (value) => (
        <Tag>
          {t(
            value === 'flowPage'
              ? 'Modern page'
              : value === 'page'
                ? 'Legacy page'
                : value === 'group'
                  ? 'Group'
                  : value === 'tabs'
                    ? 'Tab'
                    : 'Link',
          )}
        </Tag>
      ),
    },
    { title: t('Show in menu'), dataIndex: 'hideInMenu', render: (value) => t(value ? 'No' : 'Yes') },
    {
      title: t('Path'),
      render: (_, record) =>
        record.schemaUid && ['flowPage', 'page'].includes(record.type || '') ? (
          <a href={app.getRouteUrl(hubPath(appPath, record.schemaUid))} target="_blank" rel="noopener noreferrer">
            {hubPath(appPath, record.schemaUid)}
          </a>
        ) : null,
    },
    {
      title: t('Actions'),
      render: (_, record) => (
        <Space wrap>
          <Button disabled={saving} onClick={() => edit(record)}>
            {t('Edit')}
          </Button>
          <Button disabled={saving} onClick={() => move(record, -1)}>
            {t('Move up')}
          </Button>
          <Button disabled={saving} onClick={() => move(record, 1)}>
            {t('Move down')}
          </Button>
          <Popconfirm title={t('Are you sure you want to delete it?')} onConfirm={() => remove(record.id)}>
            <Button danger disabled={saving}>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  const excludedParents = editing
    ? new Set(flattenRoutes([editing]).map((route) => String(route.id)))
    : new Set<string>();
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {error && (
        <Alert
          type="error"
          showIcon
          message={t('Failed to load routes')}
          action={<Button onClick={refresh}>{t('Retry')}</Button>}
        />
      )}
      <Alert
        type="info"
        message={t('Hub pages reuse accessible Desktop pages. Create modern pages in Desktop, then select them here.')}
      />
      <Space>
        <Button onClick={() => edit()}>{t('Add new')}</Button>
        <Button onClick={refresh}>{t('Refresh')}</Button>
      </Space>
      <Table<EditableRoute>
        rowKey="id"
        loading={loading || saving}
        dataSource={routes}
        columns={columns}
        pagination={false}
      />
      <Modal
        title={t(editing ? 'Edit' : 'Add new')}
        open={open}
        confirmLoading={saving}
        onOk={save}
        onCancel={() => setOpen(false)}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item name="type" label={t('Type')} rules={[{ required: true }]}>
            <Select
              disabled={!!editing}
              options={[
                { value: 'flowPage', label: t('Modern page') },
                { value: 'group', label: t('Group') },
                { value: 'link', label: t('Link') },
                ...(editing?.type === 'page' ? [{ value: 'page', label: t('Legacy page') }] : []),
                ...(editing?.type === 'tabs' ? [{ value: 'tabs', label: t('Tab') }] : []),
              ]}
            />
          </Form.Item>
          <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {['flowPage', 'page'].includes(type || '') && (
            <Form.Item name="schemaUid" label={t('Desktop page')} rules={[{ required: true }]}>
              <Select
                disabled={!!editing}
                showSearch
                optionFilterProp="label"
                options={pages.map((page) => ({ value: page.schemaUid, label: page.title || page.schemaUid }))}
              />
            </Form.Item>
          )}
          <Form.Item name="parentId" label={t('Parent group')}>
            <Select
              disabled={type === 'tabs'}
              allowClear
              options={flat
                .filter((route) => route.type === 'group' && !excludedParents.has(String(route.id)))
                .map((route) => ({ value: route.id, label: route.title || String(route.id) }))}
            />
          </Form.Item>
          <Form.Item name="icon" label={t('Icon')}>
            <IconPicker />
          </Form.Item>
          {type === 'link' && (
            <>
              <Form.Item
                name={['options', 'url']}
                label={t('URL')}
                rules={[
                  { required: true },
                  {
                    validator: (_, value: string) =>
                      value && hubLink(value, appPath)
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('Invalid URL'))),
                  },
                ]}
              >
                <Input />
              </Form.Item>
              <Form.Item name={['options', 'openInNewWindow']} valuePropName="checked">
                <Checkbox>{t('Open in new window')}</Checkbox>
              </Form.Item>
            </>
          )}
          <Form.Item name="showInMenu" valuePropName="checked">
            <Checkbox>{t('Show in menu')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
