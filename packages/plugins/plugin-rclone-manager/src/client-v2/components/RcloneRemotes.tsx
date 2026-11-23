// SPDX-License-Identifier: Apache-2.0

import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { RcloneProviderInfo, RcloneProviderOption, RcloneRemoteSummary } from '../../shared/types';
import { useRcloneApi } from '../api';
import { useRcloneSession } from '../hooks/useRcloneSession';
import { useT } from '../locale';
import { coerceRemoteParamsForForm, getErrorMessage } from '../utils/format';
import { ConnectionHeader } from './ConnectionHeader';
import { OptionFieldInput } from './OptionFieldInput';

const OAUTH_PROVIDERS = new Set(['drive', 'onedrive', 'dropbox', 'box', 'yandex', 'pcloud', 'zoho']);

function filterProviderOptions(options: RcloneProviderOption[], selectedType?: string, subProvider?: string) {
  return options.filter((opt) => {
    if (!opt.Provider) {
      return true;
    }
    if (subProvider && opt.Provider.includes(subProvider) && !opt.Provider.startsWith('!')) {
      return true;
    }
    if (selectedType === 's3' && subProvider === 'Other' && opt.Provider.includes('!')) {
      return true;
    }
    return false;
  });
}

export const RcloneRemotes: React.FC = () => {
  const t = useT();
  const api = useRcloneApi();
  const { enabledConnections, selectedConnectionId, setSelectedConnectionId, permissions } = useRcloneSession();

  const [remotes, setRemotes] = useState<RcloneRemoteSummary[]>([]);
  const [providers, setProviders] = useState<RcloneProviderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const watchedType = Form.useWatch('type', form) as string | undefined;
  const watchedSubProvider = Form.useWatch(['parameters', 'provider'], form) as string | undefined;

  const loadData = useCallback(async () => {
    if (!selectedConnectionId) {
      setRemotes([]);
      return;
    }
    setLoading(true);
    try {
      const [remoteList, providerList] = await Promise.all([
        api.listRemotes(selectedConnectionId),
        api.listProviders(selectedConnectionId),
      ]);
      setRemotes(remoteList);
      setProviders(providerList);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load remotes')));
    } finally {
      setLoading(false);
    }
  }, [api, selectedConnectionId, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const activeProvider = useMemo(
    () => providers.find((item) => item.Name === watchedType) ?? null,
    [providers, watchedType],
  );

  const filteredOptions = useMemo(
    () => filterProviderOptions(activeProvider?.Options ?? [], watchedType, watchedSubProvider),
    [activeProvider, watchedSubProvider, watchedType],
  );

  const normalOptions = useMemo(() => filteredOptions.filter((o) => !o.Advanced), [filteredOptions]);
  const advancedOptions = useMemo(() => filteredOptions.filter((o) => o.Advanced), [filteredOptions]);

  const providerOptions = useMemo(
    () =>
      providers.map((p) => {
        const desc = (p.Description ?? '').trim();
        const shortDesc = desc.length > 72 ? `${desc.slice(0, 72)}…` : desc;
        return {
          value: p.Name,
          label: shortDesc ? `${p.Name} — ${shortDesc}` : p.Name,
          title: desc ? `${p.Name} — ${desc}` : p.Name,
          searchText: `${p.Name} ${desc}`.toLowerCase(),
        };
      }),
    [providers],
  );

  const openCreateDrawer = () => {
    setEditingName(null);
    form.resetFields();
    setDrawerOpen(true);
  };

  const openEditDrawer = async (record: RcloneRemoteSummary) => {
    if (!selectedConnectionId) return;
    setEditingName(record.name);
    form.resetFields();
    setDrawerOpen(true);
    try {
      const cfg = await api.getRemoteConfig(selectedConnectionId, record.name);
      const { type, ...rest } = cfg;
      const resolvedType = String(type ?? record.type);
      const matchedProvider = providers.find((item) => item.Name === resolvedType);
      form.setFieldsValue({
        name: record.name,
        type: resolvedType,
        parameters: coerceRemoteParamsForForm(rest, matchedProvider?.Options),
      });
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to fetch remote configuration')));
      setDrawerOpen(false);
    }
  };

  const handleSave = async () => {
    if (!selectedConnectionId) return;
    try {
      const values = (await form.validateFields()) as {
        name: string;
        type: string;
        parameters?: Record<string, unknown>;
      };
      setSaving(true);
      const cleanedParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values.parameters ?? {})) {
        if (v !== undefined) {
          cleanedParams[k] = v;
        } else if (editingName) {
          // Pass null for cleared mounted inputs (such as AutoComplete allowClear) so updateRemote clears existing keys.
          cleanedParams[k] = null;
        }
      }

      if (editingName) {
        await api.updateRemote(selectedConnectionId, editingName, cleanedParams);
        message.success(t('Remote updated successfully'));
      } else {
        await api.createRemote(selectedConnectionId, values.name, values.type, cleanedParams);
        message.success(t('Remote created successfully'));
      }
      setDrawerOpen(false);
      await loadData();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        return;
      }
      message.error(getErrorMessage(err, t('Failed to save remote')));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!selectedConnectionId) return;
    try {
      await api.deleteRemote(selectedConnectionId, name);
      message.success(t('Remote deleted'));
      await loadData();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete remote')));
    }
  };

  const visibleRemotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return remotes;
    return remotes.filter((r) => r.name.toLowerCase().includes(q) || r.type.toLowerCase().includes(q));
  }, [remotes, search]);

  const columns: ColumnsType<RcloneRemoteSummary> = [
    {
      title: t('Name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Typography.Text strong>{name}:</Typography.Text>,
    },
    {
      title: t('Provider Type'),
      dataIndex: 'type',
      key: 'type',
      render: (type: string, record: RcloneRemoteSummary) => (
        <Space size={4}>
          <Tag color="geekblue">{type}</Tag>
          {record.envDefined && <Tag color="gold">ENV</Tag>}
        </Space>
      ),
    },
    ...(permissions.canManageRemotes
      ? [
          {
            title: t('Actions'),
            key: 'actions',
            width: 180,
            render: (_v: unknown, record: RcloneRemoteSummary) =>
              record.envDefined ? (
                <Typography.Text type="secondary">{t('Env-defined')}</Typography.Text>
              ) : (
                <Space>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openEditDrawer(record)}
                    aria-label={`${t('Edit')} ${record.name}`}
                  >
                    {t('Edit')}
                  </Button>
                  <Popconfirm title={t('Delete this remote?')} onConfirm={() => handleDelete(record.name)}>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`${t('Delete')} ${record.name}`}
                    />
                  </Popconfirm>
                </Space>
              ),
          },
        ]
      : []),
  ];

  const copyAuthorizeCommand = async (backend: string) => {
    try {
      await navigator.clipboard.writeText(`rclone authorize "${backend}"`);
      message.success(t('Copied command to clipboard'));
    } catch {
      message.info(`rclone authorize "${backend}"`);
    }
  };

  return (
    <div role="region" aria-label={t('Rclone Remotes')}>
      <ConnectionHeader
        title={t('Remotes')}
        connections={enabledConnections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        onRefresh={loadData}
        loading={loading}
        extra={
          permissions.canManageRemotes && selectedConnectionId ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateDrawer}>
              {t('New Remote')}
            </Button>
          ) : null
        }
      />

      <Card size="small">
        <Input.Search
          allowClear
          placeholder={t('Filter remotes by name or provider...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 340, marginBottom: 12 }}
        />
        <Table
          rowKey="name"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={visibleRemotes}
          pagination={{ pageSize: 15, hideOnSinglePage: true }}
        />
      </Card>

      <Drawer
        title={editingName ? `${t('Edit Remote')}: ${editingName}` : t('Create Cloud Remote')}
        width={620}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>{t('Cancel')}</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>
              {t('Save')}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t('Remote Name')}
            rules={[
              { required: true, message: t('Remote name is required') },
              {
                pattern: /^[a-zA-Z0-9._-]{1,64}$/,
                message: t('Use letters, numbers, dots, hyphens, or underscores'),
              },
            ]}
          >
            <Input disabled={Boolean(editingName)} placeholder="e.g. s3-backup" />
          </Form.Item>

          <Form.Item
            name="type"
            label={t('Storage Provider')}
            rules={[{ required: true, message: t('Storage provider is required') }]}
          >
            <Select
              showSearch
              popupMatchSelectWidth
              listHeight={320}
              style={{ width: '100%' }}
              disabled={Boolean(editingName)}
              placeholder={t('Select storage backend...')}
              options={providerOptions}
              filterOption={(input, option) => String(option?.searchText ?? '').includes(input.trim().toLowerCase())}
            />
          </Form.Item>

          {watchedType && OAUTH_PROVIDERS.has(watchedType) && (
            <Alert
              style={{ marginBottom: 16 }}
              type="info"
              showIcon
              message={t('Headless / Docker OAuth Token Tip')}
              description={
                <Space direction="vertical" size={4}>
                  <Typography.Text>
                    {t(
                      'For remote rclone rcd servers without a local browser, generate a token JSON on your workstation and paste it into the "token" field (in Advanced Options if hidden):',
                    )}
                  </Typography.Text>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copyAuthorizeCommand(watchedType)}>
                    {`rclone authorize "${watchedType}"`}
                  </Button>
                </Space>
              }
            />
          )}

          {normalOptions.map((opt) => (
            <OptionFieldInput key={opt.Name} option={opt} />
          ))}

          {advancedOptions.length > 0 && (
            <Collapse
              size="small"
              items={[
                {
                  key: 'advanced',
                  label: `${t('Advanced Options')} (${advancedOptions.length})`,
                  children: advancedOptions.map((opt) => <OptionFieldInput key={opt.Name} option={opt} />),
                },
              ]}
            />
          )}
        </Form>
      </Drawer>
    </div>
  );
};

export default RcloneRemotes;
