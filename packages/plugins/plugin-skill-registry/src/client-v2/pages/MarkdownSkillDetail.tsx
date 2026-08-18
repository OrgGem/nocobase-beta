import React from 'react';
import { Descriptions, Drawer, Empty, Space, Spin, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { unwrapData } from './api';

export type SkillRecord = {
  id: string;
  namespace: string;
  slug: string;
  displayName: string;
  description?: string;
  content?: string;
  tags?: string[];
  visibility: string;
  status: string;
  packageId?: string;
  updatedAt?: string;
  owner?: { id: string | number; nickname?: string; username?: string; email?: string };
};

export type SkillVersionSummary = {
  id: string;
  version: string;
  channel: string;
  status: string;
  changelog: string | null;
  publishedAt?: string;
};

export type SkillDetailBody = {
  skill: SkillRecord;
  markdown: { frontmatter: Record<string, unknown>; body: string } | null;
  versions: SkillVersionSummary[];
};

function frontmatterDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function SkillDetailContent({ detail }: { detail: SkillDetailBody }) {
  const t = useT();
  const skill = detail.skill;
  const frontmatter = detail.markdown?.frontmatter ?? {};
  const markdownBody = detail.markdown?.body ?? '';
  const versions = detail.versions ?? [];
  const frontmatterEntries = Object.entries(frontmatter);
  const declaredVersion =
    typeof frontmatter.version === 'string' && frontmatter.version.trim() ? frontmatter.version : undefined;
  const declaredDescription =
    typeof frontmatter.description === 'string' && frontmatter.description.trim() ? frontmatter.description : undefined;
  const latestPublished = versions.find((version) => version.status === 'published');

  const frontmatterColumns: TableColumnsType<{ key: string; value: unknown }> = [
    {
      title: t('Key'),
      dataIndex: 'key',
      key: 'key',
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    { title: t('Value'), dataIndex: 'value', key: 'value', render: (value: unknown) => frontmatterDisplay(value) },
  ];

  const versionColumns: TableColumnsType<SkillVersionSummary> = [
    { title: t('Version'), dataIndex: 'version', key: 'version' },
    { title: t('Channel'), dataIndex: 'channel', key: 'channel' },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      render: (value: string) => <Tag>{value}</Tag>,
    },
    { title: t('Published'), dataIndex: 'publishedAt', key: 'publishedAt', render: (value?: string) => value || '—' },
  ];

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label={t('Display name')}>{skill.displayName}</Descriptions.Item>
        <Descriptions.Item label={t('Package')}>{`${skill.namespace}/${skill.slug}`}</Descriptions.Item>
        <Descriptions.Item label={t('Status')}>
          <Tag>{skill.status}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t('Visibility')}>
          <Tag>{skill.visibility}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t('Version (skill.md)')}>{declaredVersion || '—'}</Descriptions.Item>
        <Descriptions.Item label={t('Latest published')}>
          {latestPublished ? `${latestPublished.version} (${latestPublished.channel})` : '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('Description')}>
          {declaredDescription || skill.description || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('Tags')}>
          {skill.tags && skill.tags.length > 0 ? (
            <Space wrap size={4}>
              {skill.tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </Space>
          ) : (
            '—'
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('Owner')}>
          {skill.owner?.nickname || skill.owner?.username || skill.owner?.email || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('Updated')}>{skill.updatedAt || '—'}</Descriptions.Item>
      </Descriptions>

      <Space direction="vertical" size="small" style={{ display: 'flex' }}>
        <Typography.Title level={5}>{t('Metadata from skill.md')}</Typography.Title>
        {frontmatterEntries.length > 0 ? (
          <Table
            aria-label={t('Metadata from skill.md')}
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={frontmatterEntries.map(([key, value]) => ({ key, value }))}
            columns={frontmatterColumns}
          />
        ) : (
          <Empty description={t('No metadata was declared in the skill file.')} />
        )}
      </Space>

      <Space direction="vertical" size="small" style={{ display: 'flex' }}>
        <Typography.Title level={5}>{t('Published versions')}</Typography.Title>
        {versions.length > 0 ? (
          <Table
            aria-label={t('Published versions')}
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={versions}
            columns={versionColumns}
          />
        ) : (
          <Empty description={t('No versions have been published yet.')} />
        )}
      </Space>

      <Space direction="vertical" size="small" style={{ display: 'flex' }}>
        <Typography.Title level={5}>{t('Markdown content')}</Typography.Title>
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {markdownBody || skill.content || '—'}
        </Typography.Paragraph>
      </Space>
    </Space>
  );
}

export function MarkdownSkillDetailDrawer({ skillId, onClose }: { skillId?: string; onClose: () => void }) {
  const ctx = useFlowContext();
  const t = useT();

  const request = useRequest(
    () =>
      ctx.api.request({
        url: 'skillRegistryAdmin:getMarkdownDetail',
        method: 'post',
        data: { markdownSkillId: skillId },
      }),
    { ready: Boolean(skillId), refreshDeps: [skillId] },
  );

  const detail = unwrapData<SkillDetailBody>(request.data);
  const skill = detail?.skill;

  return (
    <Drawer
      title={skill ? skill.displayName : t('Skill details')}
      width="min(900px, 95vw)"
      open={Boolean(skillId)}
      onClose={onClose}
      destroyOnClose
    >
      <Spin spinning={request.loading}>{skill && detail ? <SkillDetailContent detail={detail} /> : null}</Spin>
    </Drawer>
  );
}

export default MarkdownSkillDetailDrawer;
