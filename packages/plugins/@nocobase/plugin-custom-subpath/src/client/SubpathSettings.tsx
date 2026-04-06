/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Button, Modal, Form, Input, Switch, Space, Popconfirm, Alert, Typography, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, LinkOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useTranslation } from 'react-i18next';

const { Title, Text } = Typography;

/** Only lowercase letters, numbers, and hyphens */
const PATH_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Paths that must not be used as custom subpaths */
const RESERVED_PATHS = ['admin', 'api', 'signin', 'signup', 'static', 'storage'];

interface SubpathRecord {
  id: number;
  path: string;
  title?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const SubpathSettings: React.FC = () => {
  const api = useAPIClient();
  const { t } = useTranslation('@nocobase/plugin-custom-subpath');

  const [subpaths, setSubpaths] = useState<SubpathRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SubpathRecord | null>(null);
  const [form] = Form.useForm();

  // Fetch all subpaths
  const fetchSubpaths = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'customSubpaths:list',
        params: { sort: ['-createdAt'], pageSize: 100 },
      });
      setSubpaths((res as any)?.data?.data || []);
    } catch (err) {
      console.error('Failed to fetch subpaths:', err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchSubpaths();
  }, [fetchSubpaths]);

  // Open modal for creating
  const handleCreate = useCallback(() => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true });
    setModalOpen(true);
  }, [form]);

  // Open modal for editing
  const handleEdit = useCallback(
    (record: SubpathRecord) => {
      setEditing(record);
      form.setFieldsValue({
        path: record.path,
        title: record.title,
        enabled: record.enabled,
      });
      setModalOpen(true);
    },
    [form],
  );

  // Delete a subpath
  const handleDelete = useCallback(
    async (record: SubpathRecord) => {
      try {
        await api.request({
          url: 'customSubpaths:destroy',
          params: { filterByTk: record.id },
          method: 'post',
        });
        message.success(t('Subpath deleted successfully'));
        fetchSubpaths();
      } catch (err) {
        console.error('Failed to delete subpath:', err);
      }
    },
    [api, fetchSubpaths, t],
  );

  // Toggle enabled/disabled
  const handleToggle = useCallback(
    async (record: SubpathRecord, enabled: boolean) => {
      try {
        await api.request({
          url: 'customSubpaths:update',
          params: { filterByTk: record.id },
          method: 'post',
          data: { enabled },
        });
        message.success(t('Subpath updated successfully'));
        fetchSubpaths();
      } catch (err) {
        console.error('Failed to toggle subpath:', err);
      }
    },
    [api, fetchSubpaths, t],
  );

  // Save (create or update)
  const handleSave = useCallback(async () => {
    try {
      const values = await form.validateFields();

      if (editing) {
        await api.request({
          url: 'customSubpaths:update',
          params: { filterByTk: editing.id },
          method: 'post',
          data: values,
        });
        message.success(t('Subpath updated successfully'));
      } else {
        await api.request({
          url: 'customSubpaths:create',
          method: 'post',
          data: values,
        });
        message.success(t('Subpath created successfully'));
      }

      setModalOpen(false);
      fetchSubpaths();
    } catch (err) {
      console.error('Failed to save subpath:', err);
    }
  }, [api, editing, fetchSubpaths, form, t]);

  const columns = [
    {
      title: t('Path'),
      dataIndex: 'path',
      key: 'path',
      render: (value: string) => (
        <Space>
          <LinkOutlined />
          <a href={`/${value}`} target="_blank" rel="noopener noreferrer">
            /{value}
          </a>
        </Space>
      ),
    },
    {
      title: t('Title'),
      dataIndex: 'title',
      key: 'title',
      render: (value: string) => value || '-',
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 120,
      render: (value: boolean, record: SubpathRecord) => (
        <Switch
          checked={value}
          onChange={(checked) => handleToggle(record, checked)}
          checkedChildren="ON"
          unCheckedChildren="OFF"
        />
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 140,
      render: (_: any, record: SubpathRecord) => (
        <Space>
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm
            title={t('Delete subpath')}
            description={t('Are you sure you want to delete this subpath?')}
            onConfirm={() => handleDelete(record)}
            okText={t('Delete')}
            cancelText={t('Cancel')}
          >
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <Title level={4} style={{ margin: 0 }}>
              {t('Custom Subpath')}
            </Title>
            <Text type="secondary">
              {t('Custom subpaths allow you to access the admin panel via alternative URLs')}
            </Text>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            {t('Add subpath')}
          </Button>
        </div>

        <Alert message={t('e.g. dashboard, portal, app')} type="info" showIcon style={{ marginBottom: 8 }} />

        <Table
          columns={columns}
          dataSource={subpaths}
          loading={loading}
          rowKey="id"
          pagination={false}
          locale={{
            emptyText: t('No custom subpaths configured yet'),
          }}
        />
      </Space>

      <Modal
        title={editing ? t('Edit subpath') : t('Add subpath')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        okText={t('Save')}
        cancelText={t('Cancel')}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="path"
            label={t('Path')}
            rules={[
              {
                validator: (_rule, value) => {
                  if (!value) {
                    return Promise.reject(new Error(t('Path is required')));
                  }
                  if (!PATH_REGEX.test(value)) {
                    return Promise.reject(
                      new Error(t('Path must contain only lowercase letters, numbers, and hyphens')),
                    );
                  }
                  if (RESERVED_PATHS.includes(value)) {
                    return Promise.reject(new Error(t('Path cannot be a reserved word')));
                  }
                  return Promise.resolve();
                },
              },
            ]}
            help={t('e.g. dashboard, portal, app')}
          >
            <Input addonBefore="/" placeholder="dashboard" disabled={!!editing} />
          </Form.Item>

          <Form.Item name="title" label={t('Title')}>
            <Input placeholder="My Dashboard" />
          </Form.Item>

          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch checkedChildren="ON" unCheckedChildren="OFF" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default SubpathSettings;
