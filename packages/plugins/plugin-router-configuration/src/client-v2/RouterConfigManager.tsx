/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { App, Button, Input, Modal, Space, Table, Tag } from 'antd';
import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useTranslation } from 'react-i18next';
import type { ColumnsType } from 'antd/es/table';

interface RouteRecord {
  id: string | number;
  title?: string;
  type?: string;
  schemaUid?: string;
  menuSchemaUid?: string;
  options?: {
    pathAlias?: string;
    [key: string]: unknown;
  };
  children?: RouteRecord[];
  [key: string]: unknown;
}

const TYPE_TAG_COLORS: Record<string, string> = {
  group: 'blue',
  page: 'green',
  flowPage: 'cyan',
  link: 'orange',
  tabs: 'purple',
};

const TYPE_LABEL_KEYS: Record<string, string> = {
  group: 'Group',
  page: 'Page',
  flowPage: 'Page (v2)',
  link: 'Link',
  tabs: 'Tabs',
};

const RENAMABLE_TYPES = new Set(['group', 'page', 'flowPage', 'link']);
const DEFAULT_DESKTOP_LAYOUT_UID = 'admin-layout-model';

const collectRouteIds = (routes: RouteRecord[], ids = new Set<string>()) => {
  for (const route of routes) {
    if (route.id !== undefined && route.id !== null) {
      ids.add(String(route.id));
    }
    if (route.children) {
      collectRouteIds(route.children, ids);
    }
  }
  return ids;
};

const loadSupportedDesktopRouteIds = async (api: ReturnType<typeof useApp>['apiClient']) => {
  try {
    const layoutsRes = await api.request({ url: '/uiLayouts:listAccessible' });
    const layouts = layoutsRes?.data?.data as Array<{ uid?: string; layoutType?: string }> | undefined;
    const desktopLayoutUids = Array.isArray(layouts)
      ? layouts.filter((layout) => layout.layoutType === 'desktop' && layout.uid).map((layout) => layout.uid as string)
      : [];
    const requestedLayoutUids = desktopLayoutUids.length ? desktopLayoutUids : [DEFAULT_DESKTOP_LAYOUT_UID];
    const routeResponses = await Promise.all(
      requestedLayoutUids.map((layout) =>
        api.request({
          url: '/desktopRoutes:listAccessible',
          params: { tree: true, sort: 'sort', layout },
        }),
      ),
    );
    const routeIds = new Set<string>();
    for (const response of routeResponses) {
      const routes = response?.data?.data;
      if (Array.isArray(routes)) {
        for (const id of collectRouteIds(routes)) {
          routeIds.add(id);
        }
      }
    }
    return routeIds;
  } catch {
    return new Set<string>();
  }
};

interface RouterConfigManagerViewProps {
  api: ReturnType<typeof useApp>['apiClient'];
  enablePathAliases?: boolean;
  refreshRoutes?: () => Promise<unknown>;
}

