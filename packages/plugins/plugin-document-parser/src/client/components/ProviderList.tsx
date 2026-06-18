/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState } from 'react';
import { Button, Table, Tag, Space, Popconfirm, Modal, message, Tooltip, Badge } from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { ProviderForm, ProviderFormValues } from './ProviderForm';
import { useDocParserTranslation } from '../locale';

type Provider = ProviderFormValues & { id: number };

export const ProviderList: React.FC = () => {
  const { t } = useDocParserTranslation();
  const api = useApp().apiClient;
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'docParserProviders:list', params: { pageSize: 200 } });
      setProviders(res?.data?.data ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (record: Provider) => {
    setEditing(record);
    setModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    await api.request({ url: `docParserProviders:destroy`, method: 'DELETE', params: { filterByTk: id } });
    message.success(t('Provider deleted'));
    load();
  };

  const handleSubmit = async (values: ProviderFormValues) => {
    setSubmitting(true);
    try {
      if (editing) {
        await api.request({
          url: 'docParserProviders:update',
          method: 'POST',
          params: { filterByTk: editing.id },
          data: values,
        });
      } else {
        await api.request({ url: 'docParserProviders:create', method: 'POST', data: values });
      }
      message.success(t('Provider saved'));
      setModalOpen(false);
      load();
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async (record: Provider) => {
    setTestingId(record.id);
    try {
      const res = await api.request({
        url: 'docParserProviders:testConnection',
        params: { filterByTk: record.id },
      });
      const result = res?.data?.data;
      if (result?.ok) {
        message.success(`${t('Connection successful')}${result.status ? ` (HTTP ${result.status})` : ''}`);
      } else {
        message.error(`${t('Connection failed')}: ${result?.message ?? 'Unknown error'}`);
      }
    } catch (err: any) {
      message.error(`${t('Connection failed')}: ${err?.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const columns = [
    {
      title: t('Provider Title'),
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record: Provider) => (
        <Space>
          <Badge status={record.enabled ? 'success' : 'default'} />
          {title}
        </Space>
      ),
    },
    {
      title: t('API Endpoint'),
      dataIndex: 'apiEndpoint',
      key: 'apiEndpoint',
      ellipsis: true,
    },
    {
      title: t('Auth Type'),
      dataIndex: 'authType',
      key: 'authType',
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: t('Request Format'),
      dataIndex: 'requestFormat',
      key: 'requestFormat',
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      render: (v: boolean) =>
        v ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : <CloseCircleOutlined style={{ color: '#ccc' }} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, record: Provider) => (
        <Space>
          <Tooltip title={t('Test Connection')}>
            <Button
              size="small"
              icon={<ApiOutlined />}
              loading={testingId === record.id}
              onClick={() => handleTest(record)}
            />
          </Tooltip>
          <Tooltip title={t('Edit Provider')}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          </Tooltip>
          <Popconfirm
            title={t('Delete Provider')}
            description="Are you sure you want to delete this provider?"
            onConfirm={() => handleDelete(record.id)}
          >
            <Tooltip title={t('Delete Provider')}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Add Provider')}
        </Button>
      </div>

      <Table
        rowKey="id"
        dataSource={providers}
        columns={columns}
        loading={loading}
        pagination={false}
        locale={{ emptyText: t('No providers configured') }}
        size="middle"
      />

      <Modal
        open={modalOpen}
        title={editing ? t('Edit Provider') : t('Add Provider')}
        onCancel={() => setModalOpen(false)}
        footer={null}
        width={720}
        destroyOnClose
      >
        <ProviderForm
          initialValues={editing ?? undefined}
          onSubmit={handleSubmit}
          onCancel={() => setModalOpen(false)}
          submitting={submitting}
        />
      </Modal>
    </>
  );
};
