import React from 'react';
import { Alert, Button, Card, Descriptions, Space, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { useLocation } from 'react-router-dom';
import type { Descriptor } from '../../shared/types';
import { registryApi } from '../api';
import { DockerCommand } from '../components/DockerCommand';
import { useT } from '../locale';
import { type DockerRegistryPageProps, useDockerRegistryPermissions } from '../permissions';
import { dockerArchiveFilename, externalImageReference } from '../registry-access';
import { DOCKER_REGISTRY_IMAGES_PATH } from '../../shared/routes';

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(2)} ${units[index]}`;
}

function configValue(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringEntries(value: unknown): Array<{ key: string; value: string }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, entry]) => ({
    key,
    value: typeof entry === 'string' ? entry : JSON.stringify(entry),
  }));
}

function maskEnvironment(value: string): string {
  return /(?:password|token|secret|api[_-]?key|private[_-]?key)/i.test(value.split('=', 1)[0])
    ? `${value.split('=', 1)[0]}=••••••••`
    : value;
}

function historyEntries(value: unknown): Array<{ key: string; created?: string; command: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      return {
        key: String(index),
        created: typeof record.created === 'string' ? record.created : undefined,
        command: typeof record.created_by === 'string' ? record.created_by : JSON.stringify(record),
      };
    }
    return { key: String(index), command: String(entry) };
  });
}

interface LabelRow {
  key: string;
  value: string;
}

interface HistoryRow {
  key: string;
  created?: string;
  command: string;
}

export default function ImageDetailsPage({ permissions }: DockerRegistryPageProps) {
  const ctx = useFlowContext();
  const location = useLocation();
  const t = useT();
  const aclPermissions = useDockerRegistryPermissions();
  const { canRead } = permissions ?? aclPermissions;
  const params = new URLSearchParams(location.search);
  const repository = params.get('name') ?? '';
  const reference = params.get('tag') ?? '';
  const { data: settings } = useRequest(() => registryApi.getPublicSettings(ctx), { ready: canRead });
  const {
    data: manifest,
    loading,
    error,
  } = useRequest(() => registryApi.getImageDetails(ctx, repository, reference), {
    ready: Boolean(canRead && repository && reference),
  });
  const imageReference = externalImageReference(settings?.publicRegistryHost, repository, reference);
  const config =
    manifest?.kind === 'image' &&
    manifest.configData &&
    typeof manifest.configData.config === 'object' &&
    manifest.configData.config !== null
      ? (manifest.configData.config as Record<string, unknown>)
      : undefined;
  const environment = stringList(config?.Env).map(maskEnvironment);
  const labels = stringEntries(config?.Labels);
  const ports = stringEntries(config?.ExposedPorts).map((entry) => entry.key);
  const history = manifest?.kind === 'image' ? historyEntries(manifest.configData?.history) : [];
  const labelColumns: TableColumnsType<LabelRow> = [
    { title: t('Key'), dataIndex: 'key', width: 220 },
    {
      title: t('Value'),
      dataIndex: 'value',
      width: 380,
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
  ];
  const layerColumns: TableColumnsType<Descriptor> = [
    {
      title: t('Digest'),
      dataIndex: 'digest',
      width: 420,
      render: (digest: string) => <Typography.Text code>{digest}</Typography.Text>,
    },
    { title: t('Media type'), dataIndex: 'mediaType', width: 240 },
    { title: t('Size'), dataIndex: 'size', width: 120, render: (size?: number) => formatBytes(size ?? 0) },
  ];
  const historyColumns: TableColumnsType<HistoryRow> = [
    { title: t('Created'), dataIndex: 'created', width: 200 },
    { title: t('History entry'), dataIndex: 'command', width: 480 },
  ];
  const platformColumns: TableColumnsType<Descriptor> = [
    { title: t('OS'), key: 'platformOs', width: 120, render: (_, item) => item.platform?.os ?? '-' },
    {
      title: t('Architecture'),
      key: 'platformArchitecture',
      width: 160,
      render: (_, item) => [item.platform?.architecture, item.platform?.variant].filter(Boolean).join('/') || '-',
    },
    {
      title: t('Digest'),
      key: 'platformDigest',
      width: 420,
      render: (_, item) => <Typography.Text code>{item.digest}</Typography.Text>,
    },
    {
      title: t('Size'),
      key: 'platformSize',
      width: 120,
      render: (_, item) => formatBytes(item.size ?? 0),
    },
    {
      title: t('Actions'),
      key: 'platformActions',
      width: 120,
      render: (_, item) => (
        <Button
          type="link"
          onClick={() =>
            ctx.router.navigate(
              `${DOCKER_REGISTRY_IMAGES_PATH}?name=${encodeURIComponent(repository)}&tag=${encodeURIComponent(
                item.digest,
              )}`,
            )
          }
        >
          {t('Inspect')}
        </Button>
      ),
    },
  ];
  const referrerColumns: TableColumnsType<Descriptor> = [
    {
      title: t('Artifact type'),
      dataIndex: 'artifactType',
      width: 220,
      render: (value?: string) => value ?? '-',
    },
    {
      title: t('Media type'),
      key: 'referrerMediaType',
      width: 240,
      render: (_, item) => item.mediaType ?? '-',
    },
    {
      title: t('Digest'),
      key: 'referrerDigest',
      width: 420,
      render: (_, item) => <Typography.Text code>{item.digest}</Typography.Text>,
    },
    {
      title: t('Size'),
      key: 'referrerSize',
      width: 120,
      render: (_, item) => formatBytes(item.size ?? 0),
    },
  ];

  if (!canRead) {
    return <Alert type="error" showIcon message={t('You do not have permission to browse this Registry.')} />;
  }

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex', maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <Space>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => ctx.router.navigate(`${DOCKER_REGISTRY_IMAGES_PATH}?name=${encodeURIComponent(repository)}`)}
        >
          {t('Back')}
        </Button>
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {repository}:{reference}
          </Typography.Title>
          <Typography.Text type="secondary">{t('Image details')}</Typography.Text>
        </div>
      </Space>
      {error && <Alert type="error" showIcon message={t('Unable to load image details')} description={error.message} />}
      {!repository || !reference ? <Alert type="error" message={t('Repository and reference are required')} /> : null}
      {manifest?.kind === 'image' && (
        <>
          <Card loading={loading} title={t('Summary')}>
            <Descriptions column={{ xs: 1, sm: 2 }}>
              <Descriptions.Item label={t('Manifest digest')}>
                <Typography.Text code>{manifest.digest}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('Media type')}>
                <Typography.Text code>{manifest.mediaType}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('Size')}>{formatBytes(manifest.size)}</Descriptions.Item>
              <Descriptions.Item label={t('Layers')}>{manifest.layers.length}</Descriptions.Item>
              <Descriptions.Item label={t('OS')}>{manifest.os ?? '-'}</Descriptions.Item>
              <Descriptions.Item label={t('Architecture')}>{manifest.architecture ?? '-'}</Descriptions.Item>
              <Descriptions.Item label={t('Created')}>
                {manifest.created ? new Date(manifest.created).toLocaleString() : '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Config digest')}>
                <Typography.Text code>{manifest.config?.digest ?? '-'}</Typography.Text>
              </Descriptions.Item>
            </Descriptions>
          </Card>
          {imageReference ? (
            <Card title={t('Docker commands')}>
              <Space direction="vertical" style={{ display: 'flex' }}>
                <DockerCommand command={`docker pull ${imageReference}`} />
                <DockerCommand command={`docker run ${imageReference}`} />
              </Space>
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
              <DockerCommand command={`docker load -i ${dockerArchiveFilename(repository, reference)}`} />
            </Card>
          )}
          <Card title={t('Image configuration')}>
            <Descriptions column={{ xs: 1, sm: 2 }}>
              <Descriptions.Item label={t('User')}>{configValue(config, 'User') ?? '-'}</Descriptions.Item>
              <Descriptions.Item label={t('Working directory')}>
                {configValue(config, 'WorkingDir') ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Entrypoint')}>
                <Typography.Text code>{JSON.stringify(config?.Entrypoint ?? [])}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('Command')}>
                <Typography.Text code>{JSON.stringify(config?.Cmd ?? [])}</Typography.Text>
              </Descriptions.Item>
            </Descriptions>
          </Card>
          <Card title={t('Environment variables')}>
            {environment.length ? (
              <Typography.Paragraph>
                <pre style={{ maxHeight: 280, overflow: 'auto' }}>{environment.join('\n')}</pre>
              </Typography.Paragraph>
            ) : (
              <Typography.Text type="secondary">{t('No environment variables')}</Typography.Text>
            )}
          </Card>
          <Card title={t('Labels')}>
            {labels.length ? (
              <Table pagination={false} rowKey="key" scroll={{ x: 600 }} dataSource={labels} columns={labelColumns} />
            ) : (
              <Typography.Text type="secondary">{t('No labels')}</Typography.Text>
            )}
          </Card>
          <Card title={t('Exposed ports')}>
            {ports.length ? (
              <Space wrap>
                {(Array.isArray(ports) ? ports : []).map((port) => (
                  <Tag key={port}>{port}</Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">{t('No exposed ports')}</Typography.Text>
            )}
          </Card>
          <Card title={t('Layers')}>
            <Table
              pagination={false}
              rowKey="digest"
              scroll={{ x: 760 }}
              dataSource={manifest.layers}
              columns={layerColumns}
            />
          </Card>
          <Card title={t('Image history')}>
            {history.length ? (
              <Table
                pagination={false}
                rowKey="key"
                scroll={{ x: 680 }}
                dataSource={history}
                columns={historyColumns}
              />
            ) : (
              <Typography.Text type="secondary">{t('No image history')}</Typography.Text>
            )}
          </Card>
        </>
      )}
      {manifest?.kind === 'index' && (
        <Card loading={loading} title={t('Platforms')}>
          <Alert
            type="info"
            showIcon
            message={t(
              'This tag is a multi-architecture index. Select a platform digest to inspect its image manifest.',
            )}
            style={{ marginBottom: 16 }}
          />
          <Table
            pagination={false}
            rowKey="digest"
            scroll={{ x: 900 }}
            dataSource={manifest.manifests}
            columns={platformColumns}
          />
        </Card>
      )}
      {manifest && (manifest.kind === 'legacy' || manifest.kind === 'unknown') && (
        <Alert
          type="warning"
          showIcon
          message={t('This manifest media type is not rendered as an image.')}
          description={manifest.mediaType || t('Unknown media type')}
        />
      )}
      {manifest?.referrersSupported && (
        <Card title={t('Related OCI artifacts')}>
          {manifest.referrers?.length ? (
            <Table
              pagination={false}
              rowKey="digest"
              scroll={{ x: 760 }}
              dataSource={manifest.referrers}
              columns={referrerColumns}
            />
          ) : (
            <Typography.Text type="secondary">{t('No related OCI artifacts')}</Typography.Text>
          )}
        </Card>
      )}
      {manifest?.raw && settings?.rawManifestEnabled !== false && (
        <Card title={t('Raw manifest')}>
          <Typography.Paragraph copyable={{ text: JSON.stringify(manifest.raw, null, 2) }}>
            <pre style={{ maxHeight: 360, overflow: 'auto' }}>{JSON.stringify(manifest.raw, null, 2)}</pre>
          </Typography.Paragraph>
        </Card>
      )}
    </Space>
  );
}
