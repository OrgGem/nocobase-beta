import { BranchesOutlined, MergeOutlined, NodeIndexOutlined } from '@ant-design/icons';
import type { AIManager, ContextItem } from '@nocobase/plugin-ai/client-v2';
import { Space } from 'antd';
import React from 'react';
import { useTranslation } from 'react-i18next';

type WorkContextOptions = Parameters<AIManager['registerWorkContext']>[1];

function ContextLabel({ kind, title }: { kind: 'repository' | 'merge-request' | 'commit'; title?: string }) {
  const { t } = useTranslation('plugin-git-manager');
  const labels = { repository: 'Git Repository', 'merge-request': 'Git Merge Request', commit: 'Git Commit' };
  const icons = { repository: <BranchesOutlined />, 'merge-request': <MergeOutlined />, commit: <NodeIndexOutlined /> };
  return (
    <Space size={4}>
      {icons[kind]}
      <span>{title || t(labels[kind])}</span>
    </Space>
  );
}

function recordFromResponse(response: unknown): Record<string, unknown> | null {
  const data = (response as { data?: { data?: unknown } })?.data?.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

function contextComponents(kind: 'repository' | 'merge-request' | 'commit') {
  return {
    menu: { Component: () => <ContextLabel kind={kind} /> },
    tag: {
      Component: ({ item }: { item: ContextItem }) => <ContextLabel kind={kind} title={item.title || item.uid} />,
    },
  };
}

export const GitRepositoryWorkContext: WorkContextOptions = {
  name: 'git-repository',
  ...contextComponents('repository'),
  getContent: async (app, { uid }) => {
    const repo = recordFromResponse(
      await app.apiClient.request({ url: 'gitRepositories:get', params: { filterByTk: uid } }),
    );
    if (!repo) return null;
    return {
      type: 'git-repository',
      repositoryId: repo.id,
      name: repo.name,
      repoUrl: repo.repoUrl,
      defaultBranch: repo.defaultBranch,
      status: repo.status,
    };
  },
};

export const GitMergeRequestWorkContext: WorkContextOptions = {
  name: 'git-merge-request',
  ...contextComponents('merge-request'),
  getContent: async (app, { uid }) => {
    const [repositoryId, iid] = uid.split(':');
    const mrIid = Number(iid);
    if (!repositoryId || !Number.isSafeInteger(mrIid) || mrIid <= 0) return null;
    const data = recordFromResponse(
      await app.apiClient.request({
        url: 'gitManager:mergeRequestDetail',
        params: { repositoryId, mrIid },
      }),
    );
    if (!data) return null;
    return {
      type: 'git-merge-request',
      repositoryId,
      mrIid,
      title: data.title,
      sourceBranch: data.sourceBranch,
      targetBranch: data.targetBranch,
      author: data.author,
      changes: data.changes,
      description: data.description,
      webUrl: data.webUrl,
    };
  },
};

export const GitCommitWorkContext: WorkContextOptions = {
  name: 'git-commit',
  ...contextComponents('commit'),
  getContent: async (app, { uid }) => {
    const separator = uid.indexOf(':');
    const repositoryId = uid.slice(0, separator),
      commitSha = uid.slice(separator + 1);
    if (separator <= 0 || !commitSha) return null;
    const data = recordFromResponse(
      await app.apiClient.request({
        url: 'gitManager:commitDetail',
        params: { repositoryId, commitHash: commitSha },
      }),
    );
    return data ? { ...data, type: 'git-commit', repositoryId, commitSha } : null;
  },
};
