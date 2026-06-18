import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useApp } from '@nocobase/client-v2';

interface Repository {
  id: number;
  name: string;
  repoUrl: string;
  localPath: string;
  defaultBranch: string;
  status: string;
  autoReview?: boolean;
  autoReviewFlowId?: number | null;
}

interface GitManagerContextType {
  repos: Repository[];
  selectedRepo: Repository | null;
  loading: boolean;
  branches: string[];
  currentBranch: string;
  setSelectedRepo: (repo: Repository | null) => void;
  refreshRepos: () => Promise<void>;
  refreshBranches: () => Promise<void>;
}

const GitManagerContext = createContext<GitManagerContextType>(null);

export function useGitManager() {
  return useContext(GitManagerContext);
}

export const GitManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const api = useApp().apiClient;
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);
  const [loading, setLoading] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const selectedRepoRef = useRef(selectedRepo);
  selectedRepoRef.current = selectedRepo;

  const refreshBranches = useCallback(async () => {
    const repo = selectedRepoRef.current;
    if (!repo || repo.status !== 'connected') {
      setBranches([]);
      setCurrentBranch('');
      return;
    }
    try {
      const { data } = await api.request({
        url: 'gitManager:branches',
        params: { repositoryId: repo.id },
      });
      const responseData = data?.data?.data || data?.data;
      if (responseData) {
        setBranches(responseData.all || []);
        setCurrentBranch(responseData.current || '');
      }
    } catch {
      setBranches([]);
      setCurrentBranch('');
    }
  }, [api]);

  const refreshRepos = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'gitRepositories:list', params: { pageSize: 100 } });
      const list = data?.data || [];
      setRepos(list);
      const current = selectedRepoRef.current;
      if (current) {
        const updated = list.find((r: Repository) => r.id === current.id);
        if (updated) setSelectedRepo(updated);
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  return (
    <GitManagerContext.Provider value={{ repos, selectedRepo, loading, branches, currentBranch, setSelectedRepo, refreshRepos, refreshBranches }}>
      {children}
    </GitManagerContext.Provider>
  );
};
