/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useApp } from '@nocobase/client-v2';
import { setCurrentGitRepository } from '../../client-v2/git-context-api';

export interface Repository {
  id: number;
  name: string;
  repoUrl: string;
  localPath: string;
  defaultBranch: string;
  status: string;
  autoReview?: boolean;
  autoReviewFlowId?: number | null;
}

export interface GitRuntimeInfo {
  checked: boolean;
  gitAvailable: boolean;
  gitBinary: string;
  clusterManager: {
    available: boolean;
    gitConfigured: boolean;
    status: 'idle' | 'running' | 'succeeded' | 'failed';
    progressPercent: number;
  };
}

interface GitManagerContextType {
  repos: Repository[];
  selectedRepo: Repository | null;
  loading: boolean;
  branches: string[];
  currentBranch: string;
  gitRuntime: GitRuntimeInfo;
  installingGit: boolean;
  setSelectedRepo: (repo: Repository | null) => void;
  refreshRepos: () => Promise<void>;
  refreshBranches: () => Promise<string>;
  refreshRuntimeStatus: () => Promise<void>;
  installGitViaCluster: () => Promise<boolean>;
}

const DEFAULT_GIT_RUNTIME: GitRuntimeInfo = {
  checked: false,
  gitAvailable: true,
  gitBinary: 'git',
  clusterManager: {
    available: false,
    gitConfigured: false,
    status: 'idle',
    progressPercent: 0,
  },
};

const GitManagerContext = createContext<GitManagerContextType | null>(null);

function readQueryRepositoryId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('repositoryId');
}

function syncManageQueryRepositoryId(repositoryId: number | null): void {
  if (typeof window === 'undefined' || !window.location.pathname.endsWith('/git-manager/manage')) {
    return;
  }
  const url = new URL(window.location.href);
  if (repositoryId == null) {
    url.searchParams.delete('repositoryId');
  } else {
    url.searchParams.set('repositoryId', String(repositoryId));
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function useGitManager() {
  const context = useContext(GitManagerContext);
  if (!context) {
    throw new Error('useGitManager must be used within GitManagerProvider');
  }
  return context;
}

export const GitManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const app = useApp();
  const api = app.apiClient;
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepo, setSelectedRepoState] = useState<Repository | null>(null);
  const [loading, setLoading] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [gitRuntime, setGitRuntime] = useState<GitRuntimeInfo>(DEFAULT_GIT_RUNTIME);
  const [installingGit, setInstallingGit] = useState(false);
  const selectedRepoRef = useRef(selectedRepo);
  selectedRepoRef.current = selectedRepo;
  const gitRuntimeRef = useRef(gitRuntime);
  gitRuntimeRef.current = gitRuntime;

  const setSelectedRepo = useCallback((repo: Repository | null) => {
    setSelectedRepoState(repo);
    syncManageQueryRepositoryId(repo?.id ?? null);
  }, []);

  useEffect(() => {
    setCurrentGitRepository(app, selectedRepo?.id);
    return () => setCurrentGitRepository(app);
  }, [app, selectedRepo?.id]);

  const refreshRuntimeStatus = useCallback(async () => {
    try {
      const { data } = await api.request({
        url: 'gitManager:runtimeStatus',
        skipNotify: true,
      });
      const payload = data?.data?.data || data?.data;
      if (payload && typeof payload.gitAvailable === 'boolean') {
        const cluster = payload.clusterManager || {};
        setGitRuntime({
          checked: true,
          gitAvailable: payload.gitAvailable,
          gitBinary: typeof payload.gitBinary === 'string' ? payload.gitBinary : 'git',
          clusterManager: {
            available: Boolean(cluster.available),
            gitConfigured: Boolean(cluster.gitConfigured),
            status:
              cluster.status === 'running' || cluster.status === 'succeeded' || cluster.status === 'failed'
                ? cluster.status
                : 'idle',
            progressPercent: typeof cluster.progressPercent === 'number' ? cluster.progressPercent : 0,
          },
        });
      }
    } catch {
      // Preserve optimistic default when runtimeStatus is unavailable in test mocks.
    }
  }, [api]);

  useEffect(() => {
    refreshRuntimeStatus();
  }, [refreshRuntimeStatus]);

  useEffect(() => {
    if (!gitRuntime.checked || gitRuntime.gitAvailable || gitRuntime.clusterManager.status !== 'running') {
      return;
    }
    const interval = setInterval(() => {
      refreshRuntimeStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [gitRuntime.checked, gitRuntime.gitAvailable, gitRuntime.clusterManager.status, refreshRuntimeStatus]);

  const installGitViaCluster = useCallback(async (): Promise<boolean> => {
    setInstallingGit(true);
    try {
      await api.request({
        url: 'gitManager:installGit',
        method: 'post',
      });
      await refreshRuntimeStatus();
      return true;
    } catch {
      return false;
    } finally {
      setInstallingGit(false);
    }
  }, [api, refreshRuntimeStatus]);

  const refreshBranches = useCallback(async (): Promise<string> => {
    const repo = selectedRepoRef.current;
    if (
      !repo ||
      repo.status !== 'connected' ||
      (gitRuntimeRef.current.checked && !gitRuntimeRef.current.gitAvailable)
    ) {
      setBranches([]);
      setCurrentBranch('');
      return '';
    }
    try {
      const { data } = await api.request({
        url: 'gitManager:branches',
        params: { repositoryId: repo.id },
        skipNotify: true,
      });
      const responseData = data?.data?.data || data?.data;
      if (responseData) {
        const nextBranches = Array.isArray(responseData.all) ? (responseData.all as string[]) : [];
        const nextCurrent = typeof responseData.current === 'string' ? responseData.current : '';
        setBranches(nextBranches);
        setCurrentBranch(nextCurrent);
        return nextCurrent;
      }
    } catch {
      setBranches([]);
      setCurrentBranch('');
      refreshRuntimeStatus();
    }
    return '';
  }, [api, refreshRuntimeStatus]);

  const refreshRepos = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'gitRepositories:list', params: { pageSize: 100 } });
      const list = (data?.data || []) as Repository[];
      setRepos(list);
      const current = selectedRepoRef.current;
      if (current) {
        const updated = list.find((r) => r.id === current.id);
        if (updated) setSelectedRepoState(updated);
      } else {
        const queryRepoId = readQueryRepositoryId();
        if (queryRepoId) {
          const matched = list.find((r) => String(r.id) === queryRepoId);
          if (matched) setSelectedRepoState(matched);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  return (
    <GitManagerContext.Provider
      value={{
        repos,
        selectedRepo,
        loading,
        branches,
        currentBranch,
        gitRuntime,
        installingGit,
        setSelectedRepo,
        refreshRepos,
        refreshBranches,
        refreshRuntimeStatus,
        installGitViaCluster,
      }}
    >
      {children}
    </GitManagerContext.Provider>
  );
};
