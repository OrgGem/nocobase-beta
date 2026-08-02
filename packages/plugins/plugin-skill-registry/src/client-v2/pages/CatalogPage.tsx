import React, { useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  type TableColumnsType,
  Tag,
  Typography,
} from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import { unwrapListMeta, unwrapRecords } from './api';
import { VersionManagement, type RegistryPackageContext } from './VersionManagement';

type RegistryPackage = RegistryPackageContext & {
  visibility: string;
  updatedAt?: string;
};

type SourceItem = {
  id: string;
  displayName: string;
  state: string;
  sourceRevision: string;
  candidateDigest: string;
  updatedAt?: string;
  source?: { name?: string };
  package?: RegistryPackage;
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
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>();
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Array<string | number>>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<SourceItem[]>([]);
  const [batchPublishOpen, setBatchPublishOpen] = useState(false);
  const [unpublishCandidates, setUnpublishCandidates] = useState<SourceItem[]>([]);
  const [unpublishReason, setUnpublishReason] = useState('');
  const [unpublishing, setUnpublishing] = useState(false);
  const [versionsPackage, setVersionsPackage] = useState<RegistryPackage | null>(null);
  const pageSize = 50;
  const skillsRequest = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistrySourceItems:list',
        method: 'get',
        params: {
          appends: ['source', 'package', 'package.latestStableVersion'],
          sort: ['-updatedAt'],
          page,
          pageSize,
          filter: {
            ...(status ? { state: status } : {}),
            ...(search
              ? {
                  $or: [
                    { displayName: { $includes: search } },
                    { externalKey: { $includes: search } },
                    { 'package.namespace': { $includes: search } },
                    { 'package.slug': { $includes: search } },
                    { 'source.name': { $includes: search } },
                  ],
                }
              : {}),
          },
        },
      }),
    { refreshDeps: [page, search, status] },
  );
  const skills = unwrapRecords<SourceItem>(skillsRequest.data);
  const total = unwrapListMeta(skillsRequest.data)?.count ?? skills.length;
  const [publishCandidate, setPublishCandidate] = useState<SourceItem | null>(null);
  const [resolveCandidate, setResolveCandidate] = useState<SourceItem | null>(null);
  const [publishForm] = Form.useForm<PublishValues>();
  const [resolveForm] = Form.useForm<ResolveValues>();
  const candidateColumns: TableColumnsType<SourceItem> = [
    {
      title: t('Skill'),
      key: 'displayName',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.displayName}</Typography.Text>
          <Typography.Text type="secondary">
            {record.package ? `${record.package.namespace}/${record.package.slug}` : t('Not published')}
          </Typography.Text>
        </Space>
      ),
    },
    { title: t('Source'), key: 'source', render: (_, record) => record.source?.name || '\u2014' },
    { title: t('Status'), key: 'state', render: (_, record) => <Tag>{record.state}</Tag> },
    {
      title: t('Latest stable'),
      key: 'latestStable',
      render: (_, record) => record.package?.latestStableVersion?.version || '\u2014',
    },
    {
      title: t('Digest'),
      key: 'candidateDigest',
      render: (_, record) => <Typography.Text code>{`${record.candidateDigest.slice(0, 18)}\u2026`}</Typography.Text>,
    },
    { title: t('Updated'), key: 'updatedAt', render: (_, record) => record.updatedAt || '\u2014' },
  ];

  candidateColumns.push({
    title: t('Run'),
    key: 'actions',
    render: (_, record) => (
      <Space wrap>
        {record.package ? (
          <Button onClick={() => setVersionsPackage(record.package || null)}>{t('Manage versions')}</Button>
        ) : null}
        {canPublish ? (
          record.state === 'conflict' ? (
            <Button onClick={() => setResolveCandidate(record)}>{t('Resolve conflict')}</Button>
          ) : record.state === 'published' ? (
            <Button
              danger
              onClick={() => {
                setUnpublishReason('');
                setUnpublishCandidates([record]);
              }}
            >
              {t('Unpublish')}
            </Button>
          ) : (
            <Button
              disabled={record.state !== 'ready'}
              onClick={() => {
                publishForm.setFieldsValue({ version: '', channel: 'stable' });
                setPublishCandidate(record);
              }}
            >
              {t('Publish')}
            </Button>
          )
        ) : null}
      </Space>
    ),
  });

  const refresh = async () => {
    await skillsRequest.refreshAsync();
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

  const unpublish = async () => {
    if (!canPublish || unpublishCandidates.length === 0) return;
    setUnpublishing(true);
    try {
      if (unpublishCandidates.length === 1) {
        await ctx.api.request({
          url: 'skillRegistryAdmin:unpublish',
          method: 'post',
          data: { sourceItemId: unpublishCandidates[0].id, reason: unpublishReason.trim() || undefined },
        });
        ctx.message.success(t('Skill unpublished'));
      } else {
        const response = await ctx.api.request({
          url: 'skillRegistryAdmin:unpublishBatch',
          method: 'post',
          data: {
            sourceItemIds: unpublishCandidates.map((candidate) => candidate.id),
            reason: unpublishReason.trim() || undefined,
          },
        });
        const body = response?.data?.data;
        const unpublished = body && typeof body === 'object' && 'unpublished' in body ? Number(body.unpublished) : 0;
        const failed = body && typeof body === 'object' && 'failed' in body ? Number(body.failed) : 0;
        ctx.message.success(
          t('Batch unpublish completed: {{unpublished}} unpublished, {{failed}} failed', { unpublished, failed }),
        );
      }
      setUnpublishCandidates([]);
      setSelectedCandidateIds([]);
      setSelectedCandidates([]);
      await refresh();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setUnpublishing(false);
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
        title={t('Skills')}
        extra={
          <Button onClick={refresh} loading={skillsRequest.loading}>
            {t('Refresh')}
          </Button>
        }
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            allowClear
            placeholder={t('Search skills')}
            style={{ width: 320 }}
            onSearch={(value) => {
              setPage(1);
              setSearch(value.trim());
            }}
          />
          <Select
            allowClear
            placeholder={t('Filter by status')}
            style={{ width: 180 }}
            value={status}
            onChange={(value) => {
              setPage(1);
              setStatus(value);
            }}
            options={['discovered', 'ready', 'published', 'conflict', 'blocked', 'error'].map((value) => ({
              value,
              label: value,
            }))}
          />
          {canPublish ? (
            <>
              <Button
                type="primary"
                disabled={selectedCandidates.filter((candidate) => candidate.state === 'ready').length === 0}
                onClick={() => {
                  const readyCandidates = selectedCandidates.filter((candidate) => candidate.state === 'ready');
                  setSelectedCandidateIds(readyCandidates.map((candidate) => candidate.id));
                  publishForm.setFieldsValue({ version: '', channel: 'stable' });
                  setBatchPublishOpen(true);
                }}
              >
                {t('Publish selected ({{count}})', {
                  count: selectedCandidates.filter((candidate) => candidate.state === 'ready').length,
                })}
              </Button>
              <Button
                danger
                disabled={selectedCandidates.filter((candidate) => candidate.state === 'published').length === 0}
                onClick={() => {
                  setUnpublishReason('');
                  setUnpublishCandidates(selectedCandidates.filter((candidate) => candidate.state === 'published'));
                }}
              >
                {t('Unpublish selected ({{count}})', {
                  count: selectedCandidates.filter((candidate) => candidate.state === 'published').length,
                })}
              </Button>
            </>
          ) : null}
        </Space>
        <Table
          aria-label={t('Skills')}
          rowKey="id"
          loading={skillsRequest.loading}
          pagination={{ current: page, pageSize, total, onChange: setPage }}
          rowSelection={
            canPublish
              ? {
                  selectedRowKeys: selectedCandidateIds,
                  onChange: (keys, rows) => {
                    setSelectedCandidateIds(keys);
                    setSelectedCandidates(rows);
                  },
                  getCheckboxProps: (record) => ({ disabled: !['ready', 'published'].includes(record.state) }),
                }
              : undefined
          }
          scroll={{ x: 'max-content' }}
          dataSource={skills}
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
            title={unpublishCandidates.length > 1 ? t('Unpublish selected skills') : t('Unpublish skill')}
            open={unpublishCandidates.length > 0}
            onCancel={() => setUnpublishCandidates([])}
            onOk={unpublish}
            okText={t('Unpublish')}
            okButtonProps={{ danger: true, loading: unpublishing }}
            cancelText={t('Cancel')}
          >
            <Typography.Paragraph>
              {t(
                'All published versions of the selected skills will be yanked and removed from the public catalog. Version history and artifacts are retained.',
              )}
            </Typography.Paragraph>
            <Input.TextArea
              aria-label={t('Unpublish reason')}
              placeholder={t('Unpublish reason (optional)')}
              value={unpublishReason}
              maxLength={2000}
              rows={3}
              onChange={(event) => setUnpublishReason(event.target.value)}
            />
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
      <Drawer
        title={t('Manage versions')}
        width="min(1200px, 95vw)"
        open={Boolean(versionsPackage)}
        onClose={() => setVersionsPackage(null)}
        destroyOnClose
      >
        {versionsPackage ? <VersionManagement packageRecord={versionsPackage} /> : null}
      </Drawer>
    </Space>
  );
}
