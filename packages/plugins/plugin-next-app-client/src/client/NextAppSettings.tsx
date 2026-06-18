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
import { useApp } from '@nocobase/client-v2';
import { useTranslation } from 'react-i18next';

const { Title, Text } = Typography;
import { NextAppRoutesManager } from './NextAppRoutesManager';
import { ArrowLeftOutlined } from '@ant-design/icons';

/** Only lowercase letters, numbers, and hyphens */
const PATH_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Paths that must not be used */
const RESERVED_PATHS = ['admin', 'api', 'signin', 'signup', 'static', 'storage'];

/** Generate a random path like 'app-a3f1' */
const generateRandomPath = (): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `app-${suffix}`;
};

interface SubpathRecord {
  id: number;
  path: string;
  title?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const NextAppSettings: React.FC = () => {
  const api = useApp().apiClient;
  const { t } = useTranslation();

  const [subpaths, setSubpaths] = useState<SubpathRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SubpathRecord | null>(null);
  const [currentApp, setCurrentApp] = useState<SubpathRecord | null>(null);
  const [form] = Form.useForm();

  // Fetch all subpaths
  const fetchSubpaths = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'nextAppConfig:list',
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
    form.setFieldsValue({ path: generateRandomPath(), enabled: true });
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
          url: 'nextAppConfig:destroy',
          params: { filterByTk: record.id },
          method: 'post',
        });
        message.success(t('Deleted successfully'));
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
          url: 'nextAppConfig:update',
          params: { filterByTk: record.id },
          method: 'post',
          data: { enabled },
        });
        message.success(t('Saved successfully'));
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
          url: 'nextAppConfig:update',
          params: { filterByTk: editing.id },
          method: 'post',
          data: values,
        });
        message.success(t('Updated successfully'));
      } else {
        await api.request({
          url: 'nextAppConfig:create',
          method: 'post',
          data: values,
        });
        message.success(t('Created successfully'));
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
          <a href={`/apps/${value.replace(/^\//, '')}`} target="_blank" rel="noopener noreferrer">
            /apps/{value.replace(/^\//, '')}
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
      render: (_, record) => (
        <Space>
          <Button type="link" size="small" onClick={() => setCurrentApp(record)}>
            {t('Configure Routes')}
          </Button>
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm title={t('Are you sure you want to delete it?')} onConfirm={() => handleDelete(record)}>
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (currentApp) {
    return (
      <Card bordered={false}>
        <div style={{ marginBottom: 16 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => setCurrentApp(null)} style={{ marginBottom: 16 }}>
            {t('Back to Apps')}
          </Button>
          <Title level={4}>
            {t('Routes for')}: {currentApp.title || currentApp.path}
          </Title>
          <Text type="secondary">{t('Manage the menu and pages for this specific Next App')}</Text>
        </div>
        <NextAppRoutesManager configId={currentApp.id} appPath={currentApp.path} />
      </Card>
    );
  }

  return (
    <Card bordered={false}>
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
              {t('Next App routes')}
            </Title>
            <Text type="secondary">
              {t('Manage your decoupled Next.js applications and their routing structures.')}
            </Text>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            {t('Add new app')}
          </Button>
        </div>

        <Alert
          message={t(
            'Each app is accessible under /apps/{path}. You can configure separate menus and permissions for each.',
          )}
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
        />

        <Table
          columns={columns}
          dataSource={subpaths}
          loading={loading}
          rowKey="id"
          pagination={false}
          locale={{
            emptyText: t('No apps configured. Create your first Next App to start.'),
          }}
        />
      </Space>

      <Modal
        title={editing ? t('Edit App') : t('Add new app')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="path"
            label={t('Sub-path')}
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
                    return Promise.reject(new Error(t('This path is reserved and cannot be used')));
                  }
                  return Promise.resolve();
                },
              },
            ]}
            help={t('A unique identifier for this app (e.g. portal, dashboard)')}
          >
            <Input addonBefore="/apps/" placeholder="my-portal" disabled={!!editing} />
          </Form.Item>

          <Form.Item
            name="title"
            label={t('App Title')}
            rules={[{ required: true, message: t('Please input app title') }]}
          >
            <Input placeholder="E.g. Customer Portal" />
          </Form.Item>

          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch checkedChildren="ON" unCheckedChildren="OFF" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default NextAppSettings;