export function RouterConfigManagerView({
  api,
  enablePathAliases = false,
  refreshRoutes,
}: RouterConfigManagerViewProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [routes, setRoutes] = useState<RouteRecord[]>([]);
  const [supportedDesktopRouteIds, setSupportedDesktopRouteIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [renameModal, setRenameModal] = useState<{
    visible: boolean;
    record: RouteRecord | null;
    mode: 'rename' | 'alias';
  }>({ visible: false, record: null, mode: 'rename' });
  const [newPath, setNewPath] = useState('');
  const [saving, setSaving] = useState(false);
  const isSupportedAliasRoute = useCallback(
    (record: RouteRecord | null) =>
      !!record && record.type === 'flowPage' && supportedDesktopRouteIds.has(String(record.id)),
    [supportedDesktopRouteIds],
  );

  const loadRoutes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: '/desktopRoutes:list',
        params: { tree: true, sort: 'sort' },
      });
      const routeData = res?.data?.data || [];
      if (enablePathAliases) {
        const [aliasRes, desktopRouteIds] = await Promise.all([
          api.request({ url: '/desktopRoutes:listPathAliases' }),
          loadSupportedDesktopRouteIds(api),
        ]);
        const aliases = aliasRes?.data?.data || [];
        setSupportedDesktopRouteIds(desktopRouteIds);
        const aliasByRouteId = new Map<string, string>();
        for (const alias of aliases as Array<{ desktopRouteId?: string | number; pathAlias?: string }>) {
          if (alias.desktopRouteId != null && typeof alias.pathAlias === 'string') {
            aliasByRouteId.set(String(alias.desktopRouteId), alias.pathAlias);
          }
        }
        const applyAliases = (items: RouteRecord[]): RouteRecord[] =>
          items.map((route) => {
            const pathAlias = aliasByRouteId.get(String(route.id));
            const options = { ...route.options };
            delete options.pathAlias;
            if (pathAlias) {
              options.pathAlias = pathAlias;
            }
            return {
              ...route,
              options,
              children: route.children ? applyAliases(route.children) : undefined,
            };
          });
        setRoutes(applyAliases(routeData));
      } else {
        setRoutes(routeData);
      }
    } catch {
      message.error(t('Failed to load routes'));
    }
    setLoading(false);
  }, [api, enablePathAliases, message, t]);

  useEffect(() => {
    loadRoutes();
  }, [loadRoutes]);

  const handleOpenRename = (record: RouteRecord) => {
    setRenameModal({ visible: true, record, mode: 'rename' });
    setNewPath(record.schemaUid || '');
  };

  const handleOpenAlias = (record: RouteRecord) => {
    setRenameModal({ visible: true, record, mode: 'alias' });
    setNewPath(record.options?.pathAlias || '');
  };

  const handleSaveRename = useCallback(async () => {
    if (!renameModal.record) return;

    const trimmed = newPath.trim();
    if (renameModal.mode === 'rename' && !trimmed) {
      message.warning(t('Please enter a new path'));
      return;
    }

    if (renameModal.mode === 'alias' && trimmed && !isSupportedAliasRoute(renameModal.record)) {
      message.error(t('This route is not eligible for a URL alias. Clear the field to remove the existing alias.'));
      return;
    }

    if (trimmed && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(trimmed)) {
      message.error(t('Invalid path format. Use lowercase letters, numbers, and hyphens only.'));
      return;
    }

    setSaving(true);
    try {
      await api.request({
        method: 'POST',
        url: renameModal.mode === 'alias' ? '/desktopRoutes:setPathAlias' : '/desktopRoutes:renamePath',
        data: {
          values: {
            id: renameModal.record.id,
            ...(renameModal.mode === 'alias' ? { pathAlias: trimmed || null } : { schemaUid: trimmed }),
          },
        },
      });
      message.success(t(renameModal.mode === 'alias' ? 'URL alias saved successfully' : 'Path renamed successfully'));
      setRenameModal({ visible: false, record: null, mode: 'rename' });
      await refreshRoutes?.();
      await loadRoutes();
    } catch (err: unknown) {
      const errMsg =
        err && typeof err === 'object' && 'message' in err
          ? (err as { message: string }).message
          : t(renameModal.mode === 'alias' ? 'Failed to save URL alias' : 'Failed to rename path');
      message.error(errMsg);
    }
    setSaving(false);
  }, [
    renameModal.record,
    renameModal.mode,
    newPath,
    api,
    message,
    loadRoutes,
    refreshRoutes,
    t,
    isSupportedAliasRoute,
  ]);

  const columns: ColumnsType<RouteRecord> = [
    {
      title: t('Title'),
      dataIndex: 'title',
      key: 'title',
      width: 300,
      ellipsis: true,
      render: (text: string | undefined, record: RouteRecord) => (
        <span style={{ fontWeight: record.type === 'group' ? 600 : 400 }}>
          {text || <em style={{ color: '#999' }}>{t('Untitled')}</em>}
        </span>
      ),
    },
    {
      title: t('Type'),
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (type: string | undefined) => {
        const labelKey = TYPE_LABEL_KEYS[type || ''];
        const label = labelKey ? t(labelKey) : type || '-';
        const color = TYPE_TAG_COLORS[type || ''] || 'default';
        return <Tag color={color}>{label}</Tag>;
      },
    },
    {
      title: t('Path'),
      dataIndex: 'schemaUid',
      key: 'schemaUid',
      ellipsis: true,
      render: (text: string | undefined) =>
        text ? <code style={{ fontSize: 12 }}>{text}</code> : <em style={{ color: '#ccc' }}>{t('None')}</em>,
    },
    ...(enablePathAliases
      ? [
          {
            title: t('URL Alias'),
            dataIndex: ['options', 'pathAlias'],
            key: 'pathAlias',
            ellipsis: true,
            render: (text: string | undefined) =>
              text ? <code style={{ fontSize: 12 }}>{text}</code> : <em style={{ color: '#ccc' }}>{t('None')}</em>,
          } satisfies ColumnsType<RouteRecord>[number],
        ]
      : []),
    {
      title: t('Actions'),
      key: 'actions',
      width: enablePathAliases ? 150 : 120,
      render: (_: unknown, record: RouteRecord) => {
        const isTab = record.type === 'tabs';
        const isModernPage = record.type === 'flowPage';
        const hasExistingAlias = typeof record.options?.pathAlias === 'string' && !!record.options.pathAlias;
        if (enablePathAliases && (isSupportedAliasRoute(record) || hasExistingAlias)) {
          return (
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleOpenAlias(record)}>
              {t('Edit URL Alias')}
            </Button>
          );
        }
        if (!isTab && !RENAMABLE_TYPES.has(record.type || '')) {
          return null;
        }
        return (
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleOpenRename(record)}
            disabled={isTab || isModernPage || !record.schemaUid}
            title={
              isTab ? t('Tab paths cannot be renamed') : isModernPage ? t('V2 page paths cannot be renamed') : undefined
            }
          >
            {t('Rename Path')}
          </Button>
        );
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h2>{t('Router Configuration')}</h2>
        <Button icon={<ReloadOutlined />} onClick={loadRoutes}>
          {t('Refresh')}
        </Button>
      </div>

      <Table<RouteRecord>
        columns={columns}
        dataSource={routes}
        rowKey="id"
        loading={loading}
        defaultExpandAllRows
        pagination={false}
        size="middle"
        childrenColumnName="children"
        scroll={{ x: 800 }}
      />

      <Modal
        title={t(renameModal.mode === 'alias' ? 'Edit URL Alias' : 'Rename Path')}
        open={renameModal.visible}
        onOk={handleSaveRename}
        onCancel={() => setRenameModal({ visible: false, record: null, mode: 'rename' })}
        confirmLoading={saving}
        okButtonProps={{
          disabled:
            renameModal.mode === 'alias' && Boolean(newPath.trim()) && !isSupportedAliasRoute(renameModal.record),
        }}
        destroyOnClose
      >
        {renameModal.record && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <strong>{t('Route')}:</strong> {renameModal.record.title || <em>{t('Untitled')}</em>}
            </div>
            <div>
              <strong>
                {t(
                  renameModal.mode === 'alias' && renameModal.record.type === 'flowPage'
                    ? 'Native FlowModel ID'
                    : 'Current Path',
                )}
                :
              </strong>{' '}
              <code>{renameModal.record.schemaUid || <em>{t('None')}</em>}</code>
            </div>
            <div>
              <strong>{t(renameModal.mode === 'alias' ? 'URL Alias' : 'New Path')}:</strong>
              <Input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder={renameModal.mode === 'alias' ? 'e.g. sales-dashboard' : 'e.g. sales-dashboard'}
                style={{ marginTop: 4 }}
                onPressEnter={() => {
                  handleSaveRename();
                }}
              />
              <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
                {renameModal.mode === 'alias' && !isSupportedAliasRoute(renameModal.record)
                  ? t('This route is not eligible for a URL alias. Clear the field to remove the existing alias.')
                  : t(
                      renameModal.mode === 'alias'
                        ? 'Use lowercase letters, numbers, and hyphens. Leave blank to remove the alias.'
                        : 'Use lowercase letters, numbers, and hyphens. Example: my-page, sales-report',
                    )}
              </div>
            </div>
          </Space>
        )}
      </Modal>
    </div>
  );
}

export function RouterConfigManager() {
  const app = useApp();

  return (
    <RouterConfigManagerView
      api={app.apiClient}
      enablePathAliases
      refreshRoutes={() => app.flowEngine.context.routeRepository.refreshAccessible()}
    />
  );
}

export default RouterConfigManager;
