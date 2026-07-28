import React, { useState } from 'react';
import { Button, Card, Form, Input, Modal, Space, Table, type TableColumnsType, Tag, Typography } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import { type NocoBaseListBody, type NocoBaseResponse, unwrapRecords } from './api';

type RegistryPackage = {
  id: string;
  namespace: string;
  slug: string;
  displayName: string;
  status: string;
  visibility: string;
  updatedAt?: string;
  latestStableVersion?: { version?: string };
};

type SourceItem = {
  id: string;
  displayName: string;
  state: string;
  sourceRevision: string;
  candidateDigest: string;
  updatedAt?: string;
};

type PublishValues = {
  version: string;
  channel: string;
};

type ResolveValues = {
  namespace: string;
  slug: string;
};

export default function CatalogPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canPublish } = useSkillRegistryPermissions();
  const packagesRequest = useRequest(() =>
    ctx.api.request<NocoBaseListBody<RegistryPackage>>({
      url: 'skillRegistryPackages:list',
      method: 'get',
      params: { appends: ['latestStableVersion'] },
    }),
  );
  const candidatesRequest = useRequest(() =>
    ctx.api.request<NocoBaseListBody<SourceItem>>({
      url: 'skillRegistrySourceItems:list',
      method: 'get',
      params: { sort: ['-updatedAt'], pageSize: 20 },
    }),
  );
  const packages = unwrapRecords<RegistryPackage>(packagesRequest.data);
  const candidates = unwrapRecords<SourceItem>(candidatesRequest.data);
  const [publishCandidate, setPublishCandidate] = useState<SourceItem | null>(null);
  const [resolveCandidate, setResolveCandidate] = useState<SourceItem | null>(null);
  const [publishForm] = Form.useForm<PublishValues>();
  const [resolveForm] = Form.useForm<ResolveValues>();
  const packageColumns: TableColumnsType<RegistryPackage> = [
    {
      title: t('Name'),
      key: 'name',
      render: (_, record) => `${record.namespace}/${record.slug}`,
    },
    { title: t('Catalog'), key: 'displayName', render: (_, record) => record.displayName },
    { title: t('Version'), key: 'version', render: (_, record) => record.latestStableVersion?.version || '\u2014' },
    { title: t('Status'), key: 'status', render: (_, record) => <Tag>{record.status}</Tag> },
    { title: t('Updated'), key: 'updatedAt', render: (_, record) => record.updatedAt || '\u2014' },
  ];
  const candidateColumns: TableColumnsType<SourceItem> = [
    { title: t('Name'), key: 'displayName', render: (_, record) => record.displayName },
    { title: t('Status'), key: 'state', render: (_, record) => <Tag>{record.state}</Tag> },
    {
      title: t('Digest'),
      key: 'candidateDigest',
      render: (_, record) => <Typography.Text code>{`${record.candidateDigest.slice(0, 18)}\u2026`}</Typography.Text>,
    },
    { title: t('Updated'), key: 'updatedAt', render: (_, record) => record.updatedAt || '\u2014' },
  ];

  if (canPublish) {
    candidateColumns.push({
      title: t('Run'),
      key: 'actions',
      render: (_, record) =>
        record.state === 'conflict' ? (
          <Button onClick={() => setResolveCandidate(record)}>{t('Resolve conflict')}</Button>
        ) : (
          <Button
            disabled={!['ready', 'published'].includes(record.state)}
            onClick={() => {
              publishForm.setFieldsValue({ version: '', channel: 'stable' });
              setPublishCandidate(record);
            }}
          >
            {t('Publish')}
          </Button>
        ),
    });
  }

  const refresh = async () => {
    await Promise.all([packagesRequest.refreshAsync(), candidatesRequest.refreshAsync()]);
  };

  const publish = async () => {
    if (!canPublish || !publishCandidate) {
      return;
    }
    try {
      const values = await publishForm.validateFields();
      await ctx.api.request<NocoBaseResponse<{ version: string }>>({
        url: 'skillRegistryAdmin:publish',
        method: 'post',
        data: { sourceItemId: publishCandidate.id, version: values.version, channel: values.channel || 'stable' },
      });
      ctx.message.success(t('Candidate published'));
      setPublishCandidate(null);
      await refresh();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  const resolveConflict = async () => {
    if (!canPublish || !resolveCandidate) {
      return;
    }
    try {
      const values = await resolveForm.validateFields();
      await ctx.api.request<NocoBaseResponse<{ sourceItemId: string; packageId: string; state: string }>>({
        url: 'skillRegistryAdmin:resolve',
        method: 'post',
        data: { sourceItemId: resolveCandidate.id, namespace: values.namespace, slug: values.slug },
      });
      ctx.message.success(t('Conflict resolved'));
      setResolveCandidate(null);
      await refresh();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Card
        title={t('Catalog')}
        extra={
          <Button onClick={refresh} loading={packagesRequest.loading || candidatesRequest.loading}>
            {t('Refresh')}
          </Button>
        }
      >
        <Table
          aria-label={t('Catalog')}
          rowKey="id"
          loading={packagesRequest.loading}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 'max-content' }}
          dataSource={packages}
          locale={{ emptyText: t('No data') }}
          columns={packageColumns}
        />
      </Card>

      <Card title={t('Candidates')}>
        <Table
          aria-label={t('Candidates')}
          rowKey="id"
          loading={candidatesRequest.loading}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 'max-content' }}
          dataSource={candidates}
          locale={{ emptyText: t('No data') }}
          columns={candidateColumns}
        />
      </Card>
      {canPublish ? (
        <>
          <Modal
            title={t('Publish')}
            open={Boolean(publishCandidate)}
            onCancel={() => setPublishCandidate(null)}
            onOk={publish}
            okText={t('Publish')}
            cancelText={t('Cancel')}
          >
            <Form form={publishForm} layout="vertical" initialValues={{ version: '', channel: 'stable' }}>
              <Form.Item name="version" label={t('Version')} rules={[{ required: true }]}>
                <Input placeholder="1.0.0" autoFocus />
              </Form.Item>
              <Form.Item name="channel" label={t('Channel')} rules={[{ required: true }]}>
                <Input placeholder="stable" />
              </Form.Item>
            </Form>
          </Modal>
          <Modal
            title={t('Resolve conflict')}
            open={Boolean(resolveCandidate)}
            onCancel={() => setResolveCandidate(null)}
            onOk={resolveConflict}
            okText={t('Save')}
            cancelText={t('Cancel')}
          >
            <Form form={resolveForm} layout="vertical" initialValues={{ namespace: '', slug: '' }}>
              <Form.Item name="namespace" label={t('Package namespace')} rules={[{ required: true }]}>
                <Input autoFocus />
              </Form.Item>
              <Form.Item name="slug" label={t('Package slug')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Form>
          </Modal>
        </>
      ) : null}
    </Space>
  );
}
