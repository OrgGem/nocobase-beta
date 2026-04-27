/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import {
  Card, Table, Button, Modal, Form, Input, Select, Switch, Space, message, Popconfirm,
  Tag, Typography, Checkbox, Divider, InputNumber,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SafetyOutlined, ReloadOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { DIRECTORY_ACTIONS } from '../../constants';

const { Text } = Typography;
const { TextArea } = Input;

const ACTION_LABELS: Record<string, string> = {
  list: 'List', view: 'View', upload: 'Upload',
  download: 'Download', delete: 'Delete', mkdir: 'Create Folder',
};

/**
 * Admin settings component for managing virtual directories
 * and their per-role permissions.
 */
export const DirectoryManager: React.FC = () => {
  const api = useAPIClient();
  const [dirModalOpen, setDirModalOpen] = useState(false);
  const [permModalOpen, setPermModalOpen] = useState(false);
  const [editingDir, setEditingDir] = useState<any>(null);
  const [editingPerm, setEditingPerm] = useState<any>(null);
  const [selectedDirId, setSelectedDirId] = useState<number | null>(null);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [dirForm] = Form.useForm();
  const [permForm] = Form.useForm();
  const [configForm] = Form.useForm();

  const { data: dirsData, loading: dirsLoading, refresh: refreshDirs } = useRequest<any>({
    url: 'externalStorageDirectories:list',
    params: { sort: ['sort', 'name'], appends: ['permissions'], pageSize: 100 },
  });

  const { data: rolesData } = useRequest<any>({ url: 'roles:list', params: { pageSize: 100 } });
  const {
    data: storageOptionsData,
    refresh: refreshStorageOptions,
  } = useRequest<any>({ url: 'extStorage:storageOptions', method: 'get' });

  const dirs = Array.isArray(dirsData?.data?.data) ? dirsData.data.data : Array.isArray(dirsData?.data) ? dirsData.data : Array.isArray(dirsData) ? dirsData : [];
  const roles = Array.isArray(rolesData?.data?.data) ? rolesData.data.data : Array.isArray(rolesData?.data) ? rolesData.data : Array.isArray(rolesData) ? rolesData : [];
  
  // NocoBase useRequest might return the payload directly, or wrapped in { data: payload }
  const rawStorageData = storageOptionsData?.data?.data || storageOptionsData?.data || storageOptionsData || { s3: [], sftp: [] };
  const storageOptions = rawStorageData.s3 ? rawStorageData : { s3: [], sftp: [] };
  
  const s3Options = Array.isArray(storageOptions.s3) ? storageOptions.s3 : [];
  const sftpOptions = Array.isArray(storageOptions.sftp) ? storageOptions.sftp : [];
  const selectedStorageType = Form.useWatch('storageType', dirForm);
  const configType = Form.useWatch('type', configForm);
  const configAuthMethod = Form.useWatch('authMethod', configForm);
  const configOptions = (selectedStorageType === 'sftp-private' ? sftpOptions : s3Options).map((item: any) => ({
    label: `${item.title || item.name} (${item.name})`,
    value: item.name,
  }));

  const openNewConfigModal = () => {
    configForm.resetFields();
    configForm.setFieldsValue({
      type: selectedStorageType || 's3-private',
      port: 22,
      authMethod: 'password',
      basePath: '/',
      enabled: true,
      sizeLimit: 1024 * 1024 * 20,
    });
    setConfigModalOpen(true);
  };

  const handleCreateConfig = async () => {
    const values = await configForm.validateFields();
    const type = values.type;
    setSavingConfig(true);
    try {
      if (type === 'sftp-private') {
        await api.request({
          url: 'sftpStorageConfigs:create',
          method: 'post',
          data: {
            values: {
              title: values.title,
              name: values.name,
              host: values.host,
              port: values.port || 22,
              username: values.username,
              authMethod: values.authMethod || 'password',
              password: values.password,
              privateKey: values.privateKey,
              passphrase: values.passphrase,
              basePath: values.basePath || '/',
              enabled: true,
            },
          },
        });
      } else {
        await api.request({
          url: 'storages:create',
          method: 'post',
          data: {
            values: {
              title: values.title,
              name: values.name,
              type: 's3-private',
              baseUrl: '',
              path: '',
              options: {
                region: values.region,
                accessKeyId: values.accessKeyId,
                secretAccessKey: values.secretAccessKey,
                bucket: values.bucket,
                endpoint: values.endpoint,
              },
              rules: {
                size: values.sizeLimit || 1024 * 1024 * 20,
                mimetype: values.mimetype || '',
              },
              default: false,
              paranoid: false,
            },
          },
        });
      }
      message.success('Storage config created');
      dirForm.setFieldsValue({ storageType: type, storageConfigName: values.name });
      setConfigModalOpen(false);
      refreshStorageOptions();
    } catch (error: any) {
      message.error(error?.response?.data?.errors?.[0]?.message || error?.message || 'Create storage config failed');
    } finally {
      setSavingConfig(false);
    }
  };

  // --- Directory CRUD ---
  const handleAddDir = () => {
    setEditingDir(null);
    dirForm.resetFields();
    dirForm.setFieldsValue({ rootPath: '/', enabled: true, sort: 0, storageType: 's3-private' });
    setDirModalOpen(true);
  };

  const handleEditDir = (record: any) => {
    setEditingDir(record);
    dirForm.setFieldsValue(record);
    setDirModalOpen(true);
  };

  const handleSaveDir = async () => {
    const values = await dirForm.validateFields();
    if (editingDir) {
      await api.resource('externalStorageDirectories').update({ filterByTk: editingDir.id, values });
    } else {
      await api.resource('externalStorageDirectories').create({ values });
    }
    message.success('Saved');
    setDirModalOpen(false);
    refreshDirs();
  };

  const handleDeleteDir = async (id: number) => {
    await api.resource('externalStorageDirectories').destroy({ filterByTk: id });
    message.success('Deleted');
    refreshDirs();
  };

  // --- Permission CRUD ---
  const openPermissions = (dirId: number) => {
    setSelectedDirId(dirId);
    setPermModalOpen(true);
    setEditingPerm(null);
  };

  const handleSavePerm = async () => {
    const values = await permForm.validateFields();
    values.directoryId = selectedDirId;
    if (editingPerm) {
      await api.resource('externalStorageDirectoryPermissions').update({ filterByTk: editingPerm.id, values });
    } else {
      await api.resource('externalStorageDirectoryPermissions').create({ values });
    }
    message.success('Permission saved');
    setEditingPerm(null);
    permForm.resetFields();
    refreshDirs();
  };

  const handleDeletePerm = async (id: number) => {
    await api.resource('externalStorageDirectoryPermissions').destroy({ filterByTk: id });
    message.success('Permission deleted');
    refreshDirs();
  };

  const dirColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name', width: 160 },
    { title: 'Slug', dataIndex: 'slug', key: 'slug', width: 120, render: (v: string) => <Text code>{v}</Text> },
    { title: 'Storage', dataIndex: 'storageType', key: 'storageType', width: 100, render: (v: string) => <Tag color={v === 'sftp-private' ? 'green' : 'blue'}>{v === 'sftp-private' ? 'SFTP' : 'S3'}</Tag> },
    { title: 'Config', dataIndex: 'storageConfigName', key: 'storageConfigName', width: 140, render: (v: string) => <Text code>{v}</Text> },
    { title: 'Root Path', dataIndex: 'rootPath', key: 'rootPath', width: 180, render: (v: string) => <Text code>{v}</Text> },
    { title: 'Enabled', dataIndex: 'enabled', key: 'enabled', width: 70, render: (v: boolean) => v ? <Tag color="success">Yes</Tag> : <Tag>No</Tag> },
    {
      title: 'Permissions', key: 'perms', width: 100,
      render: (_: any, r: any) => <Button size="small" icon={<SafetyOutlined />} onClick={() => openPermissions(r.id)}>{(r.permissions || []).length}</Button>,
    },
    {
      title: 'Actions', key: 'actions', width: 100,
      render: (_: any, r: any) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditDir(r)} />
          <Popconfirm title="Delete this directory?" onConfirm={() => handleDeleteDir(r.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const selectedDir = dirs.find((d: any) => d.id === selectedDirId);
  const selectedPerms = selectedDir?.permissions || [];

  return (
    <>
      <Card title="External Storage Directories" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAddDir}>Add Directory</Button>}>
        <Table dataSource={dirs} columns={dirColumns} rowKey="id" loading={dirsLoading} pagination={false} size="middle" />
      </Card>

      {/* Directory Form Modal */}
      <Modal title={editingDir ? 'Edit Directory' : 'New Directory'} open={dirModalOpen} onOk={handleSaveDir} onCancel={() => setDirModalOpen(false)} width={520}>
        <Form form={dirForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="slug" label="Slug" rules={[{ required: true }, { pattern: /^[a-z0-9-]+$/, message: 'Lowercase letters, numbers, hyphens only' }]}><Input disabled={!!editingDir} /></Form.Item>
          <Form.Item name="storageType" label="Storage Type" rules={[{ required: true }]}>
            <Select
              options={[{ label: 'S3 Private', value: 's3-private' }, { label: 'SFTP Private', value: 'sftp-private' }]}
              onChange={() => dirForm.setFieldValue('storageConfigName', undefined)}
            />
          </Form.Item>
          <Form.Item name="storageConfigName" label="Storage Config" rules={[{ required: true }]}>
            <Select
              showSearch
              placeholder={selectedStorageType === 'sftp-private' ? 'Select an SFTP configuration' : 'Select a File manager S3 storage'}
              optionFilterProp="label"
              options={configOptions}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <Divider style={{ margin: '8px 0' }} />
                  <Space direction="vertical" style={{ width: '100%', padding: '0 8px 4px' }}>
                    <Button type="text" icon={<PlusOutlined />} block onClick={openNewConfigModal}>
                      New connection
                    </Button>
                    <Button type="text" icon={<ReloadOutlined />} block onClick={refreshStorageOptions}>
                      Reload storage configs
                    </Button>
                  </Space>
                </>
              )}
            />
          </Form.Item>
          <Form.Item name="rootPath" label="Root Path"><Input placeholder="/" /></Form.Item>
          <Form.Item name="description" label="Description"><TextArea rows={2} /></Form.Item>
          <Space>
            <Form.Item name="enabled" label="Enabled" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="sort" label="Sort Order"><InputNumber style={{ width: 100 }} /></Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="New Storage Connection"
        open={configModalOpen}
        onOk={handleCreateConfig}
        onCancel={() => setConfigModalOpen(false)}
        confirmLoading={savingConfig}
        width={620}
      >
        <Form form={configForm} layout="vertical" autoComplete="off">
          <Form.Item name="type" label="Storage Type" rules={[{ required: true }]}>
            <Select options={[{ label: 'S3 Private', value: 's3-private' }, { label: 'SFTP Private', value: 'sftp-private' }]} />
          </Form.Item>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}>
            <Input placeholder="My storage" />
          </Form.Item>
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true },
              { pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/, message: 'Must start with letter, only letters/numbers/underscores' },
            ]}
          >
            <Input placeholder="my_storage" />
          </Form.Item>

          {configType === 'sftp-private' ? (
            <>
              <Space style={{ display: 'flex' }} size="middle">
                <Form.Item name="host" label="Host" rules={[{ required: true }]} style={{ flex: 1 }}>
                  <Input placeholder="sftp.example.com" />
                </Form.Item>
                <Form.Item name="port" label="Port" style={{ width: 120 }}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </Space>
              <Form.Item name="username" label="Username" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="authMethod" label="Authentication Method">
                <Select options={[{ label: 'Password', value: 'password' }, { label: 'Private Key', value: 'privateKey' }]} />
              </Form.Item>
              {configAuthMethod === 'privateKey' ? (
                <>
                  <Form.Item name="privateKey" label="Private Key" rules={[{ required: true }]}>
                    <TextArea rows={4} />
                  </Form.Item>
                  <Form.Item name="passphrase" label="Passphrase">
                    <Input.Password />
                  </Form.Item>
                </>
              ) : (
                <Form.Item name="password" label="Password" rules={[{ required: true }]}>
                  <Input.Password />
                </Form.Item>
              )}
              <Form.Item name="basePath" label="Base Path">
                <Input placeholder="/" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="region" label="Region" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="accessKeyId" label="AccessKey ID" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="secretAccessKey" label="AccessKey Secret" rules={[{ required: true }]}>
                <Input.Password />
              </Form.Item>
              <Form.Item name="bucket" label="Bucket" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="endpoint" label="Endpoint">
                <Input placeholder="Optional S3-compatible endpoint" />
              </Form.Item>
              <Form.Item name="sizeLimit" label="File Size Limit">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="mimetype" label="Allowed MIME Types">
                <Input placeholder="Optional, e.g. image/*, application/pdf" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      {/* Permissions Modal */}
      <Modal title={`Permissions: ${selectedDir?.name || ''}`} open={permModalOpen} onCancel={() => setPermModalOpen(false)} width={650} footer={null}>
        <Table dataSource={selectedPerms} rowKey="id" pagination={false} size="small" columns={[
          { title: 'Role', dataIndex: 'roleName', key: 'roleName', width: 120, render: (v: string) => <Tag>{v}</Tag> },
          { title: 'Actions', dataIndex: 'actions', key: 'actions', render: (acts: string[]) => (acts || []).map((a) => <Tag key={a} color="blue">{ACTION_LABELS[a] || a}</Tag>) },
          { title: 'Sub Path', dataIndex: 'subPath', key: 'subPath', width: 140, render: (v: string) => v ? <Text code>{v}</Text> : <Text type="secondary">All</Text> },
          { title: '', key: 'act', width: 80, render: (_: any, r: any) => (
            <Space size="small">
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setEditingPerm(r); permForm.setFieldsValue(r); }} />
              <Popconfirm title="Remove?" onConfirm={() => handleDeletePerm(r.id)}><Button type="link" size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
            </Space>
          )},
        ]} />

        <Divider />
        <Text strong>{editingPerm ? 'Edit Permission' : 'Add Permission'}</Text>
        <Form form={permForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="roleName" label="Role" rules={[{ required: true }]}>
            <Select placeholder="Select role" options={roles.map((r: any) => ({ label: r.title || r.name, value: r.name }))} />
          </Form.Item>
          <Form.Item name="actions" label="Allowed Actions" rules={[{ required: true }]}>
            <Checkbox.Group options={DIRECTORY_ACTIONS.map((a) => ({ label: ACTION_LABELS[a] || a, value: a }))} />
          </Form.Item>
          <Form.Item name="subPath" label="Sub Path Restriction"><Input placeholder="Leave empty for full access" /></Form.Item>
          <Space>
            <Button type="primary" onClick={handleSavePerm}>{editingPerm ? 'Update' : 'Add'}</Button>
            {editingPerm && <Button onClick={() => { setEditingPerm(null); permForm.resetFields(); }}>Cancel</Button>}
          </Space>
        </Form>
      </Modal>
    </>
  );
};

export default DirectoryManager;
