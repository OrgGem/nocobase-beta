import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Modal, Space, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { useLocation } from 'react-router-dom';
import { registryApi } from '../api';
import { useT } from '../locale';
import type { RegistryRepositoryDeleteImpact, RegistryTagSummary } from '../../shared/types';
import { DockerCommand } from '../components/DockerCommand';
import { DownloadImageButton, UploadImageButton } from '../components/ImageTransferControls';
import { type DockerRegistryPageProps, useDockerRegistryPermissions } from '../permissions';
import { dockerArchiveFilename, externalImageReference } from '../registry-access';
import { DOCKER_REGISTRY_IMAGES_PATH } from '../../shared/routes';

interface TagRow {
  key: string;
  tag: string;
  summary?: RegistryTagSummary;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(2)} ${units[index]}`;
}

export default function RepositoryPage({ permissions }: DockerRegistryPageProps) {
  const ctx = useFlowContext();
  const location = useLocation();
  const t = useT();
  const aclPermissions = useDockerRegistryPermissions();
  const { canDelete, canDownload, canRead, canUpload } = permissions ?? aclPermissions;
  const [modal, modalContextHolder] = Modal.useModal();
  const repository = new URLSearchParams(location.search).get('name') ?? '';
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<TagRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [deletingTag, setDeletingTag] = useState<string>();
  const [repositoryDeleteImpact, setRepositoryDeleteImpact] = useState<RegistryRepositoryDeleteImpact>();
  const [repositoryDeleteOpen, setRepositoryDeleteOpen] = useState(false);
  const [repositoryDeleteConfirmation, setRepositoryDeleteConfirmation] = useState('');
  const [deletingRepository, setDeletingRepository] = useState(false);
  const { data: settings } = useRequest(() => registryApi.getPublicSettings(ctx), { ready: canRead });
  const firstRow = rows.at(0);
  const externalReference = firstRow
    ? externalImageReference(settings?.publicRegistryHost, repository, firstRow.tag)
    : undefined;
  const {
    run: load,
    loading,
    error,
  } = useRequest(
    async (cursor?: string, append = false) => {
      const response = await registryApi.listTags(ctx, repository, cursor, search);
      const summaryByTag = new Map((response.summaries ?? []).map((summary) => [summary.tag, summary]));
      const items = Array.isArray(response.items) ? response.items : [];
      const values = items.map((tag) => ({ key: tag, tag, summary: summaryByTag.get(tag) }));
      setRows((previous) => (append ? [...previous, ...values] : values));
      setNextCursor(response.nextCursor);
    },
    { manual: true },
  );
  useEffect(() => {
    if (canRead && repository) load();
  }, [canRead, load, repository]);

  const deleteConfirmedTag = async (tag: string, digest: string, shared: boolean) => {
    setDeletingTag(tag);
    try {
      const result = await registryApi.deleteTag(ctx, repository, tag, digest, shared);
      ctx.message.success(t('Manifest deleted. Affected tags: {{tags}}', { tags: result.tags.join(', ') }));
      await load();
    } catch (deleteError) {
      ctx.message.error(deleteError instanceof Error ? deleteError.message : t('Unable to delete tag'));
      throw deleteError;
    } finally {
      setDeletingTag(undefined);
    }
  };

  const handleDelete = async (tag: string) => {
    setDeletingTag(tag);
    try {
      const impact = await registryApi.getDeleteImpact(ctx, repository, tag);
      const shared = impact.tags.length > 1;
      modal.confirm({
        title: shared ? t('Shared manifest deletion') : t('Delete image manifest?'),
        content: (
          <Space direction="vertical">
            <Typography.Text>
              {t('Docker Distribution cannot detach only one tag; it deletes the manifest by digest.')}
            </Typography.Text>
            <Typography.Text code>{impact.digest}</Typography.Text>
            <Alert
              type={shared ? 'error' : 'warning'}
              showIcon
              message={t('Deleting this digest affects all of these tags:')}
              description={impact.tags.join(', ')}
            />
          </Space>
        ),
        okText: t('Delete manifest'),
        okButtonProps: { danger: true },
        cancelText: t('Cancel'),
        onOk: () => deleteConfirmedTag(tag, impact.digest, shared),
      });
    } catch (deleteError) {
      ctx.message.error(deleteError instanceof Error ? deleteError.message : t('Unable to inspect delete impact'));
    } finally {
      setDeletingTag(undefined);
    }
  };

  const inspectRepositoryDelete = async () => {
    setDeletingRepository(true);
    try {
      const impact = await registryApi.getRepositoryDeleteImpact(ctx, repository);
      setRepositoryDeleteImpact(impact);
      setRepositoryDeleteConfirmation('');
      setRepositoryDeleteOpen(true);
    } catch (deleteError) {
      ctx.message.error(
        deleteError instanceof Error ? deleteError.message : t('Unable to inspect repository contents'),
      );
    } finally {
      setDeletingRepository(false);
    }
  };

  const deleteRepositoryContents = async () => {
    if (!repositoryDeleteImpact || repositoryDeleteConfirmation !== repository) return;
    setDeletingRepository(true);
    try {
      const result = await registryApi.deleteRepositoryContents(
        ctx,
        repository,
        repositoryDeleteImpact.signature,
        true,
      );
      ctx.message.success(
        t('Deleted {{manifests}} manifests and {{tags}} tags.', {
          manifests: result.deletedDigests.length,
          tags: result.tags.length,
        }),
      );
      setRepositoryDeleteOpen(false);
      ctx.router.navigate(DOCKER_REGISTRY_IMAGES_PATH);
    } catch (deleteError) {
      ctx.message.error(deleteError instanceof Error ? deleteError.message : t('Unable to delete repository contents'));
    } finally {
      setDeletingRepository(false);
    }
  };

  const tagColumns: TableColumnsType<TagRow> = [
    { title: t('Tag'), dataIndex: 'tag', width: 180, render: (tag: string) => <Tag>{tag}</Tag> },
    {
      title: t('Digest'),
      key: 'digest',
      width: 220,
      render: (_, row) =>
        row.summary?.digest ? <Typography.Text code>{row.summary.digest.slice(0, 20)}...</Typography.Text> : '-',
    },
    { title: t('Size'), key: 'size', width: 120, render: (_, row) => formatBytes(row.summary?.size) },
    {
      title: t('Image metadata'),
      key: 'metadata',
      width: 260,
      render: (_, row) =>
        row.summary?.error ||
        [
          row.summary?.os,
          row.summary?.architecture,
          row.summary?.layerCount != null ? `${row.summary.layerCount} ${t('Layers')}` : undefined,
          row.summary?.platformCount != null ? `${row.summary.platformCount} ${t('Platforms')}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ') ||
        '-',
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 360,
      render: (_, row) => (
        <Space>
          <Button
            type="link"
            onClick={() =>
              ctx.router.navigate(
                `${DOCKER_REGISTRY_IMAGES_PATH}?name=${encodeURIComponent(repository)}&tag=${encodeURIComponent(
                  row.tag,
                )}`,
              )
            }
          >
            {t('Inspect')}
          </Button>
          {canDelete && settings?.deleteEnabled && (
            <Button
              danger
              type="link"
              loading={deletingTag === row.tag}
              icon={<DeleteOutlined />}
              onClick={() => handleDelete(row.tag)}
            >
              {t('Delete manifest')}
            </Button>
          )}
          {canDownload && <DownloadImageButton repository={repository} reference={row.tag} />}
        </Space>
      ),
    },
  ];

  if (!canRead) {
    return <Alert type="error" showIcon message={t('You do not have permission to browse this Registry.')} />;
  }

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex', maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      {modalContextHolder}
      <Modal
        open={repositoryDeleteOpen}
        title={t('Delete all repository contents?')}
        okText={t('Delete repository contents')}
        okButtonProps={{
          danger: true,
          disabled:
            repositoryDeleteConfirmation !== repository ||
            !repositoryDeleteImpact?.signature ||
            Boolean(repositoryDeleteImpact?.unresolvedTags.length),
        }}
        confirmLoading={deletingRepository}
        onOk={deleteRepositoryContents}
        onCancel={() => setRepositoryDeleteOpen(false)}
        destroyOnHidden
      >
        {repositoryDeleteImpact && (
          <Space direction="vertical" style={{ display: 'flex' }}>
            <Alert
              type="error"
              showIcon
              message={t('This removes every tagged manifest in the repository.')}
              description={t(
                'Registry v2/v3 has no portable delete-repository endpoint. The plugin deletes each unique manifest digest; the catalog entry may remain until registry cleanup.',
              )}
            />
            <Typography.Text>
              {t('{{tags}} tags reference {{manifests}} unique manifests.', {
                tags: repositoryDeleteImpact.tags.length,
                manifests: repositoryDeleteImpact.manifests.length,
              })}
            </Typography.Text>
            {repositoryDeleteImpact.unresolvedTags.length > 0 && (
              <Alert
                type="error"
                showIcon
                message={t('Deletion is blocked because these tags could not be resolved:')}
                description={repositoryDeleteImpact.unresolvedTags.join(', ')}
              />
            )}
            <Typography.Text>
              {t('Type the repository name to confirm: {{repository}}', { repository })}
            </Typography.Text>
            <Input
              aria-label={t('Repository deletion confirmation')}
              value={repositoryDeleteConfirmation}
              onChange={(event) => setRepositoryDeleteConfirmation(event.target.value)}
            />
          </Space>
        )}
      </Modal>
      <Space>
        <Button icon={<ArrowLeftOutlined />} onClick={() => ctx.router.navigate(DOCKER_REGISTRY_IMAGES_PATH)}>
          {t('Back')}
        </Button>
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {repository || t('Repository')}
          </Typography.Title>
          <Typography.Text type="secondary">{t('Tags in this repository')}</Typography.Text>
        </div>
        {canUpload && (
          <UploadImageButton
            initialRepository={repository}
            maxTransferSizeMb={settings?.maxTransferSizeMb}
            onUploaded={() => load()}
          />
        )}
        {canDelete && settings?.deleteEnabled && (
          <Button danger icon={<DeleteOutlined />} loading={deletingRepository} onClick={inspectRepositoryDelete}>
            {t('Delete repository contents')}
          </Button>
        )}
      </Space>
      {!repository && <Alert type="error" message={t('Repository is required')} />}
      {error && <Alert type="error" showIcon message={t('Unable to load tags')} description={error.message} />}
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Input
            aria-label={t('Search tags')}
            prefix={<SearchOutlined />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onPressEnter={() => load()}
            placeholder={t('Search tags')}
            style={{ maxWidth: 360 }}
          />
          <Button loading={loading} onClick={() => load()}>
            {t('Refresh')}
          </Button>
        </Space>
        <Table
          style={{ marginTop: 16 }}
          loading={loading}
          pagination={false}
          scroll={{ x: 980 }}
          dataSource={rows}
          columns={tagColumns}
        />
        {nextCursor && (
          <Button style={{ marginTop: 16 }} block loading={loading} onClick={() => load(nextCursor, true)}>
            {t('Load more')}
          </Button>
        )}
      </Card>
      {firstRow &&
        (externalReference ? (
          <Card title={t('Pull command')}>
            <DockerCommand command={`docker pull ${externalReference}`} />
          </Card>
        ) : (
          <Card title={t('Private Registry access')}>
            <Alert
              type="success"
              showIcon
              message={t('Private Registry mode')}
              description={t('Download a Docker save tar from this page, then load it into the local Docker daemon.')}
              style={{ marginBottom: 16 }}
            />
            <DockerCommand command={`docker load -i ${dockerArchiveFilename(repository, firstRow.tag)}`} />
          </Card>
        ))}
    </Space>
  );
}
