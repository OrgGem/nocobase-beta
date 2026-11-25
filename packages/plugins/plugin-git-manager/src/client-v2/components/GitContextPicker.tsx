// SPDX-License-Identifier: Apache-2.0

import { Alert, Button, Form, Input, Select, Space, Spin, Typography } from 'antd';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  actionBody,
  actionData,
  fetchGitContext,
  getCurrentGitRepository,
  type GitContextApp,
  type GitContextKind,
} from '../git-context-api';

type Repository = { id: number; name?: string; defaultBranch?: string; status?: string };
type MergeRequest = {
  iid: number;
  title: string;
  sourceBranch?: string;
  targetBranch?: string;
  author?: { name?: string; username?: string };
  updatedAt?: string;
};
type Commit = { hash: string; message?: string; subject?: string; author_name?: string; date?: string };
type ContextSelection = { uid: string; title?: string };

const PAGE_SIZE = 30;

function formatDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function GitContextPicker({
  app,
  kind,
  onAdd,
  isActive,
  onClose,
}: {
  app: GitContextApp;
  kind: GitContextKind;
  onAdd: (item: ContextSelection) => void;
  isActive?: () => boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('plugin-git-manager');
  const [repositoryQuery, setRepositoryQuery] = useState('');
  const [repositoryPage, setRepositoryPage] = useState(1);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryHasMore, setRepositoryHasMore] = useState(false);
  const [repository, setRepository] = useState<Repository>();
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState<string>();
  const [state, setState] = useState('opened');
  const [itemQuery, setItemQuery] = useState('');
  const [itemPage, setItemPage] = useState(1);
  const [mergeRequests, setMergeRequests] = useState<MergeRequest[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [itemHasMore, setItemHasMore] = useState(false);
  const [itemLoading, setItemLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<string>();
  const [repositoryError, setRepositoryError] = useState('');
  const [branchError, setBranchError] = useState('');
  const [itemError, setItemError] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const repositoryTouched = useRef(false);
  const mounted = useRef(true);
  const submittingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const repositoryId = getCurrentGitRepository(app);
    if (repositoryId == null) return;
    let cancelled = false;
    app.apiClient
      .request({
        url: 'gitManager:chatContextOptions',
        params: { kind, repositoryId, page: 1, pageSize: 1 },
        skipNotify: true,
      })
      .then((response) => {
        const data = actionData(response) as { items?: Repository[] } | undefined;
        if (!cancelled && !repositoryTouched.current && data?.items?.[0]) setRepository(data.items[0]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [app, kind]);

  useEffect(() => {
    let cancelled = false;
    setRepositoryLoading(true);
    app.apiClient
      .request({
        url: 'gitManager:chatContextOptions',
        params: { kind, search: repositoryQuery, page: repositoryPage, pageSize: PAGE_SIZE },
        skipNotify: true,
      })
      .then((response) => {
        if (cancelled) return;
        const data = actionData(response) as { items?: Repository[]; hasMore?: boolean } | undefined;
        const items = Array.isArray(data?.items) ? data.items : [];
        setRepositories((current) => (repositoryPage === 1 ? items : [...current, ...items]));
        setRepositoryHasMore(data?.hasMore === true);
        setRepositoryError('');
      })
      .finally(() => {
        if (!cancelled) setRepositoryLoading(false);
      })
      .catch(() => {
        if (!cancelled) setRepositoryError(t('Unable to load Git context. Check your access and try again.'));
      });
    return () => {
      cancelled = true;
    };
  }, [app, kind, repositoryPage, repositoryQuery, t]);

  useEffect(() => {
    setBranches([]);
    setBranch(undefined);
    setBranchError('');
    setBranchLoading(false);
    if (kind !== 'commit' || !repository) return;
    let cancelled = false;
    setBranchLoading(true);
    app.apiClient
      .request({ url: 'gitManager:branches', params: { repositoryId: repository.id }, skipNotify: true })
      .then((response) => {
        if (cancelled) return;
        const data = actionData(response) as { all?: string[]; current?: string; detached?: boolean } | undefined;
        const available = Array.isArray(data?.all) ? data.all : [];
        setBranches(available);
        const current = !data?.detached && data?.current ? data.current : undefined;
        const preferred = current && available.includes(current) ? current : repository.defaultBranch;
        setBranch(preferred && available.includes(preferred) ? preferred : available[0]);
        setBranchError('');
      })
      .finally(() => {
        if (!cancelled) setBranchLoading(false);
      })
      .catch(() => {
        if (!cancelled) setBranchError(t('Unable to load Git context. Check your access and try again.'));
      });
    return () => {
      cancelled = true;
    };
  }, [app, kind, repository, t]);

  useEffect(() => {
    if (!repository || kind === 'repository' || (kind === 'commit' && !branch)) {
      setItemLoading(false);
      return;
    }
    let cancelled = false;
    setItemLoading(true);
    const params =
      kind === 'merge-request'
        ? { repositoryId: repository.id, state, page: itemPage, perPage: PAGE_SIZE }
        : { repositoryId: repository.id, branch, skip: (itemPage - 1) * PAGE_SIZE, maxCount: PAGE_SIZE };
    app.apiClient
      .request({
        url: kind === 'merge-request' ? 'gitManager:mergeRequests' : 'gitManager:log',
        params,
        skipNotify: true,
      })
      .then((response) => {
        if (cancelled) return;
        if (kind === 'merge-request') {
          const items = actionData(response);
          const list = Array.isArray(items) ? (items as MergeRequest[]) : [];
          const body = actionBody(response) as
            | { pagination?: { totalPages?: number | null; hasMore?: boolean } }
            | undefined;
          setMergeRequests((current) => (itemPage === 1 ? list : [...current, ...list]));
          setItemHasMore(
            body?.pagination?.hasMore ??
              (body?.pagination?.totalPages != null
                ? itemPage < body.pagination.totalPages
                : list.length === PAGE_SIZE),
          );
        } else {
          const data = actionData(response) as { all?: Commit[] } | undefined;
          const list = Array.isArray(data?.all) ? data.all : [];
          setCommits((current) => (itemPage === 1 ? list : [...current, ...list]));
          setItemHasMore(list.length === PAGE_SIZE);
        }
        setItemError('');
      })
      .finally(() => {
        if (!cancelled) setItemLoading(false);
      })
      .catch(() => {
        if (!cancelled) setItemError(t('Unable to load Git context. Check your access and try again.'));
      });
    return () => {
      cancelled = true;
    };
  }, [app, branch, itemPage, kind, repository, state, t]);

  const filteredMergeRequests = useMemo(() => {
    const query = itemQuery.trim().toLowerCase().replace(/^!/, '');
    return mergeRequests.filter((item) => `${item.iid} ${item.title}`.toLowerCase().includes(query));
  }, [itemQuery, mergeRequests]);
  const filteredCommits = useMemo(() => {
    const query = itemQuery.trim().toLowerCase();
    return commits.filter((item) => `${item.hash} ${item.subject || item.message || ''}`.toLowerCase().includes(query));
  }, [itemQuery, commits]);

  const changeRepository = (id: number) => {
    repositoryTouched.current = true;
    setRepository(repositories.find((item) => item.id === id));
    setBranch(undefined);
    setBranches([]);
    setSelectedItem(undefined);
    setItemPage(1);
    setMergeRequests([]);
    setCommits([]);
    setItemHasMore(false);
    setItemQuery('');
    setItemError('');
    setAttachmentError('');
  };

  const attach = async () => {
    if (submittingRef.current || !repository || (kind !== 'repository' && !selectedItem)) return;
    const uid = kind === 'repository' ? String(repository.id) : `${repository.id}:${selectedItem}`;
    const selectedMR = mergeRequests.find((item) => String(item.iid) === selectedItem);
    const selectedCommit = commits.find((item) => item.hash === selectedItem);
    const repoName = repository.name || String(repository.id);
    const title =
      kind === 'repository'
        ? repoName
        : kind === 'merge-request'
          ? `${repoName} · !${selectedItem} · ${selectedMR?.title || ''}`
          : `${repoName} · ${selectedItem?.slice(0, 7)} · ${selectedCommit?.subject || selectedCommit?.message || ''}`;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await fetchGitContext(app, kind, uid);
      if (!mounted.current || (isActive && !isActive())) return;
      onAdd({ uid, title });
      onClose();
    } catch {
      if (mounted.current) setAttachmentError(t('Git context is unavailable. Check your access and select it again.'));
    } finally {
      submittingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <Form layout="vertical" onFinish={attach} disabled={submitting}>
      <Form.Item label={t('Search repositories')}>
        <Input.Search
          allowClear
          onSearch={(value, event) => {
            event?.preventDefault();
            repositoryTouched.current = true;
            setRepositoryPage(1);
            setRepositoryQuery(value);
          }}
          aria-label={t('Search repositories')}
        />
      </Form.Item>
      <Form.Item label={t('Repository')} required>
        <Select
          aria-label={t('Repository')}
          loading={repositoryLoading}
          value={repository?.id}
          onChange={changeRepository}
          placeholder={t('Select a repository')}
          options={(repository && !repositories.some((item) => item.id === repository.id)
            ? [repository, ...repositories]
            : repositories
          ).map((item) => ({
            value: item.id,
            label: [item.name || String(item.id), item.defaultBranch, item.status].filter(Boolean).join(' · '),
          }))}
          notFoundContent={repositoryLoading ? <Spin size="small" /> : t('No repositories available')}
        />
        {repositoryHasMore && (
          <Button type="link" loading={repositoryLoading} onClick={() => setRepositoryPage((page) => page + 1)}>
            {t('Load more repositories')}
          </Button>
        )}
      </Form.Item>
      {kind === 'commit' && repository && (
        <Form.Item label={t('Branch')} required>
          <Select
            aria-label={t('Branch')}
            loading={branchLoading}
            value={branch}
            placeholder={t('Select a branch')}
            options={branches.map((name) => ({ value: name, label: name }))}
            onChange={(value) => {
              setBranch(value);
              setItemPage(1);
              setCommits([]);
              setItemHasMore(false);
              setSelectedItem(undefined);
              setItemError('');
              setAttachmentError('');
            }}
          />
        </Form.Item>
      )}
      {kind === 'merge-request' && repository && (
        <Form.Item label={t('State')}>
          <Select
            aria-label={t('State')}
            value={state}
            options={['opened', 'merged', 'closed', 'all'].map((value) => ({ value, label: t(value) }))}
            onChange={(value) => {
              setState(value);
              setItemPage(1);
              setMergeRequests([]);
              setItemHasMore(false);
              setSelectedItem(undefined);
              setItemError('');
              setAttachmentError('');
            }}
          />
        </Form.Item>
      )}
      {kind !== 'repository' && repository && (kind !== 'commit' || branch) && (
        <>
          <Form.Item label={t('Search loaded results')}>
            <Input
              aria-label={t('Search loaded results')}
              value={itemQuery}
              onChange={(event) => {
                setItemQuery(event.target.value);
                setSelectedItem(undefined);
                setAttachmentError('');
              }}
              onPressEnter={(event) => event.preventDefault()}
              allowClear
            />
          </Form.Item>
          <Form.Item label={t(kind === 'commit' ? 'Commit' : 'Merge Request')} required>
            <Select
              aria-label={t(kind === 'commit' ? 'Commit' : 'Merge Request')}
              loading={itemLoading}
              value={selectedItem}
              onChange={setSelectedItem}
              placeholder={t(kind === 'commit' ? 'Select a commit' : 'Select a merge request')}
              options={
                kind === 'merge-request'
                  ? filteredMergeRequests.map((item) => ({
                      value: String(item.iid),
                      label: [
                        `!${item.iid} · ${item.title}`,
                        item.sourceBranch && item.targetBranch ? `${item.sourceBranch} → ${item.targetBranch}` : '',
                        item.author?.name || item.author?.username,
                        formatDate(item.updatedAt),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    }))
                  : filteredCommits.map((item) => ({
                      value: item.hash,
                      label: [
                        item.hash.slice(0, 7),
                        item.subject || item.message,
                        item.author_name,
                        formatDate(item.date),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    }))
              }
              notFoundContent={itemLoading ? <Spin size="small" /> : t('No results')}
            />
            {itemHasMore && (
              <Button type="link" loading={itemLoading} onClick={() => setItemPage((page) => page + 1)}>
                {t('Load more results')}
              </Button>
            )}
          </Form.Item>
        </>
      )}
      {(attachmentError || itemError || branchError || repositoryError) && (
        <Alert
          type="error"
          showIcon
          message={attachmentError || itemError || branchError || repositoryError}
          style={{ marginBottom: 16 }}
        />
      )}
      <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button
          type="primary"
          htmlType="submit"
          loading={submitting}
          disabled={!repository || (kind !== 'repository' && !selectedItem)}
        >
          {t('Attach to chat')}
        </Button>
      </Space>
      <Typography.Text type="secondary" aria-live="polite">
        {itemLoading || repositoryLoading || branchLoading ? t('Loading') : ''}
      </Typography.Text>
    </Form>
  );
}
