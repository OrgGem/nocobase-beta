import React, { useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import { unwrapData, unwrapListMeta, unwrapRecords } from './api';

export type RegistryPackageContext = {
  id: string;
  namespace: string;
  slug: string;
  displayName: string;
  description?: string;
  status: string;
  latestStableVersionId?: string;
  latestStableVersion?: { id?: string; version?: string; runtime?: string; compatibility?: Record<string, unknown> };
};

type RegistryVersion = {
  id: string;
  packageId: string;
  sourceItemId: string;
  version: string;
  channel: string;
  status: string;
  runtime: string;
  compatibility?: Record<string, unknown>;
  changelog?: string;
  artifactDigest: string;
  publishedAt?: string;
  yankedAt?: string;
  yankReason?: string;
  package?: RegistryPackageContext;
  sourceItem?: { displayName?: string; sourceRevision?: string; source?: { name?: string } };
  artifact?: { verificationStatus?: string };
  publishedBy?: { nickname?: string; username?: string };
};

type InstallationState = {
  installationId: string;
  registryVersionId: string;
  version: string;
  updatePolicy: 'pinned' | 'channel';
  status: string;
  installedAt: string | null;
};

type YankImpact = {
  packageIdentity: string;
  version: string;
  isLatestStable: boolean;
  replacementVersion: string | null;
  packageWillBecomeDraft: boolean;
};

function compactJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return '—';
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}: ${String(item)}`)
    .join(', ');
}

export function VersionManagement({
  packageRecord,
  auditMode = false,
}: {
  packageRecord?: RegistryPackageContext;
  auditMode?: boolean;
}) {
  const ctx = useFlowContext();
  const t = useT();
  const { canInstall, canPublish } = useSkillRegistryPermissions();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>();
  const [channel, setChannel] = useState<string>();
  const [installVersion, setInstallVersion] = useState<RegistryVersion | null>(null);
  const [updatePolicy, setUpdatePolicy] = useState<'pinned' | 'channel'>('pinned');
  const [installing, setInstalling] = useState(false);
  const [yankVersion, setYankVersion] = useState<RegistryVersion | null>(null);
  const [yankImpact, setYankImpact] = useState<YankImpact | null>(null);
  const [yankReason, setYankReason] = useState('');
  const [yanking, setYanking] = useState(false);
  const pageSize = 20;
  const request = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistryVersions:list',
        method: 'get',
        params: {
          appends: ['package', 'sourceItem', 'sourceItem.source', 'artifact', 'publishedBy'],
          sort: ['-publishedAt', '-id'],
          page,
          pageSize,
          filter: {
            ...(packageRecord ? { packageId: packageRecord.id } : {}),
            ...(status ? { status } : {}),
            ...(channel ? { channel } : {}),
            ...(search
              ? auditMode
                ? {
                    $or: [
                      { version: { $includes: search } },
                      { 'package.namespace': { $includes: search } },
                      { 'package.slug': { $includes: search } },
                      { 'package.displayName': { $includes: search } },
                    ],
                  }
                : { version: { $includes: search } }
              : {}),
          },
        },
      }),
    { refreshDeps: [packageRecord?.id, page, search, status, channel] },
  );
  const versions = unwrapRecords<RegistryVersion>(request.data);
  const total = unwrapListMeta(request.data)?.count ?? versions.length;
  const versionIds = versions.map((version) => version.id);
  const installationRequest = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistryAdmin:installationStates',
        method: 'get',
        params: { versionIds },
      }),
    { ready: versionIds.length > 0, refreshDeps: [versionIds.join(',')] },
  );
  const installationBody = unwrapData<{ states?: InstallationState[] }>(installationRequest.data);
  const installations = new Map(
    (installationBody?.states || []).map((installation) => [installation.registryVersionId, installation]),
  );

  const refresh = async () => {
    await request.refreshAsync();
    if (versionIds.length > 0) await installationRequest.refreshAsync();
  };

  const install = async () => {
    if (!installVersion || !canInstall) return;
    setInstalling(true);
    try {
      await ctx.api.request({
        url: 'skillRegistryAdmin:install',
        method: 'post',
        data: { versionId: installVersion.id, updatePolicy },
      });
      ctx.message.success(t('Version installed'));
      setInstallVersion(null);
      await refresh();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setInstalling(false);
    }
  };

  const openYank = async (version: RegistryVersion) => {
    try {
      const response = await ctx.api.request({
        url: 'skillRegistryAdmin:yankImpact',
        method: 'get',
        params: { versionId: version.id },
      });
      setYankImpact(unwrapData<YankImpact>(response));
      setYankReason('');
      setYankVersion(version);
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  const yank = async () => {
    if (!yankVersion || !canPublish || !yankReason.trim()) return;
    setYanking(true);
    try {
      await ctx.api.request({
        url: 'skillRegistryAdmin:yank',
        method: 'post',
        data: { versionId: yankVersion.id, reason: yankReason.trim() },
      });
      ctx.message.success(t('Version yanked'));
      setYankVersion(null);
      setYankImpact(null);
      await refresh();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setYanking(false);
    }
  };

  const columns: TableColumnsType<RegistryVersion> = [];
  if (auditMode) {
    columns.push({
      title: t('Skill'),
      key: 'skill',
      render: (_, record) => {
        const currentPackage = record.package;
        return currentPackage ? (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{currentPackage.displayName}</Typography.Text>
            <Typography.Text type="secondary">{`${currentPackage.namespace}/${currentPackage.slug}`}</Typography.Text>
          </Space>
        ) : (
          '—'
        );
      },
    });
  }
  columns.push(
    {
      title: t('Version'),
      key: 'version',
      render: (_, record) => {
        const currentPackage = packageRecord || record.package;
        const latestId = currentPackage?.latestStableVersionId || currentPackage?.latestStableVersion?.id;
        return (
          <Space>
            <Typography.Text code>{record.version}</Typography.Text>
            {String(latestId || '') === String(record.id) ? <Tag color="blue">{t('Latest stable')}</Tag> : null}
          </Space>
        );
      },
    },
    { title: t('Channel'), key: 'channel', render: (_, record) => <Tag>{record.channel}</Tag> },
    { title: t('Status'), key: 'status', render: (_, record) => <Tag>{record.status}</Tag> },
    { title: t('Runtime'), key: 'runtime', render: (_, record) => record.runtime || '—' },
    {
      title: t('Compatibility'),
      key: 'compatibility',
      render: (_, record) => compactJson(record.compatibility),
    },
    {
      title: t('Artifact'),
      key: 'artifact',
      render: (_, record) => (
        <Tag color={record.artifact?.verificationStatus === 'verified' ? 'green' : 'red'}>
          {record.artifact?.verificationStatus || 'unknown'}
        </Tag>
      ),
    },
    {
      title: t('Installation'),
      key: 'installation',
      render: (_, record) => {
        const installation = installations.get(String(record.id));
        return installation ? (
          <Tag color={installation.status === 'installed' ? 'green' : 'default'}>{installation.status}</Tag>
        ) : (
          t('Not installed')
        );
      },
    },
    {
      title: t('Source'),
      key: 'source',
      render: (_, record) => record.sourceItem?.source?.name || record.sourceItem?.displayName || '—',
    },
    { title: t('Published'), key: 'publishedAt', render: (_, record) => record.publishedAt || '—' },
  );

  if (canInstall || canPublish) {
    columns.push({
      title: t('Run'),
      key: 'actions',
      render: (_, record) => {
        const installation = installations.get(String(record.id));
        const installable =
          record.status === 'published' &&
          record.runtime !== 'instruction' &&
          record.artifact?.verificationStatus === 'verified' &&
          installation?.status !== 'installed';
        return (
          <Space>
            {canInstall ? (
              <Button
                disabled={!installable}
                onClick={() => {
                  setUpdatePolicy('pinned');
                  setInstallVersion(record);
                }}
              >
                {installation?.status === 'installed' ? t('Installed') : t('Install')}
              </Button>
            ) : null}
            {canPublish ? (
              <Button danger disabled={record.status !== 'published'} onClick={() => openYank(record)}>
                {t('Yank')}
              </Button>
            ) : null}
          </Space>
        );
      },
    });
  }

  return (
    <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
      {packageRecord ? (
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label={t('Skill')}>{packageRecord.displayName}</Descriptions.Item>
          <Descriptions.Item
            label={t('Package')}
          >{`${packageRecord.namespace}/${packageRecord.slug}`}</Descriptions.Item>
          <Descriptions.Item label={t('Status')}>{packageRecord.status}</Descriptions.Item>
          <Descriptions.Item label={t('Latest stable')}>
            {packageRecord.latestStableVersion?.version || '—'}
          </Descriptions.Item>
          <Descriptions.Item label={t('Description')} span={2}>
            {packageRecord.description || '—'}
          </Descriptions.Item>
        </Descriptions>
      ) : null}
      <Space wrap>
        <Input.Search
          allowClear
          placeholder={auditMode ? t('Search skill or version') : t('Search versions')}
          style={{ width: 300 }}
          onSearch={(value) => {
            setPage(1);
            setSearch(value.trim());
          }}
        />
        <Select
          allowClear
          placeholder={t('Filter by status')}
          style={{ width: 160 }}
          value={status}
          options={['published', 'yanked'].map((value) => ({ value, label: value }))}
          onChange={(value) => {
            setPage(1);
            setStatus(value);
          }}
        />
        <Input
          allowClear
          placeholder={t('Filter by channel')}
          style={{ width: 180 }}
          value={channel}
          onChange={(event) => {
            setPage(1);
            setChannel(event.target.value.trim() || undefined);
          }}
        />
        <Button onClick={() => refresh()} loading={request.loading || installationRequest.loading}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table
        aria-label={auditMode ? t('Version audit') : t('Versions')}
        rowKey="id"
        loading={request.loading || installationRequest.loading}
        dataSource={versions}
        columns={columns}
        pagination={{ current: page, pageSize, total, onChange: setPage }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
      />
      <Modal
        title={t('Install version')}
        open={Boolean(installVersion)}
        onCancel={() => setInstallVersion(null)}
        onOk={install}
        okText={t('Install')}
        okButtonProps={{ loading: installing }}
        cancelText={t('Cancel')}
      >
        {installVersion ? (
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label={t('Skill')}>
              {installVersion.package?.displayName || packageRecord?.displayName}
            </Descriptions.Item>
            <Descriptions.Item label={t('Version')}>{installVersion.version}</Descriptions.Item>
            <Descriptions.Item label={t('Runtime')}>{installVersion.runtime}</Descriptions.Item>
            <Descriptions.Item label={t('Compatibility')}>
              {compactJson(installVersion.compatibility)}
            </Descriptions.Item>
            <Descriptions.Item label={t('Artifact')}>{installVersion.artifact?.verificationStatus}</Descriptions.Item>
          </Descriptions>
        ) : null}
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label={t('Update policy')}>
            <Select
              value={updatePolicy}
              style={{ width: '100%' }}
              options={[
                { value: 'pinned', label: t('Pinned to this version') },
                { value: 'channel', label: t('Follow this channel') },
              ]}
              onChange={setUpdatePolicy}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('Yank version')}
        open={Boolean(yankVersion)}
        onCancel={() => {
          setYankVersion(null);
          setYankImpact(null);
        }}
        onOk={yank}
        okText={t('Yank')}
        okButtonProps={{ danger: true, loading: yanking, disabled: !yankReason.trim() }}
        cancelText={t('Cancel')}
      >
        {yankImpact ? (
          <Alert
            type="warning"
            showIcon
            message={t('Yank {{package}}@{{version}}?', {
              package: yankImpact.packageIdentity,
              version: yankImpact.version,
            })}
            description={
              yankImpact.packageWillBecomeDraft
                ? t(
                    'This is the final published version. The skill will be removed from the public Catalog and the package will return to draft.',
                  )
                : yankImpact.isLatestStable
                  ? t('This is the latest stable version. It will be replaced by {{version}}.', {
                      version: yankImpact.replacementVersion || '—',
                    })
                  : t(
                      'This version will no longer be downloadable or installable. Immutable history and artifacts are retained.',
                    )
            }
          />
        ) : null}
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label={t('Yank reason')} required>
            <Input.TextArea
              aria-label={t('Yank reason')}
              value={yankReason}
              maxLength={2000}
              rows={3}
              onChange={(event) => setYankReason(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
