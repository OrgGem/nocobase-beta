// SPDX-License-Identifier: Apache-2.0

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import type { BatchSyncItemResult, HaproxySslCertificate, HaproxyStorageFile } from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useHaproxySession } from '../hooks/useHaproxySession';
import { useT } from '../locale';
import { formatBytes, getErrorMessage } from '../utils/format';
import { NodeToolbar } from './NodeToolbar';

function renderExpiryTag(notAfter?: string) {
  if (!notAfter) return '—';
  const expMs = new Date(notAfter).getTime();
  if (!Number.isFinite(expMs)) return notAfter;
  const daysLeft = Math.floor((expMs - Date.now()) / 86400000);
  const formatted = new Date(expMs).toLocaleDateString();
  if (daysLeft < 0) {
    return (
      <Tag icon={<CloseCircleOutlined aria-hidden="true" />} color="error">
        {formatted} (expired)
      </Tag>
    );
  }
  if (daysLeft <= 30) {
    return (
      <Tag icon={<WarningOutlined aria-hidden="true" />} color="warning">
        {formatted} ({daysLeft}d)
      </Tag>
    );
  }
  return (
    <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
      {formatted} ({daysLeft}d)
    </Tag>
  );
}

export const HaproxyStorageView: React.FC<{ fixedConnectionId?: number }> = ({ fixedConnectionId }) => {
  const t = useT();
  const api = useHaproxyApi();
  const { permissions, connections, selectedConnectionId, setSelectedConnectionId, bootstrapping } =
    useHaproxySession(fixedConnectionId);

  const canStorage = Boolean(permissions?.canStorage);

  const [loading, setLoading] = useState(false);
  const [certs, setCerts] = useState<HaproxySslCertificate[]>([]);
  const [maps, setMaps] = useState<HaproxyStorageFile[]>([]);
  const [generalFiles, setGeneralFiles] = useState<HaproxyStorageFile[]>([]);

  // SSL Modal (single or multi-node)
  const [sslModalMode, setSslModalMode] = useState<'create' | 'replace' | 'sync' | null>(null);
  const [sslSaving, setSslSaving] = useState(false);
  const [syncResults, setSyncResults] = useState<BatchSyncItemResult[] | null>(null);
  const [sslForm] = Form.useForm<{
    fileName: string;
    pemContent: string;
    forceReload: boolean;
    skipReload: boolean;
    targetConnectionIds?: number[];
  }>();

  // Map / General file editor modal
  const [fileModal, setFileModal] = useState<{
    kind: 'map' | 'general';
    mode: 'create' | 'edit';
    storageName?: string;
  } | null>(null);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileForm] = Form.useForm<{ fileName: string; content: string; forceReload: boolean }>();

  const loadStorage = useCallback(async () => {
    if (!selectedConnectionId) return;
    setLoading(true);
    try {
      const [cList, mList, gList] = await Promise.all([
        api.listSslCertificates(selectedConnectionId).catch(() => []),
        api.listStorageMaps(selectedConnectionId).catch(() => []),
        api.listStorageGeneralFiles(selectedConnectionId).catch(() => []),
      ]);
      setCerts(cList);
      setMaps(mList);
      setGeneralFiles(gList);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, selectedConnectionId]);

  useEffect(() => {
    loadStorage();
  }, [loadStorage]);

  const handleSaveSsl = useCallback(async () => {
    if (!selectedConnectionId || !sslModalMode) return;
    try {
      const values = await sslForm.validateFields();
      setSslSaving(true);
      const opts = { forceReload: values.forceReload, skipReload: values.skipReload };
      if (sslModalMode === 'sync' && values.targetConnectionIds) {
        const res = await api.syncSslCertificateBatch(
          values.targetConnectionIds,
          values.fileName,
          values.pemContent,
          opts,
        );
        setSyncResults(res.results);
      } else if (sslModalMode === 'replace') {
        await api.replaceSslCertificate(selectedConnectionId, values.fileName, values.pemContent, opts);
        message.success(t('Saved successfully'));
      } else {
        await api.uploadSslCertificate(selectedConnectionId, values.fileName, values.pemContent, opts);
        message.success(t('Saved successfully'));
      }
      setSslModalMode(null);
      await loadStorage();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    } finally {
      setSslSaving(false);
    }
  }, [api, loadStorage, selectedConnectionId, sslForm, sslModalMode, t]);

  const handleDeleteSsl = useCallback(
    async (storageName: string) => {
      if (!selectedConnectionId) return;
      try {
        await api.deleteSslCertificate(selectedConnectionId, storageName, { forceReload: false });
        message.success(t('Deleted successfully'));
        await loadStorage();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, loadStorage, selectedConnectionId, t],
  );

  const openEditStorageFile = useCallback(
    async (kind: 'map' | 'general', storageName: string) => {
      if (!selectedConnectionId) return;
      try {
        const res =
          kind === 'map'
            ? await api.getStorageMapContent(selectedConnectionId, storageName)
            : await api.getStorageGeneralFileContent(selectedConnectionId, storageName);
        fileForm.setFieldsValue({
          fileName: storageName,
          content: res.content,
          forceReload: false,
        });
        setFileModal({ kind, mode: 'edit', storageName });
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, fileForm, selectedConnectionId],
  );

  const handleSaveStorageFile = useCallback(async () => {
    if (!selectedConnectionId || !fileModal) return;
    try {
      const values = await fileForm.validateFields();
      setFileSaving(true);
      if (fileModal.kind === 'map') {
        if (fileModal.mode === 'edit') {
          await api.replaceStorageMap(selectedConnectionId, values.fileName, values.content, {
            forceReload: values.forceReload,
          });
        } else {
          await api.createStorageMap(selectedConnectionId, values.fileName, values.content);
        }
      } else if (fileModal.mode === 'edit') {
        await api.replaceStorageGeneralFile(selectedConnectionId, values.fileName, values.content, {
          forceReload: values.forceReload,
        });
      } else {
        await api.createStorageGeneralFile(selectedConnectionId, values.fileName, values.content);
      }
      message.success(t('Saved successfully'));
      setFileModal(null);
      await loadStorage();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    } finally {
      setFileSaving(false);
    }
  }, [api, fileForm, fileModal, loadStorage, selectedConnectionId, t]);

  const handleDeleteStorageFile = useCallback(
    async (kind: 'map' | 'general', storageName: string) => {
      if (!selectedConnectionId) return;
      try {
        if (kind === 'map') {
          await api.deleteStorageMap(selectedConnectionId, storageName);
        } else {
          await api.deleteStorageGeneralFile(selectedConnectionId, storageName);
        }
        message.success(t('Deleted successfully'));
        await loadStorage();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, loadStorage, selectedConnectionId, t],
  );

  if (!bootstrapping && connections.length === 0) {
    return (
      <Card>
        <Empty description={t('No enabled HAProxy Data Plane connections')} />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <NodeToolbar
        connections={connections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        fixedConnectionId={fixedConnectionId}
        loading={loading}
        onRefresh={loadStorage}
      />

      {syncResults && (
        <Card
          size="small"
          title={t('Multi-Server Sync Results')}
          extra={
            <Button htmlType="button" size="small" onClick={() => setSyncResults(null)}>
              {t('Cancel')}
            </Button>
          }
        >
          <Table<BatchSyncItemResult>
            rowKey="connectionId"
            size="small"
            dataSource={syncResults}
            pagination={false}
            columns={[
              { title: t('Node'), dataIndex: 'connectionName', key: 'connectionName' },
              {
                title: t('Status'),
                key: 'ok',
                render: (_v: unknown, r: BatchSyncItemResult) =>
                  r.ok ? <Tag color="success">OK</Tag> : <Tag color="error">{r.error}</Tag>,
              },
              { title: t('Reload ID'), dataIndex: 'reloadId', key: 'reloadId' },
            ]}
          />
        </Card>
      )}

      <Card size="small">
        <Tabs
          items={[
            {
              key: 'ssl',
              label: `${t('SSL Certificates')} (${certs.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {canStorage && (
                    <Space wrap>
                      <Button
                        htmlType="button"
                        type="primary"
                        icon={<PlusOutlined aria-hidden="true" />}
                        onClick={() => {
                          sslForm.resetFields();
                          sslForm.setFieldsValue({ forceReload: false, skipReload: false });
                          setSslModalMode('create');
                        }}
                      >
                        {t('Upload SSL Certificate (.pem)')}
                      </Button>
                      {connections.length > 1 && (
                        <Button
                          htmlType="button"
                          icon={<SyncOutlined aria-hidden="true" />}
                          onClick={() => {
                            sslForm.resetFields();
                            sslForm.setFieldsValue({
                              targetConnectionIds: connections.map((c) => c.id),
                              forceReload: true,
                              skipReload: false,
                            });
                            setSslModalMode('sync');
                          }}
                        >
                          {t('Sync Certificate to Multiple Nodes')}
                        </Button>
                      )}
                    </Space>
                  )}
                  <Table<HaproxySslCertificate>
                    rowKey="storage_name"
                    size="small"
                    loading={loading}
                    dataSource={certs}
                    pagination={{ pageSize: 15, hideOnSinglePage: true }}
                    columns={[
                      {
                        title: t('File Name'),
                        dataIndex: 'storage_name',
                        key: 'storage_name',
                        render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
                      },
                      { title: t('Subject'), dataIndex: 'subject', key: 'subject' },
                      {
                        title: t('Domains / SANs'),
                        key: 'domains',
                        render: (_v: unknown, r: HaproxySslCertificate) =>
                          r.domains || r.subject_alternative_names || '—',
                      },
                      {
                        title: t('Expires (Not After)'),
                        dataIndex: 'not_after',
                        key: 'not_after',
                        render: (val?: string) => renderExpiryTag(val),
                      },
                      ...(canStorage
                        ? [
                            {
                              title: t('Actions'),
                              key: 'actions',
                              render: (_v: unknown, r: HaproxySslCertificate) => (
                                <Space size={6}>
                                  <Button
                                    htmlType="button"
                                    size="small"
                                    icon={<EditOutlined aria-hidden="true" />}
                                    aria-label={`${t('Replace SSL Certificate')} ${r.storage_name}`}
                                    onClick={() => {
                                      sslForm.resetFields();
                                      sslForm.setFieldsValue({
                                        fileName: r.storage_name,
                                        forceReload: false,
                                        skipReload: false,
                                      });
                                      setSslModalMode('replace');
                                    }}
                                  >
                                    {t('Replace SSL Certificate')}
                                  </Button>
                                  <Popconfirm
                                    title={t('Delete {{name}} from disk?', { name: r.storage_name })}
                                    onConfirm={() => handleDeleteSsl(r.storage_name)}
                                  >
                                    <Button
                                      htmlType="button"
                                      size="small"
                                      danger
                                      icon={<DeleteOutlined aria-hidden="true" />}
                                      aria-label={`${t('Delete')} ${r.storage_name}`}
                                    >
                                      {t('Delete')}
                                    </Button>
                                  </Popconfirm>
                                </Space>
                              ),
                            },
                          ]
                        : []),
                    ]}
                  />
                </Space>
              ),
            },
            {
              key: 'maps',
              label: `${t('Managed Map Files')} (${maps.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {canStorage && (
                    <Button
                      htmlType="button"
                      type="primary"
                      icon={<PlusOutlined aria-hidden="true" />}
                      onClick={() => {
                        fileForm.resetFields();
                        fileForm.setFieldsValue({ forceReload: false });
                        setFileModal({ kind: 'map', mode: 'create' });
                      }}
                    >
                      {t('Upload File')}
                    </Button>
                  )}
                  <Table<HaproxyStorageFile>
                    rowKey="storage_name"
                    size="small"
                    loading={loading}
                    dataSource={maps}
                    pagination={{ pageSize: 15, hideOnSinglePage: true }}
                    columns={[
                      { title: t('File Name'), dataIndex: 'storage_name', key: 'storage_name' },
                      {
                        title: t('Size'),
                        dataIndex: 'size',
                        key: 'size',
                        render: (sz?: number | null) => formatBytes(sz),
                      },
                      {
                        title: t('Actions'),
                        key: 'actions',
                        render: (_v: unknown, r: HaproxyStorageFile) => (
                          <Space size={6}>
                            <Button
                              htmlType="button"
                              size="small"
                              icon={<EditOutlined aria-hidden="true" />}
                              aria-label={`${t('Edit Content')} ${r.storage_name}`}
                              onClick={() => openEditStorageFile('map', r.storage_name)}
                            >
                              {t('Edit Content')}
                            </Button>
                            {canStorage && (
                              <Popconfirm
                                title={t('Delete {{name}} from disk?', { name: r.storage_name })}
                                onConfirm={() => handleDeleteStorageFile('map', r.storage_name)}
                              >
                                <Button
                                  htmlType="button"
                                  size="small"
                                  danger
                                  icon={<DeleteOutlined aria-hidden="true" />}
                                  aria-label={`${t('Delete')} ${r.storage_name}`}
                                >
                                  {t('Delete')}
                                </Button>
                              </Popconfirm>
                            )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Space>
              ),
            },
            {
              key: 'general',
              label: `${t('General Files (Error pages / Lua)')} (${generalFiles.length})`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {canStorage && (
                    <Button
                      htmlType="button"
                      type="primary"
                      icon={<PlusOutlined aria-hidden="true" />}
                      onClick={() => {
                        fileForm.resetFields();
                        fileForm.setFieldsValue({ forceReload: false });
                        setFileModal({ kind: 'general', mode: 'create' });
                      }}
                    >
                      {t('Upload File')}
                    </Button>
                  )}
                  <Table<HaproxyStorageFile>
                    rowKey="storage_name"
                    size="small"
                    loading={loading}
                    dataSource={generalFiles}
                    pagination={{ pageSize: 15, hideOnSinglePage: true }}
                    columns={[
                      { title: t('File Name'), dataIndex: 'storage_name', key: 'storage_name' },
                      {
                        title: t('Size'),
                        dataIndex: 'size',
                        key: 'size',
                        render: (sz?: number | null) => formatBytes(sz),
                      },
                      {
                        title: t('Actions'),
                        key: 'actions',
                        render: (_v: unknown, r: HaproxyStorageFile) => (
                          <Space size={6}>
                            <Button
                              htmlType="button"
                              size="small"
                              icon={<EditOutlined aria-hidden="true" />}
                              aria-label={`${t('Edit Content')} ${r.storage_name}`}
                              onClick={() => openEditStorageFile('general', r.storage_name)}
                            >
                              {t('Edit Content')}
                            </Button>
                            {canStorage && (
                              <Popconfirm
                                title={t('Delete {{name}} from disk?', { name: r.storage_name })}
                                onConfirm={() => handleDeleteStorageFile('general', r.storage_name)}
                              >
                                <Button
                                  htmlType="button"
                                  size="small"
                                  danger
                                  icon={<DeleteOutlined aria-hidden="true" />}
                                  aria-label={`${t('Delete')} ${r.storage_name}`}
                                >
                                  {t('Delete')}
                                </Button>
                              </Popconfirm>
                            )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* SSL Upload / Replace / Multi-Node Sync Modal */}
      <Modal
        open={Boolean(sslModalMode)}
        title={
          sslModalMode === 'sync'
            ? t('Sync Certificate to Multiple Nodes')
            : sslModalMode === 'replace'
              ? t('Replace SSL Certificate')
              : t('Upload SSL Certificate (.pem)')
        }
        width={640}
        okText={t('Save')}
        cancelText={t('Cancel')}
        confirmLoading={sslSaving}
        onOk={handleSaveSsl}
        onCancel={() => setSslModalMode(null)}
        destroyOnClose
      >
        <Form form={sslForm} layout="vertical">
          {sslModalMode === 'sync' && (
            <Form.Item name="targetConnectionIds" label={t('Target HAProxy Nodes')} rules={[{ required: true }]}>
              <Select
                mode="multiple"
                options={connections.map((c) => ({
                  value: c.id,
                  label: c.title ? `${c.title} (${c.name})` : c.name,
                }))}
              />
            </Form.Item>
          )}
          <Form.Item name="fileName" label={t('File Name (e.g. site.pem)')} rules={[{ required: true }]}>
            <Input
              disabled={sslModalMode === 'replace'}
              placeholder="site.pem"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Form.Item>
          <Form.Item
            name="pemContent"
            label={t('PEM Bundle (Certificate + Private Key + Chain)')}
            rules={[{ required: true }]}
          >
            <Input.TextArea
              rows={10}
              placeholder="-----BEGIN CERTIFICATE-----..."
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}
            />
          </Form.Item>
          <Form.Item name="skipReload" label={t('Skip HAProxy reload')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="forceReload" label={t('Force immediate reload (skip reload-delay)')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* Map / General File Modal */}
      <Modal
        open={Boolean(fileModal)}
        title={fileModal?.mode === 'edit' ? `${t('Edit Content')}: ${fileModal.storageName}` : t('Upload File')}
        width={640}
        okText={canStorage ? t('Save') : t('Cancel')}
        cancelText={t('Cancel')}
        confirmLoading={fileSaving}
        onOk={canStorage ? handleSaveStorageFile : () => setFileModal(null)}
        onCancel={() => setFileModal(null)}
        destroyOnClose
      >
        <Form form={fileForm} layout="vertical">
          <Form.Item name="fileName" label={t('File Name')} rules={[{ required: true }]}>
            <Input
              disabled={fileModal?.mode === 'edit'}
              placeholder={fileModal?.kind === 'map' ? 'routes.map' : '503.http'}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Form.Item>
          <Form.Item name="content" label={t('Content')} rules={[{ required: true }]}>
            <Input.TextArea
              rows={12}
              readOnly={!canStorage}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}
            />
          </Form.Item>
          {fileModal?.mode === 'edit' && canStorage && (
            <Form.Item
              name="forceReload"
              label={t('Force immediate reload (skip reload-delay)')}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Space>
  );
};

export default HaproxyStorageView;
