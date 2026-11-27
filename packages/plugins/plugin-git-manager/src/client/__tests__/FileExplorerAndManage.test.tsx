// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitManagerSettings } from '../components/GitManagerSettings';
import { RepositoryConfigSettings } from '../components/RepositoryConfig';

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  const t = (key: string) => key;
  return {
    request,
    t,
    app: {
      apiClient: { request },
      getPublicPath: () => '/',
      router: { getBasename: () => '/' },
    },
  };
});

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => mocks.app,
  getRouteRuntimeVersion: () => 'legacy',
  getV2EffectiveBasePath: () => '/',
  stripModernClientPrefix: (p: string) => p,
}));

vi.mock('../../client-v2/git-context-api', () => ({
  setCurrentGitRepository: vi.fn(),
}));

vi.mock('../locale', () => ({
  useT: () => mocks.t,
}));

vi.mock('../components/RunReviewButton', () => ({
  RunReviewButton: () => <button type="button">Run review</button>,
}));

describe('Git Manager UI — Cluster Manager compatibility, branch reset, and Manage navigation', () => {
  const originalPath = window.location.pathname + window.location.search;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/admin/settings/git-manager/manage?repositoryId=1');
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', originalPath || '/');
  });

  it('shows Cluster Manager install banner without firing fileTree when git is missing, then unlocks once installed', async () => {
    let gitReady = false;
    mocks.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'gitRepositories:list') {
        return {
          data: {
            data: [
              {
                id: 1,
                name: 'test-pretext',
                repoUrl: 'https://github.com/gemvn90/pretext',
                localPath: 'my-project-main',
                defaultBranch: 'main',
                status: 'connected',
              },
            ],
          },
        };
      }
      if (url === 'gitManager:runtimeStatus') {
        return {
          data: {
            data: {
              gitAvailable: gitReady,
              gitBinary: 'git',
              clusterManager: {
                available: true,
                gitConfigured: true,
                status: 'idle',
                progressPercent: 0,
              },
            },
          },
        };
      }
      if (url === 'gitManager:installGit') {
        gitReady = true;
        return { data: { data: { dispatched: true } } };
      }
      if (url === 'gitManager:branches') {
        return { data: { data: { current: 'main', all: ['main'] } } };
      }
      if (url === 'gitManager:fileTree') {
        return {
          data: {
            data: [{ mode: '100644', type: 'blob', hash: 'abc1234', size: 120, name: 'README.md', path: 'README.md' }],
          },
        };
      }
      return { data: { data: [] } };
    });

    render(<GitManagerSettings />);

    const installBtn = await screen.findByRole('button', { name: /Install Git via Cluster Manager/i });
    expect(installBtn).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'gitManager:fileTree' }));

    fireEvent.click(installBtn);

    expect(await screen.findByText('README.md')).toBeInTheDocument();
    const fileTreeCalls = mocks.request.mock.calls.filter(([arg]) => arg.url === 'gitManager:fileTree');
    expect(fileTreeCalls).toHaveLength(1);
    expect(fileTreeCalls[0][0]).toMatchObject({
      url: 'gitManager:fileTree',
      params: { repositoryId: 1, ref: 'main', treePath: '' },
    });
  });

  it('resets branch ref when switching between repositories with different default branches', async () => {
    window.history.replaceState({}, '', '/admin/settings/git-manager/manage?repositoryId=1');
    mocks.request.mockImplementation(async ({ url, params }: { url: string; params?: { repositoryId?: number } }) => {
      if (url === 'gitRepositories:list') {
        return {
          data: {
            data: [
              {
                id: 1,
                name: 'repo-develop',
                repoUrl: 'https://github.com/org/repo-a',
                localPath: 'repo-a',
                defaultBranch: 'develop',
                status: 'connected',
              },
              {
                id: 2,
                name: 'repo-main',
                repoUrl: 'https://github.com/org/repo-b',
                localPath: 'repo-b',
                defaultBranch: 'main',
                status: 'connected',
              },
            ],
          },
        };
      }
      if (url === 'gitManager:runtimeStatus') {
        return {
          data: {
            data: {
              gitAvailable: true,
              gitBinary: '/usr/bin/git',
              clusterManager: { available: true, gitConfigured: true, status: 'succeeded', progressPercent: 100 },
            },
          },
        };
      }
      if (url === 'gitManager:branches') {
        return params?.repositoryId === 1
          ? { data: { data: { current: 'develop', all: ['develop'] } } }
          : { data: { data: { current: 'main', all: ['main'] } } };
      }
      if (url === 'gitManager:fileTree') {
        return { data: { data: [] } };
      }
      return { data: { data: [] } };
    });

    render(<GitManagerSettings />);

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith({
        url: 'gitManager:fileTree',
        params: { repositoryId: 1, ref: 'develop', treePath: '' },
      });
    });

    const comboboxes = screen.getAllByRole('combobox');
    fireEvent.mouseDown(comboboxes[0]);
    fireEvent.click(await screen.findByText('repo-main'));

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith({
        url: 'gitManager:fileTree',
        params: { repositoryId: 2, ref: 'main', treePath: '' },
      });
    });
    expect(mocks.request).not.toHaveBeenCalledWith({
      url: 'gitManager:fileTree',
      params: { repositoryId: 2, ref: 'develop', treePath: '' },
    });
  });

  it('renders accessible Manage links in RepositoryConfig table', async () => {
    window.history.replaceState({}, '', '/admin/settings/git-manager/repositories');
    mocks.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'gitRepositories:list') {
        return {
          data: {
            data: [
              {
                id: 1,
                name: 'test-pretext',
                repoUrl: 'https://github.com/gemvn90/pretext',
                localPath: 'my-project-main',
                defaultBranch: 'main',
                status: 'connected',
              },
            ],
          },
        };
      }
      if (url === 'gitManager:runtimeStatus') {
        return {
          data: {
            data: {
              gitAvailable: true,
              gitBinary: '/usr/bin/git',
              clusterManager: { available: true, gitConfigured: true, status: 'succeeded', progressPercent: 100 },
            },
          },
        };
      }
      return { data: { data: [] } };
    });

    render(<RepositoryConfigSettings />);

    const link = await screen.findByRole('link', { name: 'test-pretext' });
    expect(link).toHaveAttribute('href', '/admin/settings/git-manager/manage?repositoryId=1');
  });
});
