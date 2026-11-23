// SPDX-License-Identifier: Apache-2.0

import { PlusOutlined, PoweroffOutlined } from '@ant-design/icons';
import {
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useState } from 'react';
import type { RcloneRemoteSummary, RcloneServeItem } from '../../shared/types';
import { useRcloneApi } from '../api';
import { useRcloneSession } from '../hooks/useRcloneSession';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/format';
import { ConnectionHeader } from './ConnectionHeader';

const FALLBACK_SERVE_TYPES = ['http', 'webdav', 'sftp', 'ftp', 'dlna', 's3'];

export const RcloneServes: React.FC = () => {
  const t = useT();
  const api = useRcloneApi();
  const { enabledConnections, selectedConnectionId, setSelectedConnectionId } = useRcloneSession();

  const [serves, setServes] = useState<RcloneServeItem[]>([]);
  const [serveTypes, setServeTypes] = useState<string[]>(FALLBACK_SERVE_TYPES);
  const [remotes, setRemotes] = useState<RcloneRemoteSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const loadServes = useCallback(async () => {
    if (!selectedConnectionId) {
      setServes([]);
      return;
    }
    setLoading(true);
    try {
      const [serveList, types, remoteList] = await Promise.all([
        api.listServes(selectedConnectionId),
        api.listServeTypes(selectedConnectionId).catch(() => FALLBACK_SERVE_TYPES),
        api.listRemotes(selectedConnectionId),
      ]);
      setServes(serveList);
      if (types.length > 0) setServeTypes(types);
      setRemotes(remoteList);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load active serves')));
    } finally {
      setLoading(false);
    }
  }, [api, selectedConnectionId, t]);

  useEffect(() => {
    loadServes();
  }, [loadServes]);

  const handleStart = async () => {
    if (!selectedConnectionId) return;
    try {
      const vals = (await form.validateFields()) as {
        type: string;
        fs: string;
        addr?: string;
        user?: string;
        pass?: string;
        readOnly?: boolean;
      };
      setSubmitting(true);
      await api.startServe({
        connectionId: selectedConnectionId,
        ...vals,
      });
      message.success(t('Serve endpoint started'));
      setModalOpen(false);
      form.resetFields();
      await loadServes();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err, t('Failed to start serve endpoint')));
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async (id: string) => {
    if (!selectedConnectionId) return;
    try {
      await api.stopServe(selectedConnectionId, id);
      message.success(t('Serve endpoint stopped'));
      await loadServes();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to stop serve endpoint')));
    }
  };

  const handleStopAll = async () => {
    if (!selectedConnectionId) return;
    try {
      await api.stopAllServes(selectedConnectionId);
      message.success(t('Stopped all serve endpoints'));
      await loadServes();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to stop all serves')));
    }
  };

  const columns: ColumnsType<RcloneServeItem> = [
    { title: t('ID'), dataIndex: 'id', key: 'id' },
    {
      title: t('Protocol'),
      key: 'type',
      render: (_v: unknown, row: RcloneServeItem) => (
        <Tag color="cyan">{String(row.params?.type ?? 'serve').toUpperCase()}</Tag>
      ),
    },
    {
      title: t('Remote Fs'),
      key: 'fs',
      render: (_v: unknown, row: RcloneServeItem) => String(row.params?.fs ?? '—'),
    },
    { title: t('Listen Address'), dataIndex: 'addr', key: 'addr' },
    {
      title: t('Actions'),
      key: 'actions',
      width: 120,
      render: (_v: unknown, row: RcloneServeItem) => (
        <Popconfirm title={t('Stop this serve endpoint?')} onConfirm={() => handleStop(row.id)}>
          <Button size="small" danger icon={<PoweroffOutlined />}>
            {t('Stop')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div role="region" aria-label={t('Rclone Serves')}>
      <ConnectionHeader
        title={t('Serves (HTTP / WebDAV / SFTP / FTP / S3)')}
        connections={enabledConnections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        onRefresh={loadServes}
        loading={loading}
        extra={
          selectedConnectionId ? (
            <Space>
              {serves.length > 0 && (
                <Popconfirm title={t('Stop all running serve endpoints?')} onConfirm={handleStopAll}>
                  <Button danger>{t('Stop All')}</Button>
                </Popconfirm>
              )}
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
                {t('Start Serve')}
              </Button>
            </Space>
          ) : null
        }
      />

      <Card size="small">
        <Table rowKey="id" size="small" loading={loading} columns={columns} dataSource={serves} pagination={false} />
      </Card>

      <Modal
        title={t('Start Protocol Serve Endpoint')}
        open={modalOpen}
        onOk={handleStart}
        confirmLoading={submitting}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ type: 'http', addr: '0.0.0.0:8080', readOnly: true }}>
          <Form.Item name="type" label={t('Protocol')} rules={[{ required: true }]}>
            <Select options={serveTypes.map((st) => ({ value: st, label: st.toUpperCase() }))} />
          </Form.Item>
          <Form.Item name="fs" label={t('Remote Fs')} rules={[{ required: true }]}>
            <AutoComplete
              allowClear
              popupMatchSelectWidth
              placeholder={t('Select remote or enter remote:bucket/path...')}
              options={remotes.map((r) => ({ value: `${r.name}:`, label: `${r.name}: (${r.type})` }))}
              filterOption={(input, opt) =>
                String(opt?.label ?? opt?.value ?? '')
                  .toLowerCase()
                  .includes(input.trim().toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item name="addr" label={t('Bind Address (host:port)')}>
            <Input placeholder="0.0.0.0:8080" />
          </Form.Item>
          <Form.Item name="user" label={t('Auth Username (optional)')}>
            <Input />
          </Form.Item>
          <Form.Item name="pass" label={t('Auth Password (optional)')}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="readOnly" valuePropName="checked">
            <Checkbox>{t('Read-only mode')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default RcloneServes;
