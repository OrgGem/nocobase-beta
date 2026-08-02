import React, { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Empty, Input, List, Space, Spin, Tag, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { registryApi, type RegistryHealth } from '../api';
import { useT } from '../locale';
import { type DockerRegistryPageProps, useDockerRegistryPermissions } from '../permissions';
import { UploadImageButton } from '../components/ImageTransferControls';
import { DOCKER_REGISTRY_IMAGES_PATH, DOCKER_REGISTRY_SETTINGS_ROOT_PATH } from '../../shared/routes';

export default function RegistryBrowserPage({ permissions }: DockerRegistryPageProps) {
  const ctx = useFlowContext();
  const t = useT();
  const aclPermissions = useDockerRegistryPermissions();
  const { canConfigure, canRead, canUpload } = permissions ?? aclPermissions;
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [health, setHealth] = useState<RegistryHealth>();
  const { data: settings } = useRequest(() => registryApi.getPublicSettings(ctx), { ready: canRead });

  const {
    run: load,
    loading,
    error,
  } = useRequest(
    async (cursor?: string, append = false) => {
      const [repositories, status] = await Promise.all([
        registryApi.listRepositories(ctx, cursor, search),
        registryApi.testConnection(ctx),
      ]);
      setRows((previous) => (append ? [...previous, ...repositories.items] : repositories.items));
      setNextCursor(repositories.nextCursor);
      setHealth(status);
    },
    { manual: true },
  );

  useEffect(() => {
    if (canRead) load();
  }, [canRead, load]);

  useEffect(() => {
    if (!settings?.autoRefreshSeconds) return undefined;
    const timer = window.setInterval(() => load(), settings.autoRefreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [load, settings?.autoRefreshSeconds]);

  const openRepository = (repository: string) => {
    ctx.router.navigate(`${DOCKER_REGISTRY_IMAGES_PATH}?name=${encodeURIComponent(repository)}`);
  };

  if (!canRead) {
    return <Alert type="error" showIcon message={t('You do not have permission to browse this Registry.')} />;
  }

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex', maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <Card>
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Space style={{ display: 'flex', justifyContent: 'space-between' }} wrap>
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {settings?.displayName || t('Docker Registry')}
              </Typography.Title>
              <Typography.Text type="secondary">
                {t('Browse repositories, tags, manifests and image metadata.')}
              </Typography.Text>
            </div>
            <Space>
              {canConfigure && (
                <Button
                  icon={<SettingOutlined />}
                  onClick={() => ctx.router.navigate(DOCKER_REGISTRY_SETTINGS_ROOT_PATH)}
                >
                  {t('Settings')}
                </Button>
              )}
              {canUpload && (
                <UploadImageButton maxTransferSizeMb={settings?.maxTransferSizeMb} onUploaded={() => load()} />
              )}
              <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load()}>
                {t('Refresh')}
              </Button>
            </Space>
          </Space>
          {health && (
            <Alert
              type={health.reachable ? (health.authentication === 'public' ? 'success' : 'warning') : 'error'}
              message={health.reachable ? t('Registry is reachable') : t('Registry is unavailable')}
              description={
                health.authentication === 'required'
                  ? t('Authentication is required to browse this Registry.')
                  : health.apiVersion
              }
              showIcon
            />
          )}
          <Input
            aria-label={t('Search repositories')}
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t('Search repositories')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onPressEnter={() => load()}
          />
        </Space>
      </Card>
      {error && <Alert type="error" showIcon message={t('Unable to load repositories')} description={error.message} />}
      <Card title={t('Repositories')} extra={<Badge count={rows.length} showZero />}>
        {loading && rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : rows.length === 0 ? (
          <Empty description={t('No repositories found')} />
        ) : (
          <List
            dataSource={rows}
            renderItem={(repository) => (
              <List.Item
                actions={[
                  <Button key="open" type="link" onClick={() => openRepository(repository)}>
                    {t('Open')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={<Typography.Text strong>{repository}</Typography.Text>}
                  description={<Tag>{t('Repository')}</Tag>}
                />
              </List.Item>
            )}
          />
        )}
        {nextCursor && (
          <Button style={{ marginTop: 16 }} block loading={loading} onClick={() => load(nextCursor, true)}>
            {t('Load more')}
          </Button>
        )}
      </Card>
    </Space>
  );
}
