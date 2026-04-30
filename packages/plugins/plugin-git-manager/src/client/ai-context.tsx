import React from 'react';
import { Space } from 'antd';
import { BranchesOutlined, MergeOutlined, NodeIndexOutlined } from '@ant-design/icons';

/**
 * WorkContext options exported as plain objects so we can register them
 * regardless of whether plugin-ai is installed at compile time. The plugin
 * checks `app.aiManager` at runtime before registering.
 */

export const GitRepositoryWorkContext: any = {
  name: 'git-repository',
  menu: {
    icon: <BranchesOutlined />,
    Component: () => <span>Git Repository</span>,
  },
  tag: {
    Component: ({ item }: any) => (
      <Space size={4}>
        <BranchesOutlined />
        <span>{item?.title || `Repo #${item?.uid}`}</span>
      </Space>
    ),
  },
  getContent: async (app: any, { uid }: any) => {
    const response = await app.apiClient.request({
      url: 'gitRepositories:get',
      params: { filterByTk: uid },
    });
    const repo = response?.data?.data;
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

export const GitMergeRequestWorkContext: any = {
  name: 'git-merge-request',
  menu: {
    icon: <MergeOutlined />,
    Component: () => <span>Git Merge Request</span>,
  },
  tag: {
    Component: ({ item }: any) => (
      <Space size={4}>
        <MergeOutlined />
        <span>{item?.title || `MR ${item?.uid}`}</span>
      </Space>
    ),
  },
  getContent: async (app: any, { uid }: any) => {
    // uid format: "<repositoryId>:<mrIid>"
    const [repoIdStr, mrIidStr] = String(uid || '').split(':');
    const repositoryId = Number(repoIdStr);
    const mrIid = Number(mrIidStr);
    if (!repositoryId || !mrIid) return null;
    const response = await app.apiClient.request({
      url: 'gitManager:mergeRequestDetail',
      params: { repositoryId, mrIid },
    });
    const data = response?.data?.data;
    return {
      type: 'git-merge-request',
      repositoryId,
      mrIid,
      title: data?.title,
      sourceBranch: data?.sourceBranch,
      targetBranch: data?.targetBranch,
      author: data?.author,
      changes: data?.changes,
      description: data?.description,
      webUrl: data?.webUrl,
    };
  },
};

export const GitCommitWorkContext: any = {
  name: 'git-commit',
  menu: {
    icon: <NodeIndexOutlined />,
    Component: () => <span>Git Commit</span>,
  },
  tag: {
    Component: ({ item }: any) => (
      <Space size={4}>
        <NodeIndexOutlined />
        <span>{item?.title || `Commit ${item?.uid}`}</span>
      </Space>
    ),
  },
  getContent: async (app: any, { uid }: any) => {
    // uid format: "<repositoryId>:<commitSha>"
    const [repoIdStr, commitSha] = String(uid || '').split(':');
    const repositoryId = Number(repoIdStr);
    if (!repositoryId || !commitSha) return null;
    const response = await app.apiClient.request({
      url: 'gitManager:commitDetail',
      params: { repositoryId, commitHash: commitSha },
    });
    const data = response?.data?.data;
    return {
      type: 'git-commit',
      repositoryId,
      commitSha,
      ...data,
    };
  },
};
