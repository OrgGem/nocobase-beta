// SPDX-License-Identifier: Apache-2.0

import {
  ApiOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import {
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useState } from 'react';
import { SECRET_MASK } from '../../shared/constants';
import type { RcloneConnectionPublic } from '../../shared/types';
import { useRcloneApi } from '../api';
import { useRcloneSession } from '../hooks/useRcloneSession';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/format';

export const RcloneSettings: React.FC = () => {
  const t = useT();
  const api = useRcloneApi();
  const {
    connections,
    enabledConnections,
    selectedConnectionId,
    setSelectedConnectionId,
    refreshSession,
    permissions,
  } = useRcloneSession();

  const [connModalOpen, setConnModalOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<RcloneConnectionPublic | null>(null);
  const [connSaving, setConnSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | 'draft' | null>(null);
  const [connForm] = Form.useForm();
  const watchedAuthType = Form.useWatch('authType', connForm) as string | undefined;

  // High-privilege runtime tuning & raw rclone.conf state
  const [optionsForm] = Form.useForm();
  const [configPath, setConfigPath] = useState('');
  const [configDisabled, setConfigDisabled] = useState(false);
  const [rawConfText, setRawConfText] = useState('');
  const [rawLoading, setRawLoading] = useState(false);
  const [savingOptions, setSavingOptions] = useState(false);
  const [savingRawConf, setSavingRawConf] = useState(false);

  const loadRawSettings = useCallback(async () => {
    if (!permissions.canRawConfig || !selectedConnectionId) {
      return;
    }
    setRawLoading(true);
    try {
      const [runtimeRes, rawRes] = await Promise.all([
        api.getRuntimeOptions(selectedConnectionId),
        api.getRawConfig(selectedConnectionId),
      ]);
      optionsForm.setFieldsValue(runtimeRes.options);
      setConfigPath(rawRes.path || runtimeRes.paths.config || '');
      setConfigDisabled(Boolean(rawRes.configDisabled));
      setRawConfText(rawRes.content);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load runtime options')));
    } finally {
      setRawLoading(false);
    }
  }, [api, optionsForm, permissions.canRawConfig, selectedConnectionId, t]);

  useEffect(() => {
    loadRawSettings();
  }, [loadRawSettings]);

  const openNewConnection = () => {
    setEditingConn(null);
    connForm.resetFields();
    connForm.setFieldsValue({ authType: 'basic', enabled: true, checkUsageOnLoad: true });
    setConnModalOpen(true);
  };

  const openEditConnection = (row: RcloneConnectionPublic) => {
    setEditingConn(row);
    connForm.setFieldsValue({
      name: row.name,
      title: row.title ?? '',
      baseUrl: row.baseUrl,
      authType: row.authType,
      username: row.username ?? '',
      password: row.password ?? '',
      enabled: row.enabled,
      checkUsageOnLoad: row.checkUsageOnLoad,
      notes: row.notes ?? '',
    });
    setConnModalOpen(true);
  };

  const handleSaveConnection = async () => {
    try {
      const values = (await connForm.validateFields()) as Record<string, unknown>;
      setConnSaving(true);
      if (editingConn) {
        await api.updateConnection(editingConn.id, values);
        message.success(t('Connection updated'));
      } else {
        await api.createConnection(values);
        message.success(t('Connection created'));
      }
      setConnModalOpen(false);
      await refreshSession();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err, t('Failed to save connection')));
    } finally {
      setConnSaving(false);
    }
  };

  const handleTestSaved = async (id: number) => {
    setTestingId(id);
    try {
      const res = await api.testConnection(id);
      message.success(`${t('Connected to Rclone')} ${res.version.version ?? ''}`);
      await refreshSession();
    } catch (err) {
      message.error(getErrorMessage(err, t('Connection test failed')));
    } finally {
      setTestingId(null);
    }
  };

  const handleTestDraft = async () => {
    try {
      const values = (await connForm.validateFields(['baseUrl', 'authType', 'username', 'password'])) as Record<
        string,
        unknown
      >;
      setTestingId('draft');
      const res = await api.testConnectionDraft({
        ...values,
        ...(editingConn ? { id: editingConn.id } : {}),
      });
      message.success(`${t('Connection verified')}: ${res.version.version ?? 'OK'}`);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err, t('Connection test failed')));
    } finally {
      setTestingId(null);
    }
  };

  const handleDeleteConn = async (id: number) => {
    try {
      await api.deleteConnection(id);
      message.success(t('Connection deleted'));
      await refreshSession();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete connection')));
    }
  };

  const handleSaveRuntimeOptions = async () => {
    if (!selectedConnectionId) return;
    try {
      const vals = (await optionsForm.validateFields()) as Record<string, unknown>;
      setSavingOptions(true);
      await api.setRuntimeOptions({ connectionId: selectedConnectionId, ...vals });
      message.success(t('Runtime options updated on rclone daemon'));
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to update runtime options')));
    } finally {
      setSavingOptions(false);
    }
  };

  const handleSaveRawConfig = async () => {
    if (!selectedConnectionId) return;
    setSavingRawConf(true);
    try {
      await api.saveRawConfig(selectedConnectionId, rawConfText);
      message.success(t('rclone.conf saved successfully'));
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save rclone.conf')));
    } finally {
      setSavingRawConf(false);
    }
  };

  const connColumns: ColumnsType<RcloneConnectionPublic> = [
    {
      title: t('Name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row: RcloneConnectionPublic) => (
        <Space>
          <Typography.Text strong>{row.title || name}</Typography.Text>
          <Typography.Text type="secondary">({name})</Typography.Text>
        </Space>
      ),
    },
    { title: t('RC URL'), dataIndex: 'baseUrl', key: 'baseUrl' },
    {
      title: t('Auth'),
      dataIndex: 'authType',
      key: 'authType',
      render: (auth: string) => <Tag>{auth}</Tag>,
    },
    {
      title: t('Status'),
      key: 'status',
      render: (_v: unknown, row: RcloneConnectionPublic) =>
        row.enabled ? (
          <Space>
            <Tag color="success">{t('Enabled')}</Tag>
            {row.lastVersion && <Tag color="blue">{row.lastVersion}</Tag>}
          </Space>
        ) : (
          <Tag>{t('Disabled')}</Tag>
        ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 240,
      render: (_v: unknown, row: RcloneConnectionPublic) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<CheckCircleOutlined />}
            loading={testingId === row.id}
            onClick={() => handleTestSaved(row.id)}
          >
            {t('Test')}
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditConnection(row)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this connection?')} onConfirm={() => handleDeleteConn(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={`${t('Delete')} ${row.name}`} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }} role="region" aria-label={t('Rclone Settings')}>
      {permissions.canManageConnections && (
        <Card
          size="small"
          title={t('Rclone RCD Connections')}
          extra={
            <Button type="primary" icon={<PlusOutlined />} onClick={openNewConnection}>
              {t('Add Connection')}
            </Button>
          }
        >
          <Table rowKey="id" size="small" columns={connColumns} dataSource={connections} pagination={false} />
        </Card>
      )}

      {permissions.canRawConfig && (
        <Card
          size="small"
          title={t('Daemon Performance, Logging & Raw rclone.conf')}
          loading={rawLoading}
          extra={
            <Select
              aria-label={t('Select Rclone Connection')}
              style={{ minWidth: 220 }}
              value={selectedConnectionId ?? undefined}
              onChange={setSelectedConnectionId}
              options={enabledConnections.map((c) => ({
                value: c.id,
                label: c.title ? `${c.title} (${c.name})` : c.name,
              }))}
            />
          }
        >
          {selectedConnectionId ? (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Form form={optionsForm} layout="vertical">
                <Row gutter={12}>
                  <Col xs={12} md={6}>
                    <Form.Item name="transfers" label={t('Parallel Transfers')}>
                      <InputNumber min={1} max={128} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item name="checkers" label={t('Parallel Checkers')}>
                      <InputNumber min={1} max={256} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item name="bwLimit" label={t('Bandwidth Limit (BwLimit)')}>
                      <Input placeholder="e.g. 50M or off" />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item name="tpsLimit" label={t('TPS Limit')}>
                      <InputNumber min={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={12}>
                  <Col xs={12} md={8}>
                    <Form.Item name="logLevel" label={t('Log Level')}>
                      <Select
                        options={['DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR'].map((lv) => ({
                          value: lv,
                          label: lv,
                        }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={16}>
                    <Form.Item name="logFile" label={t('Log File Path')}>
                      <Input placeholder="/var/log/rclone.log" />
                    </Form.Item>
                  </Col>
                </Row>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={savingOptions}
                  onClick={handleSaveRuntimeOptions}
                >
                  {t('Apply Runtime Flags')}
                </Button>
              </Form>

              <div>
                <Typography.Text strong>
                  {t('Active rclone.conf')}: <Typography.Text code>{configPath || '—'}</Typography.Text>
                </Typography.Text>
                <Input.TextArea
                  rows={10}
                  disabled={configDisabled}
                  placeholder={
                    configDisabled
                      ? t('Config file persistence is disabled on this daemon (RCLONE_CONFIG=/dev/null)')
                      : undefined
                  }
                  style={{ marginTop: 8, fontFamily: 'monospace' }}
                  value={rawConfText}
                  onChange={(e) => setRawConfText(e.target.value)}
                  aria-label={t('Raw rclone.conf editor')}
                />
                <Button
                  style={{ marginTop: 8 }}
                  type="primary"
                  danger
                  disabled={configDisabled}
                  icon={<SaveOutlined />}
                  loading={savingRawConf}
                  onClick={handleSaveRawConfig}
                >
                  {t('Overwrite rclone.conf')}
                </Button>
              </div>
            </Space>
          ) : (
            <Typography.Text type="secondary">{t('Select an enabled Rclone connection above.')}</Typography.Text>
          )}
        </Card>
      )}

      <Modal
        title={editingConn ? `${t('Edit Connection')}: ${editingConn.name}` : t('Add Rclone RCD Connection')}
        open={connModalOpen}
        onCancel={() => setConnModalOpen(false)}
        destroyOnClose
        footer={
          <Space>
            <Button icon={<ApiOutlined />} loading={testingId === 'draft'} onClick={handleTestDraft}>
              {t('Test Connection')}
            </Button>
            <Button onClick={() => setConnModalOpen(false)}>{t('Cancel')}</Button>
            <Button type="primary" loading={connSaving} onClick={handleSaveConnection}>
              {t('Save')}
            </Button>
          </Space>
        }
      >
        <Form form={connForm} layout="vertical">
          <Form.Item
            name="name"
            label={t('Identifier')}
            rules={[
              { required: true },
              { pattern: /^[a-zA-Z0-9_-]{1,64}$/, message: t('Use letters, digits, hyphens, or underscores') },
            ]}
          >
            <Input placeholder="primary-rcd" />
          </Form.Item>
          <Form.Item name="title" label={t('Display Title')}>
            <Input placeholder="Production Storage Node" />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label={t('Rclone RCD URL')}
            extra={t('Start daemon with: rclone rcd --rc-serve --rc-addr=0.0.0.0:5572. Supports {{$env.VAR}}.')}
            rules={[{ required: true }]}
          >
            <Input placeholder="http://rclone-rcd:5572" />
          </Form.Item>
          <Form.Item name="authType" label={t('Authentication')}>
            <Select
              options={[
                { value: 'basic', label: t('HTTP Basic Auth (--rc-user / --rc-pass)') },
                { value: 'none', label: t('No Auth (--rc-no-auth)') },
              ]}
            />
          </Form.Item>
          {watchedAuthType !== 'none' && (
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="username" label={t('Username')} rules={[{ required: true }]}>
                  <Input placeholder="admin or {{$env.RCLONE_USER}}" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="password"
                  label={t('Password')}
                  extra={editingConn ? t('Leave masked to keep existing password') : undefined}
                >
                  <Input.Password
                    autoComplete="new-password"
                    placeholder={editingConn ? SECRET_MASK : '{{$env.RCLONE_PASS}}'}
                  />
                </Form.Item>
              </Col>
            </Row>
          )}
          <Space size="large">
            <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="checkUsageOnLoad" label={t('Auto-check remote capacity')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="notes" label={t('Notes')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
};

export default RcloneSettings;
