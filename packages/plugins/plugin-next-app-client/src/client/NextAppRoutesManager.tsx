/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import {
  Card,
  Table,
  Space,
  Button,
  message,
  Popconfirm,
  Input,
  Modal,
  Form,
  Select,
  Tag,
  Typography,
  Checkbox,
  Tooltip,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  ReloadOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import React, { FC, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Map route type to a visual tag, matching the Desktop routes table
 */
const TypeTag: FC<{ value: string }> = ({ value }) => {
  const { t } = useTranslation();
  const typeMap: Record<string, { label: string; color: string }> = {
    page: { label: t('Page'), color: 'blue' },
    flowPage: { label: t('Modern page'), color: 'geekblue' },
    group: { label: t('Group'), color: 'green' },
    link: { label: t('Link'), color: 'orange' },
    tabs: { label: t('Tab'), color: 'purple' },
  };
  const info = typeMap[value] || { label: value || t('Unknown'), color: 'default' };
  return <Tag color={info.color}>{info.label}</Tag>;
};

/**
 * Compute the URL path for a route
 */
const getRoutePath = (record: any, allRoutes: any[], appPath?: string): string | null => {
  if (record.type === 'group' || record.type === 'link') {
    return null;
  }

  const prefix = appPath ? `/next-app/${appPath.replace(/^\//, '')}` : '/next-app';

  if (record.type === 'page' || record.type === 'flowPage') {
    return record.schemaUid ? `${prefix}/${record.schemaUid}` : null;
  }

  if (record.type === 'tabs' && record.parentId) {
    const findParent = (items: any[]): any => {
      for (const item of items) {
        if (item.id === record.parentId) return item;
        if (item.children) {
          const found = findParent(item.children);
          if (found) return found;
        }
      }
      return null;
    };
    const parent = findParent(allRoutes);
    if (parent?.schemaUid) {
      return `${prefix}/${parent.schemaUid}/tabs/${record.schemaUid}`;
    }
  }

  return null;
};

/**
 * NextAppRoutesManager
 * Manages the nextAppRoutes collection — a settings table showing all next-app routes
 * with columns matching the Desktop routes table: Title, Type, Show in menu, Path, Actions.
 *
 * Since /next-app mirrors /admin (same AdminLayout + AdminDynamicPage), pages and schemas
 * come from desktopRoutes. This manager is mainly for viewing/managing route metadata.
 */
export const NextAppRoutesManager: FC<{ configId?: number; appPath?: string }> = ({ configId, appPath }) => {
  const { t } = useTranslation();
  const api = useApp().apiClient;
  const [modalVisible, setModalVisible] = useState(false);
  const [editingRoute, setEditingRoute] = useState<any>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest<{ data: any[] }, any[]>(() =>
    api
      .resource('nextAppRoutes')
      .list({
        tree: true,
        sort: 'sort',
        paginate: false,
        filter: {
          'hidden.$ne': true,
          configId: configId || null,
        },
      })
      .then((res) => res?.data),
  );

  const routes = useMemo(() => data?.data || [], [data]);

  const handleCreate = useCallback(async () => {
    setEditingRoute(null);
    form.resetFields();
    form.setFieldsValue({ type: 'page', showInMenu: true });
    setModalVisible(true);
  }, [form]);

  const handleEdit = useCallback(
    (record: any) => {
      setEditingRoute(record);
      form.setFieldsValue({
        title: record.title,
        icon: record.icon,
        type: record.type || 'page',
        showInMenu: !record.hideInMenu,
      });
      setModalVisible(true);
    },
    [form],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await api.resource('nextAppRoutes').destroy({ filterByTk: id });
        message.success(t('Deleted successfully'));
        refresh();
      } catch (err) {
        message.error(t('Failed to delete'));
      }
    },
    [api, refresh, t],
  );

  const handleSubmit = useCallback(async () => {
    try {
      const values = await form.validateFields();

      // Convert showInMenu (true=visible) to hideInMenu (true=hidden)
      const { showInMenu, ...rest } = values;
      const submitValues: any = {
        ...rest,
        hideInMenu: !showInMenu,
      };

      if (editingRoute) {
        await api.resource('nextAppRoutes').update({
          filterByTk: editingRoute.id,
          values: submitValues,
        });
        message.success(t('Updated successfully'));
      } else {
        await api.resource('nextAppRoutes').create({
          values: {
            ...submitValues,
            configId: configId || null,
          },
        });
        message.success(t('Created successfully'));
      }

      setModalVisible(false);
      refresh();
    } catch (err) {
      console.error(err);
    }
  }, [api, configId, editingRoute, form, refresh, t]);

  const columns = [
    {
      title: t('Title'),
      dataIndex: 'title',
      key: 'title',
      width: 200,
      ellipsis: true,
      render: (title: string, record: any) => {
        const displayTitle = title || (record.type === 'tabs' ? t('Unnamed') : '');
        return (
          <span>
            {record.icon && <span style={{ marginRight: 4 }}>{record.icon}</span>}
            {displayTitle}
          </span>
        );
      },
    },
    {
      title: t('Type'),
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (type: string) => <TypeTag value={type} />,
    },
    {
      title: t('Show in menu'),
      dataIndex: 'hideInMenu',
      key: 'hideInMenu',
      width: 120,
      align: 'center' as const,
      render: (hideInMenu: boolean) =>
        hideInMenu ? <CloseOutlined style={{ color: '#ff4d4f' }} /> : <CheckOutlined style={{ color: '#52c41a' }} />,
    },
    {
      title: t('Path'),
      key: 'path',
      width: 300,
      ellipsis: true,
      render: (_: any, record: any) => {
        const path = getRoutePath(record, routes, appPath);
        if (!path) return null;
        return (
          <Typography.Paragraph copyable style={{ marginBottom: 0 }} ellipsis>
            {path}
          </Typography.Paragraph>
        );
      },
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 200,
      render: (_: any, record: any) => (
        <Space size="small">
          <Tooltip title={t('Edit')}>
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          {(record.type === 'page' || record.type === 'flowPage') && record.schemaUid ? (
            <Tooltip title={t('Access')}>
              <Button
                type="link"
                size="small"
                icon={<EyeOutlined />}
                onClick={() => {
                  const path = getRoutePath(record, routes, appPath);
                  if (path) window.open(path, '_blank');
                }}
              />
            </Tooltip>
          ) : null}
          <Popconfirm title={t('Are you sure you want to delete it?')} onConfirm={() => handleDelete(record.id)}>
            <Tooltip title={t('Delete')}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card bordered={false}>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
          {t('Refresh')}
        </Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
          {t('Add new')}
        </Button>
      </div>
      <Table
        loading={loading}
        dataSource={routes}
        columns={columns}
        rowKey="id"
        size="middle"
        pagination={false}
        expandable={{
          defaultExpandAllRows: false,
          childrenColumnName: 'children',
        }}
        rowSelection={{
          type: 'checkbox',
        }}
      />
      <Modal
        open={modalVisible}
        title={editingRoute ? t('Edit') : t('Add new')}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="type" label={t('Type')} initialValue="page" rules={[{ required: true }]}>
            <Select
              disabled={!!editingRoute}
              options={[
                { label: t('Group'), value: 'group' },
                { label: t('Page'), value: 'page' },
                { label: t('Link'), value: 'link' },
              ]}
            />
          </Form.Item>
          <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="icon" label={t('Icon')}>
            <Input placeholder="e.g., HomeOutlined" />
          </Form.Item>
          <Form.Item name="showInMenu" valuePropName="checked" initialValue={true}>
            <Checkbox>{t('Show in menu')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
