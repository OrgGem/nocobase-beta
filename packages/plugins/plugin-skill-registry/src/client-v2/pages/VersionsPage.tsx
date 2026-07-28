import React from 'react';
import { Button, Card, Popconfirm, Space, Table, type TableColumnsType, Tag } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import { type NocoBaseListBody, type NocoBaseResponse, unwrapRecords } from './api';

type RegistryVersion = {
  id: string;
  version: string;
  channel: string;
  status: string;
  artifactDigest: string;
  publishedAt?: string;
};

export default function VersionsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canInstall, canPublish } = useSkillRegistryPermissions();
  const request = useRequest(() =>
    ctx.api.request<NocoBaseListBody<RegistryVersion>>({
      url: 'skillRegistryVersions:list',
      method: 'get',
      params: { sort: ['-publishedAt'], pageSize: 50 },
    }),
  );
  const versions = unwrapRecords<RegistryVersion>(request.data);

  const install = async (versionId: string) => {
    if (!canInstall) {
      return;
    }
    try {
      await ctx.api.request<NocoBaseResponse<{ installationId: string; skillDefinitionId: string }>>({
        url: 'skillRegistryAdmin:install',
        method: 'post',
        data: { versionId, updatePolicy: 'pinned' },
      });
      ctx.message.success(t('Version installed'));
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  const yank = async (versionId: string) => {
    if (!canPublish) {
      return;
    }
    try {
      await ctx.api.request<NocoBaseResponse<{ status: string }>>({
        url: 'skillRegistryAdmin:yank',
        method: 'post',
        data: { versionId },
      });
      ctx.message.success(t('Version yanked'));
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    }
  };

  const columns: TableColumnsType<RegistryVersion> = [
    { title: t('Version'), key: 'version', render: (_, record) => record.version },
    { title: t('Channel'), key: 'channel', render: (_, record) => record.channel },
    { title: t('Status'), key: 'status', render: (_, record) => <Tag>{record.status}</Tag> },
    { title: t('Digest'), key: 'artifactDigest', render: (_, record) => record.artifactDigest.slice(0, 18) },
    { title: t('Updated'), key: 'publishedAt', render: (_, record) => record.publishedAt || '\u2014' },
  ];

  if (canInstall || canPublish) {
    columns.push({
      title: t('Run'),
      key: 'actions',
      render: (_, record) => (
        <Space>
          {canInstall ? (
            <Button disabled={record.status !== 'published'} onClick={() => install(record.id)}>
              {t('Install')}
            </Button>
          ) : null}
          {canPublish ? (
            <Popconfirm
              title={t('Yank this version?')}
              okText={t('Yank')}
              cancelText={t('Cancel')}
              onConfirm={() => yank(record.id)}
              disabled={record.status !== 'published'}
            >
              <Button danger disabled={record.status !== 'published'}>
                {t('Yank')}
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    });
  }

  return (
    <Card
      title={t('Versions')}
      extra={
        <Button onClick={() => request.refresh()} loading={request.loading}>
          {t('Refresh')}
        </Button>
      }
    >
      <Table
        aria-label={t('Versions')}
        rowKey="id"
        loading={request.loading}
        dataSource={versions}
        pagination={{ pageSize: 50 }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('No data') }}
        columns={columns}
      />
    </Card>
  );
}
