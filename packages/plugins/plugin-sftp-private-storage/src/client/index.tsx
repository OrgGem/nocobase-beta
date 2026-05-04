/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { Plugin, useAPIClient, useRequest } from '@nocobase/client';
// @ts-ignore
import { PluginFileManagerClient } from '@nocobase/plugin-file-manager/client';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Space,
  message,
  Popconfirm,
  Tag,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { NAMESPACE, STORAGE_TYPE_SFTP_PRIVATE } from '../constants';

const { TextArea } = Input;
const { Text } = Typography;
const STORAGE_NS = 'file-manager';

const sftpPrivateStorageType = {
  title: `{{t("SFTP (Private)", { ns: "${STORAGE_NS}" })}}`,
  name: STORAGE_TYPE_SFTP_PRIVATE,
  fieldset: {
    title: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
    },
    name: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      'x-disabled': '{{ !createOnly }}',
      required: true,
      default: '{{ useNewId("s_") }}',
      description:
        '{{t("Randomly generated and can be modified. Support letters, numbers and underscores, must start with an letter.")}}',
    },
    options: {
      type: 'object',
      'x-component': 'fieldset',
      properties: {
        host: {
          title: `{{t("Host", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          required: true,
        },
        port: {
          title: `{{t("Port", { ns: "${STORAGE_NS}" })}}`,
          type: 'number',
          'x-decorator': 'FormItem',
          'x-component': 'InputNumber',
          default: 22,
          required: true,
        },
        username: {
          title: `{{t("Username", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          required: true,
        },
        authMethod: {
          title: `{{t("Authentication method", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: [
            { label: `{{t("Password", { ns: "${STORAGE_NS}" })}}`, value: 'password' },
            { label: `{{t("Private key", { ns: "${STORAGE_NS}" })}}`, value: 'privateKey' },
          ],
          default: 'password',
        },
        password: {
          title: `{{t("Password", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          'x-component-props': { password: true },
        },
        privateKey: {
          title: `{{t("Private key", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
        },
        passphrase: {
          title: `{{t("Passphrase", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          'x-component-props': { password: true },
        },
        basePath: {
          title: `{{t("Base path", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          default: '/',
          description: `{{t("Base directory on the SFTP server.", { ns: "${STORAGE_NS}" })}}`,
        },
      },
    },
    path: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      description: `{{t('Relative path the file will be saved to. Left blank as root path. The leading and trailing slashes "/" will be ignored. For example: "user/avatar".', { ns: "${STORAGE_NS}" })}}`,
    },
    renameMode: {
      title: `{{t("Renaming", { ns: "${STORAGE_NS}" })}}`,
      description: `{{t("Renaming strategy to avoid filename conflicts when uploading files.", { ns: "${STORAGE_NS}" })}}`,
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Radio.Group',
      enum: [
        { label: `{{t("Append random ID", { ns: "${STORAGE_NS}" })}}`, value: 'appendRandomID' },
        { label: `{{t("Random string", { ns: "${STORAGE_NS}" })}}`, value: 'random' },
        {
          label: `{{t("Keep original filename (will be overwrite if filename is existed)", { ns: "${STORAGE_NS}" })}}`,
          value: 'none',
        },
      ],
      default: 'appendRandomID',
    },
    rules: {
      type: 'object',
      'x-component': 'fieldset',
      properties: {
        size: {
          type: 'number',
          title: `{{t("File size limit", { ns: "${STORAGE_NS}" })}}`,
          description: `{{t("Minimum from 1 byte.", { ns: "${STORAGE_NS}" })}}`,
          'x-decorator': 'FormItem',
          'x-component': 'FileSizeField',
          required: true,
          default: 1024 * 1024 * 20,
        },
        mimetype: {
          type: 'string',
          title: `{{t("File type (in MIME type format)", { ns: "${STORAGE_NS}" })}}`,
          description: `{{t('Multi-types seperated with comma, for example: "image/*", "image/png", "image/*, application/pdf" etc.', { ns: "${STORAGE_NS}" })}}`,
          'x-decorator': 'FormItem',
          'x-component': 'Input',
          'x-component-props': {
            placeholder: '*',
          },
        },
      },
    },
    default: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      'x-content': `{{t("Default storage", { ns: "${STORAGE_NS}" })}}`,
    },
    paranoid: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      'x-content': `{{t("Keep file in storage when destroy the file record", { ns: "${STORAGE_NS}" })}}`,
    },
  },
};

/**
 * SFTP Configuration Settings Page
 */
const SftpSettingsPage: React.FC = () => {
  const api = useAPIClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<any>(null);
  const [form] = Form.useForm();
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const {
    data: configsData,
    loading,
    refresh,
  } = useRequest<any>({
    url: 'sftpStorageConfigs:list',
    params: {
      sort: ['-createdAt'],
      pageSize: 50,
    },
  });

  const configs = configsData?.data || [];

  const handleAdd = () => {
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      port: 22,
      authMethod: 'password',
      basePath: '/',
      enabled: true,
    });
    setTestResult(null);
    setModalOpen(true);
  };

  const handleEdit = (record: any) => {
    setEditingRecord(record);
    form.setFieldsValue({
      ...record,
      password: '', // Don't show existing password
      passphrase: '',
    });
    setTestResult(null);
    setModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await api.request({
        url: `sftpStorageConfigs:destroy`,
        method: 'post',
        params: { filterByTk: id },
      });
      message.success('Deleted successfully');
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || 'Delete failed');
    }
  };

  const handleTestConnection = async () => {
    try {
      const values = await form.validateFields([
        'host',
        'port',
        'username',
        'authMethod',
        'password',
        'privateKey',
        'passphrase',
      ]);
      setTesting(true);
      setTestResult(null);

      const res = await api.request({
        url: 'sftpStorageConfigs:testConnection',
        method: 'post',
        data: { values },
      });

      setTestResult(res?.data?.data || { success: false, message: 'Unknown error' });
    } catch (err: any) {
      setTestResult({ success: false, message: err?.message || 'Validation failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);

      // Remove empty password/passphrase fields on edit (don't overwrite existing)
      if (editingRecord) {
        if (!values.password) delete values.password;
        if (!values.passphrase) delete values.passphrase;
      }

      if (editingRecord) {
        await api.request({
          url: `sftpStorageConfigs:update`,
          method: 'post',
          params: { filterByTk: editingRecord.id },
          data: { values },
        });
        message.success('Updated successfully');
      } else {
        await api.request({
          url: 'sftpStorageConfigs:create',
          method: 'post',
          data: { values },
        });
        message.success('Created successfully');
      }

      setModalOpen(false);
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      width: 200,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (text: string) => <Text code>{text}</Text>,
    },
    {
      title: 'Host',
      key: 'host',
      width: 200,
      render: (_: any, record: any) => `${record.host}:${record.port || 22}`,
    },
    {
      title: 'Username',
      dataIndex: 'username',
      key: 'username',
      width: 120,
    },
    {
      title: 'Auth',
      dataIndex: 'authMethod',
      key: 'authMethod',
      width: 100,
      render: (method: string) => (
        <Tag color={method === 'privateKey' ? 'blue' : 'green'}>{method === 'privateKey' ? 'Key' : 'Password'}</Tag>
      ),
    },
    {
      title: 'Base Path',
      dataIndex: 'basePath',
      key: 'basePath',
      width: 180,
      render: (text: string) => <Text code>{text || '/'}</Text>,
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (enabled: boolean) =>
        enabled ? (
          <CheckCircleOutlined style={{ color: '#52c41a' }} />
        ) : (
          <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_: any, record: any) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm
            title="Are you sure to delete this configuration?"
            onConfirm={() => handleDelete(record.id)}
            okText="Yes"
            cancelText="No"
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const authMethod = Form.useWatch('authMethod', form);

  return (
    <Card
      title="SFTP Storage Configurations"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Add Configuration
        </Button>
      }
    >
      <Table dataSource={configs} columns={columns} rowKey="id" loading={loading} pagination={false} size="middle" />

      <Modal
        title={editingRecord ? 'Edit SFTP Configuration' : 'New SFTP Configuration'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        width={600}
        footer={[
          <Button key="test" icon={<ApiOutlined />} loading={testing} onClick={handleTestConnection}>
            Test Connection
          </Button>,
          <Button key="cancel" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>,
          <Button key="save" type="primary" loading={saving} onClick={handleSave}>
            Save
          </Button>,
        ]}
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item name="title" label="Title" rules={[{ required: true, message: 'Title is required' }]}>
            <Input placeholder="My SFTP Server" />
          </Form.Item>

          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, message: 'Name is required' },
              {
                pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/,
                message: 'Must start with letter, only letters/numbers/underscores',
              },
            ]}
          >
            <Input placeholder="my_sftp_server" disabled={!!editingRecord} />
          </Form.Item>

          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item
              name="host"
              label="Host"
              rules={[{ required: true, message: 'Host is required' }]}
              style={{ flex: 1 }}
            >
              <Input placeholder="sftp.example.com" />
            </Form.Item>

            <Form.Item name="port" label="Port" style={{ width: 120 }}>
              <InputNumber min={1} max={65535} placeholder="22" style={{ width: '100%' }} />
            </Form.Item>
          </Space>

          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Username is required' }]}>
            <Input placeholder="sftpuser" />
          </Form.Item>

          <Form.Item name="authMethod" label="Authentication Method">
            <Select
              options={[
                { label: 'Password', value: 'password' },
                { label: 'Private Key', value: 'privateKey' },
              ]}
            />
          </Form.Item>

          {authMethod === 'privateKey' ? (
            <>
              <Form.Item name="privateKey" label="Private Key">
                <TextArea rows={4} placeholder="-----BEGIN RSA PRIVATE KEY-----..." />
              </Form.Item>
              <Form.Item name="passphrase" label="Passphrase">
                <Input.Password placeholder="Optional passphrase for the private key" />
              </Form.Item>
            </>
          ) : (
            <Form.Item name="password" label="Password">
              <Input.Password placeholder={editingRecord ? 'Leave empty to keep existing' : 'Enter password'} />
            </Form.Item>
          )}

          <Form.Item name="basePath" label="Base Path">
            <Input placeholder="/" />
          </Form.Item>

          <Form.Item name="enabled" label="Enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>

        {testResult && (
          <div
            style={{
              marginTop: 16,
              padding: '8px 12px',
              borderRadius: 6,
              background: testResult.success ? '#f6ffed' : '#fff2f0',
              border: `1px solid ${testResult.success ? '#b7eb8f' : '#ffccc7'}`,
            }}
          >
            {testResult.success ? (
              <Text type="success">
                <CheckCircleOutlined /> {testResult.message}
              </Text>
            ) : (
              <Text type="danger">
                <CloseCircleOutlined /> {testResult.message}
              </Text>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
};

export class PluginSftpPrivateStorageClient extends Plugin {
  async load() {
    // @ts-ignore
    const fileManagerPlugin = this.app.pm.get(PluginFileManagerClient) as any;
    if (fileManagerPlugin) {
      fileManagerPlugin.registerStorageType(STORAGE_TYPE_SFTP_PRIVATE, sftpPrivateStorageType);
    }

    // Settings for SFTP are now managed directly in the File Manager plugin.
    // The left navigator setting "SFTP Private Storage" has been hidden.
  }
}

export default PluginSftpPrivateStorageClient;
