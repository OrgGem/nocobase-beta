// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { KeyOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { DuApiKeySummary, IssuedDuApiKey, errorMessage, formatDateTime, unwrapData } from '../types';

export const ApiKeysTab: React.FC = () => {
  const ctx = useFlowContext();
  const api = ctx.api;
  const t = useT();
  const [keys, setKeys] = useState<DuApiKeySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [newlyIssued, setNewlyIssued] = useState<IssuedDuApiKey | null>(null);
  const [form] = Form.useForm();

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'docUnderstanding:listApiKeys' });
      setKeys(unwrapData<DuApiKeySummary[]>(res, []));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleIssue = async () => {
    setIssuing(true);
    try {
      const values = await form.validateFields();
      const res = await api.request({
        url: 'docUnderstanding:issueApiKey',
        method: 'POST',
        data: {
          name: values.name,
          tenantId: values.tenantId || 'default',
          allowedBusinesses: values.allowedBusinesses?.length ? values.allowedBusinesses : ['*'],
          allowedActions: values.allowedActions?.length ? values.allowedActions : ['*'],
        },
      });
      const created = unwrapData<IssuedDuApiKey | null>(res, null);
      setNewlyIssued(created);
      setModalOpen(false);
      fetchKeys();
      message.success(t('API key issued'));
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setIssuing(false);
    }
  };

  const handleRevoke = async (id: number) => {
    await api.request({
      url: 'docUnderstanding:revokeApiKey',
      method: 'POST',
      params: { filterByTk: id },
    });
    message.success(t('API key revoked'));
    fetchKeys();
  };

  const columns: ColumnsType<DuApiKeySummary> = [
    { title: t('Name'), dataIndex: 'name', width: 180 },
    {
      title: t('Key Prefix'),
      dataIndex: 'keyPrefix',
      width: 160,
      render: (v: string) => <code>{v}...</code>,
    },
    {
      title: t('Tenant'),
      dataIndex: 'tenantId',
      width: 120,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: t('Allowed Businesses'),
      dataIndex: 'allowedBusinesses',
      width: 220,
      render: (list: string[]) => (list || ['*']).map((b) => <Tag key={b}>{b}</Tag>),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <Tag color={s === 'active' ? 'success' : 'error'}>{s}</Tag>,
    },
    {
      title: t('Last Used'),
      dataIndex: 'lastUsedAt',
      width: 165,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: t('Action'),
      width: 110,
      render: (_: unknown, record) =>
        record.status === 'active' ? (
          <Popconfirm title={t('Revoke this API key?')} onConfirm={() => handleRevoke(record.id)}>
            <Button size="small" danger icon={<StopOutlined />} aria-label={`${t('Revoke')} ${record.name}`}>
              {t('Revoke')}
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        icon={<KeyOutlined />}
        message={t('Gateway API Keys (x-api-key)')}
        description={t(
          'External integrations pass x-api-key to call /api/du/v1/* or /api/v1/{uploads,businesses,operations,artifacts,usage}. Keys are stored as one-way SHA-256 hashes and isolated by Tenant ID.',
        )}
        style={{ marginBottom: 16 }}
      />

      {newlyIssued && (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setNewlyIssued(null)}
          message={t('Copy your new x-api-key now — it will never be shown again')}
          description={
            <Typography.Paragraph copyable style={{ margin: '8px 0 0', fontFamily: 'monospace' }}>
              {newlyIssued.rawKey}
            </Typography.Paragraph>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t('Issue API Key')}
        </Button>
      </Space>

      <Table rowKey="id" columns={columns} dataSource={keys} loading={loading} size="small" />

      <Modal
        title={t('Issue Gateway API Key')}
        open={modalOpen}
        onOk={handleIssue}
        onCancel={() => setModalOpen(false)}
        confirmLoading={issuing}
        okText={t('Issue Key')}
        cancelText={t('Cancel')}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ tenantId: 'default', allowedBusinesses: ['*'] }}>
          <Form.Item name="name" label={t('Key Name')} rules={[{ required: true }]}>
            <Input placeholder="ERP Invoice Integration" />
          </Form.Item>
          <Form.Item
            name="tenantId"
            label={t('Tenant ID')}
            help={t('Operations and artifacts are isolated per Tenant ID (cross-tenant lookups return 404)')}
          >
            <Input placeholder="default" />
          </Form.Item>
          <Form.Item name="allowedBusinesses" label={t('Allowed Businesses')}>
            <Select
              mode="multiple"
              options={[
                { value: '*', label: t('All Businesses (*)') },
                { value: 'document-core', label: 'document-core' },
                { value: 'lc-checker', label: 'lc-checker' },
                { value: 'example-review', label: 'example-review' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
