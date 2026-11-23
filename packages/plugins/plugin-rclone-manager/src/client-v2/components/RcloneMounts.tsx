// SPDX-License-Identifier: Apache-2.0

import { DisconnectOutlined, PlusOutlined } from '@ant-design/icons';
import { AutoComplete, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useState } from 'react';
import type { RcloneMountPoint, RcloneRemoteSummary } from '../../shared/types';
import { useRcloneApi } from '../api';
import { useRcloneSession } from '../hooks/useRcloneSession';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/format';
import { ConnectionHeader } from './ConnectionHeader';

export const RcloneMounts: React.FC = () => {
  const t = useT();
  const api = useRcloneApi();
  const { enabledConnections, selectedConnectionId, setSelectedConnectionId } = useRcloneSession();

  const [mounts, setMounts] = useState<RcloneMountPoint[]>([]);
  const [mountTypes, setMountTypes] = useState<string[]>([]);
  const [remotes, setRemotes] = useState<RcloneRemoteSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const loadMounts = useCallback(async () => {
    if (!selectedConnectionId) {
      setMounts([]);
      return;
    }
    setLoading(true);
    try {
      const [mountList, types, remoteList] = await Promise.all([
        api.listMounts(selectedConnectionId),
        api.listMountTypes(selectedConnectionId).catch(() => []),
        api.listRemotes(selectedConnectionId),
      ]);
      setMounts(mountList);
      setMountTypes(types);
      setRemotes(remoteList);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load FUSE mounts')));
    } finally {
      setLoading(false);
    }
  }, [api, selectedConnectionId, t]);

  useEffect(() => {
    loadMounts();
  }, [loadMounts]);

  const handleCreate = async () => {
    if (!selectedConnectionId) return;
    try {
      const vals = (await form.validateFields()) as {
        fs: string;
        mountPoint: string;
        mountType?: string;
        vfsCacheMode?: number;
      };
      setSubmitting(true);
      await api.createMount({
        connectionId: selectedConnectionId,
        fs: vals.fs,
        mountPoint: vals.mountPoint,
        mountType: vals.mountType || undefined,
        vfsOpt: vals.vfsCacheMode !== undefined ? { CacheMode: vals.vfsCacheMode } : undefined,
      });
      message.success(t('Mount created successfully'));
      setModalOpen(false);
      form.resetFields();
      await loadMounts();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err, t('Failed to mount remote')));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnmount = async (mountPoint: string) => {
    if (!selectedConnectionId) return;
    try {
      await api.unmount(selectedConnectionId, mountPoint);
      message.success(t('Unmounted successfully'));
      await loadMounts();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to unmount')));
    }
  };

  const handleUnmountAll = async () => {
    if (!selectedConnectionId) return;
    try {
      await api.unmountAll(selectedConnectionId);
      message.success(t('Unmounted all mount points'));
      await loadMounts();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to unmount all')));
    }
  };

  const columns: ColumnsType<RcloneMountPoint> = [
    { title: t('Remote Fs'), dataIndex: 'Fs', key: 'Fs' },
    { title: t('Host Mount Point'), dataIndex: 'MountPoint', key: 'MountPoint' },
    {
      title: t('Type'),
      dataIndex: 'FsType',
      key: 'FsType',
      render: (val?: string) => <Tag>{val || 'mount'}</Tag>,
    },
    { title: t('Mounted At'), dataIndex: 'MountedOn', key: 'MountedOn' },
    {
      title: t('Actions'),
      key: 'actions',
      width: 140,
      render: (_v: unknown, row: RcloneMountPoint) => (
        <Popconfirm title={t('Unmount this path?')} onConfirm={() => handleUnmount(row.MountPoint)}>
          <Button size="small" danger icon={<DisconnectOutlined />}>
            {t('Unmount')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div role="region" aria-label={t('Rclone Mounts')}>
      <ConnectionHeader
        title={t('Mounts (FUSE)')}
        connections={enabledConnections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        onRefresh={loadMounts}
        loading={loading}
        extra={
          selectedConnectionId ? (
            <Space>
              {mounts.length > 0 && (
                <Popconfirm title={t('Unmount all active mounts?')} onConfirm={handleUnmountAll}>
                  <Button danger>{t('Unmount All')}</Button>
                </Popconfirm>
              )}
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
                {t('New Mount')}
              </Button>
            </Space>
          ) : null
        }
      />

      <Card size="small">
        <Table
          rowKey="MountPoint"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={mounts}
          pagination={false}
        />
      </Card>

      <Modal
        title={t('Create FUSE Mount')}
        open={modalOpen}
        onOk={handleCreate}
        confirmLoading={submitting}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ vfsCacheMode: 2 }}>
          <Form.Item name="fs" label={t('Remote Target (e.g. s3-backup:bucket)')} rules={[{ required: true }]}>
            <AutoComplete
              allowClear
              popupMatchSelectWidth
              placeholder="remote:path"
              options={remotes.map((r) => ({ value: `${r.name}:`, label: `${r.name}: (${r.type})` }))}
              filterOption={(input, opt) =>
                String(opt?.label ?? opt?.value ?? '')
                  .toLowerCase()
                  .includes(input.trim().toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item
            name="mountPoint"
            label={t('Host Mount Directory')}
            rules={[{ required: true, message: t('Mount directory path is required') }]}
          >
            <Input placeholder="/mnt/rclone-cloud" />
          </Form.Item>
          {mountTypes.length > 0 && (
            <Form.Item name="mountType" label={t('Mount Driver')}>
              <Select allowClear options={mountTypes.map((m) => ({ value: m, label: m }))} />
            </Form.Item>
          )}
          <Form.Item name="vfsCacheMode" label={t('VFS Cache Mode')}>
            <Select
              options={[
                { value: 0, label: t('off (0) — Direct read/write only') },
                { value: 1, label: t('minimal (1)') },
                { value: 2, label: t('writes (2) — Recommended for general write support') },
                { value: 3, label: t('full (3) — Full read/write disk cache') },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default RcloneMounts;
