import React, { useCallback, useEffect, useState } from 'react';
import { App, Button, Input, Modal, Space, Table, Tag } from 'antd';
import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useTranslation } from 'react-i18next';
import type { ColumnsType } from 'antd/es/table';

interface RouteRecord {
  id: number;
  title?: string;
  type?: string;
  schemaUid?: string;
  menuSchemaUid?: string;
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

const RENAMABLE_TYPES = new Set(['group', 'page', 'flowPage', 'link', 'tabs']);

export function RouterConfigManager() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const api = useApp().apiClient;
  const [routes, setRoutes] = useState<RouteRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [renameModal, setRenameModal] = useState<{
    visible: boolean;
    record: RouteRecord | null;
  }>({ visible: false, record: null });
  const [newPath, setNewPath] = useState('');
  const [saving, setSaving] = useState(false);

  const loadRoutes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: '/desktopRoutes:list',
        params: { tree: true, sort: 'sort' },
      });
      setRoutes(res?.data?.data || []);
    } catch {
      message.error(t('Failed to load routes'));
    }
    setLoading(false);
  }, [api, message, t]);

  useEffect(() => {
    loadRoutes();
  }, [loadRoutes]);

  const handleOpenRename = (record: RouteRecord) => {
    setRenameModal({ visible: true, record });
    setNewPath(record.schemaUid || '');
  };

  const handleSaveRename = useCallback(async () => {
    if (!renameModal.record) return;

    const trimmed = newPath.trim();
    if (!trimmed) {
      message.warning(t('Please enter a new path'));
      return;
    }

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(trimmed)) {
      message.error(t('Invalid path format. Use lowercase letters, numbers, and hyphens only.'));
      return;
    }

    setSaving(true);
    try {
      await api.request({
        method: 'POST',
        url: '/desktopRoutes:renamePath',
        data: { id: renameModal.record.id, schemaUid: trimmed },
      });
      message.success(t('Path renamed successfully'));
      setRenameModal({ visible: false, record: null });
      loadRoutes();
    } catch (err: unknown) {
      const errMsg =
        err && typeof err === 'object' && 'message' in err
          ? (err as { message: string }).message
          : t('Failed to rename path');
      message.error(errMsg);
    }
    setSaving(false);
  }, [renameModal.record, newPath, api, message, loadRoutes, t]);

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
    {
      title: t('Actions'),
      key: 'actions',
      width: 120,
      render: (_: unknown, record: RouteRecord) => {
        if (!RENAMABLE_TYPES.has(record.type || '')) {
          return null;
        }
        return (
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleOpenRename(record)}
            disabled={!record.schemaUid}
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
        title={t('Rename Path')}
        open={renameModal.visible}
        onOk={handleSaveRename}
        onCancel={() => setRenameModal({ visible: false, record: null })}
        confirmLoading={saving}
        destroyOnClose
      >
        {renameModal.record && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <strong>{t('Route')}:</strong> {renameModal.record.title || <em>{t('Untitled')}</em>}
            </div>
            <div>
              <strong>{t('Current Path')}:</strong> <code>{renameModal.record.schemaUid || <em>{t('None')}</em>}</code>
            </div>
            <div>
              <strong>{t('New Path')}:</strong>
              <Input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="e.g. sales-dashboard"
                style={{ marginTop: 4 }}
                onPressEnter={() => {
                  handleSaveRename();
                }}
              />
              <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
                {t('Use lowercase letters, numbers, and hyphens. Example: my-page, sales-report')}
              </div>
            </div>
          </Space>
        )}
      </Modal>
    </div>
  );
}

export default RouterConfigManager;
