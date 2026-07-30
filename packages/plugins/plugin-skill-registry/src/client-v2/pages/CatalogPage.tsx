import React, { useState } from 'react';
import { Button, Card, Form, Input, Modal, Select, Space, Table, type TableColumnsType, Tag, Typography } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import { unwrapListMeta, unwrapRecords } from './api';

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
  const [packagePage, setPackagePage] = useState(1);
  const [candidatePage, setCandidatePage] = useState(1);
  const [packageSearch, setPackageSearch] = useState('');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [candidateStatus, setCandidateStatus] = useState<string>();
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Array<string | number>>([]);
  const [batchPublishOpen, setBatchPublishOpen] = useState(false);
  const pageSize = 50;
  const packagesRequest = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistryPackages:list',
        method: 'get',
        params: {
          appends: ['latestStableVersion'],
          page: packagePage,
          pageSize,
          filter: packageSearch
            ? {
                $or: [
                  { namespace: { $includes: packageSearch } },
                  { slug: { $includes: packageSearch } },
                  { displayName: { $includes: packageSearch } },
                ],
              }
            : undefined,
        },
      }),
    { refreshDeps: [packagePage, packageSearch] },
  );
  const candidatesRequest = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistrySourceItems:list',
        method: 'get',
        params: {
          sort: ['-updatedAt'],
          page: candidatePage,
          pageSize,
          filter: {
            ...(candidateStatus ? { state: candidateStatus } : {}),
            ...(candidateSearch
              ? {
                  $or: [
                    { displayName: { $includes: candidateSearch } },
                    { externalKey: { $includes: candidateSearch } },
                  ],
                }
              : {}),
          },
        },
      }),
    { refreshDeps: [candidatePage, candidateSearch, candidateStatus] },
  );
  const packages = unwrapRecords<RegistryPackage>(packagesRequest.data);
  const candidates = unwrapRecords<SourceItem>(candidatesRequest.data);
  const packageTotal = unwrapListMeta(packagesRequest.data)?.count ?? packages.length;
  const candidateTotal = unwrapListMeta(candidatesRequest.data)?.count ?? candidates.length;
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
      await ctx.api.request({
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

  const publishSelected = async () => {
    if (!canPublish || selectedCandidateIds.length === 0) return;
    try {
      const values = await publishForm.validateFields();
      const response = await ctx.api.request({
        url: 'skillRegistryAdmin:publishBatch',
        method: 'post',
        data: {
          sourceItemIds: selectedCandidateIds,
          version: values.version,
          channel: values.channel || 'stable',
        },
      });
      const body = response?.data?.data;
      const published = body && typeof body === 'object' && 'published' in body ? Number(body.published) : 0;
      const failed = body && typeof body === 'object' && 'failed' in body ? Number(body.failed) : 0;
      ctx.message.success(
        t('Batch publish completed: {{published}} published, {{failed}} failed', { published, failed }),
      );
      setBatchPublishOpen(false);
      setSelectedCandidateIds([]);
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
      await ctx.api.request({
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
        <Input.Search
          allowClear
          placeholder={t('Search catalog skills')}
          style={{ width: 360, marginBottom: 16 }}
          onSearch={(value) => {
            setPackagePage(1);
            setPackageSearch(value.trim());
          }}
        />
        <Table
          aria-label={t('Catalog')}
          rowKey="id"
          loading={packagesRequest.loading}
          pagination={{ current: packagePage, pageSize, total: packageTotal, onChange: setPackagePage }}
          scroll={{ x: 'max-content' }}
          dataSource={packages}
          locale={{ emptyText: t('No data') }}
          columns={packageColumns}
        />
      </Card>

      <Card title={t('Candidates')}>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            allowClear
            placeholder={t('Search candidates')}
            style={{ width: 320 }}
            onSearch={(value) => {
              setCandidatePage(1);
              setCandidateSearch(value.trim());
            }}
          />
          <Select
            allowClear
            placeholder={t('Filter by status')}
            style={{ width: 180 }}
            value={candidateStatus}
            onChange={(value) => {
              setCandidatePage(1);
              setCandidateStatus(value);
            }}
            options={['ready', 'published', 'conflict', 'blocked', 'error'].map((value) => ({ value, label: value }))}
          />
          {canPublish ? (
            <Button
              type="primary"
              disabled={selectedCandidateIds.length === 0}
              onClick={() => {
                publishForm.setFieldsValue({ version: '', channel: 'stable' });
                setBatchPublishOpen(true);
              }}
            >
              {t('Publish selected ({{count}})', { count: selectedCandidateIds.length })}
            </Button>
          ) : null}
        </Space>
        <Table
          aria-label={t('Candidates')}
          rowKey="id"
          loading={candidatesRequest.loading}
          pagination={{ current: candidatePage, pageSize, total: candidateTotal, onChange: setCandidatePage }}
          rowSelection={
            canPublish
              ? {
                  selectedRowKeys: selectedCandidateIds,
                  onChange: (keys) => setSelectedCandidateIds(keys),
                  getCheckboxProps: (record) => ({ disabled: !['ready', 'published'].includes(record.state) }),
                  preserveSelectedRowKeys: true,
                }
              : undefined
          }
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
            title={t('Publish selected skills')}
            open={batchPublishOpen}
            onCancel={() => setBatchPublishOpen(false)}
            onOk={publishSelected}
            okText={t('Publish selected')}
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
