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
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getHubPagePath, getHubTabPath } from './hubRouteContract';
import type { NextAppDesktopRoute } from './nextAppRoutesContext';

interface EditableRoute extends NextAppDesktopRoute {
  configId?: number | null;
  sort?: number;
  children?: EditableRoute[];
}

interface RouteFormValues {
  title: string;
  icon?: string;
  type: string;
  showInMenu: boolean;
}

const flattenRouteIds = (routes: EditableRoute[]): string[] =>
  routes.flatMap((route) => [String(route.id), ...flattenRouteIds(route.children || [])]);

const SortableRow = (props: React.HTMLAttributes<HTMLTableRowElement> & { 'data-row-key': string }) => {
  const { 'data-row-key': rowKey, ...restProps } = props;
  const sortableId = String(rowKey);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId });
  return (
    <tr
      {...restProps}
      {...attributes}
      {...listeners}
      ref={setNodeRef}
      data-row-key={sortableId}
      style={{
        ...restProps.style,
        transform: CSS.Transform.toString(transform),
        transition,
        cursor: 'move',
        position: isDragging ? 'relative' : undefined,
        zIndex: isDragging ? 1 : undefined,
      }}
    />
  );
};

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
const getRoutePath = (record: EditableRoute, allRoutes: EditableRoute[], appPath?: string): string | null => {
  if (record.type === 'group' || record.type === 'link') {
    return null;
  }

  const normalizedAppPath = appPath?.replace(/^\//, '') || '';

  if (record.type === 'page' || record.type === 'flowPage') {
    return record.schemaUid && normalizedAppPath ? getHubPagePath(normalizedAppPath, record.schemaUid) : null;
  }

  if (record.type === 'tabs' && record.parentId) {
    const findParent = (items: EditableRoute[]): EditableRoute | undefined => {
      for (const item of items) {
        if (item.id === record.parentId) return item;
        if (item.children) {
          const found = findParent(item.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    const parent = findParent(allRoutes);
    if (parent?.schemaUid) {
      return normalizedAppPath && record.schemaUid
        ? getHubTabPath(normalizedAppPath, parent.schemaUid, record.schemaUid)
        : null;
    }
  }

  return null;
};

/**
 * NextAppRoutesManager
 * Manages the nextAppRoutes collection — a settings table showing all next-app routes
 * with columns matching the Desktop routes table: Title, Type, Show in menu, Path, Actions.
 *
 * Page schemas are projected from desktop routes while navigation remains inside Hub.
 */
export const NextAppRoutesManager: FC<{ configId?: number; appPath?: string }> = ({ configId, appPath }) => {
  const { t } = useTranslation();
  const app = useApp();
  const api = app.apiClient;
  const [modalVisible, setModalVisible] = useState(false);
  const [editingRoute, setEditingRoute] = useState<EditableRoute | null>(null);
  const [form] = Form.useForm();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const { data, loading, refresh } = useRequest<{ data: EditableRoute[] }, []>(() =>
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
  const sortableRouteIds = useMemo(() => flattenRouteIds(routes), [routes]);

  const handleDragEnd = useCallback(
    async ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) {
        return;
      }
      try {
        await api.resource('nextAppRoutes').move({
          sourceId: active.id,
          targetId: over.id,
          sortField: 'sort',
        });
        await refresh();
      } catch {
        message.error(t('Failed to move'));
      }
    },
    [api, refresh, t],
  );

  const handleCreate = useCallback(async () => {
    setEditingRoute(null);
    form.resetFields();
    form.setFieldsValue({ type: 'page', showInMenu: true });
    setModalVisible(true);
  }, [form]);

  const handleEdit = useCallback(
    (record: EditableRoute) => {
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
      const values = (await form.validateFields()) as RouteFormValues;

      // Convert showInMenu (true=visible) to hideInMenu (true=hidden)
      const { showInMenu, ...rest } = values;
      const submitValues: Omit<RouteFormValues, 'showInMenu'> & { hideInMenu: boolean } = {
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
      render: (title: string, record: EditableRoute) => {
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
      render: (_: unknown, record: EditableRoute) => {
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
      render: (_: unknown, record: EditableRoute) => (
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
                  if (path) window.open(app.getRouteUrl(path), '_blank', 'noopener,noreferrer');
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
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={sortableRouteIds} strategy={verticalListSortingStrategy}>
          <Table
            loading={loading}
            dataSource={routes}
            columns={columns}
            rowKey="id"
            size="middle"
            pagination={false}
            scroll={{ x: 940 }}
            components={{ body: { row: SortableRow } }}
            expandable={{
              defaultExpandAllRows: false,
              childrenColumnName: 'children',
            }}
            rowSelection={{
              type: 'checkbox',
            }}
          />
        </SortableContext>
      </DndContext>
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
