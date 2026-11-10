/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Table,
  Tag,
  Drawer,
  Space,
  Button,
  Typography,
  Empty,
  Tooltip,
  Popconfirm,
  message,
  Select,
  Tabs,
  Input,
  Alert,
  theme,
} from 'antd';
import {
  RobotOutlined,
  ReloadOutlined,
  CheckOutlined,
  CloseOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  ExportOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useGitManager } from '../context/GitManagerContext';
import { MarkdownView } from './MarkdownView';
import { useT } from '../locale';
import { reviewApprovalHref, workflowHref } from '../workflowRoutes';

const { Text, Title, Paragraph } = Typography;
const { useToken } = theme;
type LegacyPostStatus = {
  reviewId: number;
  status: 'posted' | 'unknown' | 'observed';
  attemptId: string | null;
  canRetry: boolean;
  holdActive: boolean;
  baseUnverified: boolean;
  baseAcknowledged: boolean;
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  queued: 'default',
  running: 'blue',
  completed: 'green',
  failed: 'red',
};

const POST_STATUS_COLOR: Record<string, string> = {
  pending_approval: 'orange',
  approved: 'cyan',
  posted: 'green',
  post_failed: 'red',
  post_unknown: 'orange',
  posting: 'blue',
  retrying: 'blue',
  skipped: 'default',
  rejected: 'red',
};

export const ReviewHistory: React.FC<{ initialFilter?: 'all' | 'pending_approval' }> = ({ initialFilter = 'all' }) => {
  const t = useT();
  const { token } = useToken();
  const app = useApp();
  const api = app.apiClient;
  const { repos } = useGitManager();
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [postFilter, setPostFilter] = useState<string>(
    initialFilter === 'pending_approval' ? 'pending_approval' : 'all',
  );
  const [triggerFilter, setTriggerFilter] = useState<string>('all');
  const [selected, setSelected] = useState<any | null>(null);
  const [editing, setEditing] = useState(false);
  const [reconcilingPost, setReconcilingPost] = useState(false);
  const [legacyPost, setLegacyPost] = useState<LegacyPostStatus | null>(null);
  const [editedMarkdown, setEditedMarkdown] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const filter: any = {};
      if (statusFilter !== 'all') filter.status = statusFilter;
      if (postFilter !== 'all') filter.postStatus = postFilter;
      if (triggerFilter !== 'all') filter.triggeredBy = triggerFilter;
      const { data } = await api.request({
        url: 'gitCodeReviews:list',
        params: {
          pageSize: 50,
          sort: ['-id'],
          filter: Object.keys(filter).length ? filter : undefined,
        },
      });
      setReviews(data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api, statusFilter, postFilter, triggerFilter]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-refresh while there are running reviews
  useEffect(() => {
    if (!reviews.some((r) => r.status === 'running' || r.status === 'pending' || r.status === 'queued')) return;
    const tid = setInterval(reload, 4000);
    return () => clearInterval(tid);
  }, [reviews, reload]);

  const refreshOne = useCallback(
    async (id: number) => {
      const { data } = await api.request({ url: 'gitCodeReviews:get', params: { filterByTk: id } });
      const fresh = data?.data;
      if (fresh) {
        setReviews((prev) => prev.map((r) => (r.id === id ? fresh : r)));
        if (selected?.id === id) setSelected(fresh);
      }
    },
    [api, selected],
  );

  const handleApprove = async (markdown: string) => {
    if (!selected) return;
    try {
      const response = await api.request({
        url: 'gitManager:reviewApprovePost',
        method: 'post',
        data: { reviewId: selected.id, editedMarkdown: markdown, baseConfirmation: 'LEGACY_BASE_UNVERIFIED' },
      });
      const payload = response?.data?.data;
      const result = payload?.success ? payload.data : payload;
      if (result?.status === 'posted') message.success(t('Review posted to merge request'));
      else if (result?.status === 'observed')
        message.warning(t('A matching comment was found, but its attempt cannot be confirmed'));
      else message.warning(t('Publication outcome is still unknown'));
      setEditing(false);
      refreshOne(selected.id);
      reload();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err?.message || t('Failed to post review'));
    }
  };

  const handleReject = async () => {
    if (!selected) return;
    try {
      await api.request({
        url: 'gitManager:reviewReject',
        method: 'post',
        data: { reviewId: selected.id },
      });
      message.success(t('Review rejected'));
      refreshOne(selected.id);
      reload();
    } catch (err: any) {
      message.error(err?.message || t('Failed to reject'));
    }
  };

  const handleRetryPost = async (allowResend: boolean) => {
    if (!selected) return;
    setReconcilingPost(true);
    try {
      const response = await api.request({
        url: 'gitManager:reviewWorkflowRetryPost',
        method: 'post',
        data: { reviewId: selected.id, ...(allowResend ? { confirmation: 'OUTBOUND_POST_STOPPED' } : {}) },
      });
      const result = response?.data?.data;
      if (result?.status === 'posted') message.success(t('Review publication confirmed'));
      else if (result?.status === 'observed')
        message.info(t('Matching comment found; another publication attempt still owns the review'));
      else if (result?.canResend)
        message.warning(t('No matching comment found; confirm the previous post stopped before retrying'));
      else
        message.warning(t('A previous publication attempt may still be running; ask an administrator to recover it'));
      await refreshOne(selected.id);
      await reload();
    } catch (error: unknown) {
      const responseError = error as { response?: { data?: { errors?: Array<{ message?: string }> } } } | null;
      message.error(
        responseError?.response?.data?.errors?.[0]?.message ||
          (error instanceof Error && error.message) ||
          t('Failed to reconcile review publication'),
      );
    } finally {
      setReconcilingPost(false);
    }
  };

  const handleLegacyPost = async (action: 'check' | 'retry' | 'release') => {
    if (!selected || (action !== 'check' && legacyPost?.reviewId !== selected.id)) return;
    setReconcilingPost(true);
    try {
      const route =
        action === 'check'
          ? 'reviewLegacyPostStatus'
          : action === 'retry'
            ? 'reviewLegacyRetryPost'
            : 'reviewLegacyReleaseHold';
      const response = await api.request({
        url: `gitManager:${route}`,
        method: 'post',
        data: {
          reviewId: selected.id,
          ...(action === 'check'
            ? {}
            : { confirmation: 'OUTBOUND_POST_STOPPED', expectedAttempt: legacyPost?.attemptId ?? null }),
          ...(action === 'retry' && legacyPost?.baseUnverified && !legacyPost.baseAcknowledged
            ? { baseConfirmation: 'LEGACY_BASE_UNVERIFIED' }
            : {}),
        },
      });
      const payload = response?.data?.data;
      const result = payload?.success ? payload.data : payload;
      if (action === 'check' && result) setLegacyPost({ ...result, reviewId: selected.id });
      else setLegacyPost(null);
      if (result?.status === 'posted') message.success(t('Review publication confirmed'));
      else if (result?.status === 'observed' && result?.canRetry)
        message.warning(t('A matching marked comment was found; confirm the previous attempt stopped to finalize it'));
      else if (result?.status === 'observed')
        message.warning(t('A matching comment was found, but its attempt cannot be confirmed'));
      else if (action === 'release') message.success(t('Legacy publication hold released'));
      else if (action === 'retry') message.warning(t('Publication outcome is still unknown'));
      await refreshOne(selected.id);
      await reload();
    } catch (error: unknown) {
      const responseError = error as { response?: { data?: { errors?: Array<{ message?: string }> } } } | null;
      message.error(
        responseError?.response?.data?.errors?.[0]?.message ||
          (error instanceof Error && error.message) ||
          t('Failed to reconcile review publication'),
      );
    } finally {
      setReconcilingPost(false);
    }
  };

  const repoMap = useMemo(() => {
    const m: Record<number, any> = {};
    repos.forEach((r: any) => (m[r.id] = r));
    return m;
  }, [repos]);

  const columns = [
    {
      title: t('Target'),
      key: 'target',
      render: (_: any, record: any) => {
        const repo = repoMap[record.repositoryId];
        const repoName = repo?.name || `#${record.repositoryId}`;
        if (record.targetType === 'mr') {
          return (
            <Space size={4}>
              <Text strong>{repoName}</Text>
              <Text type="secondary">!{record.mrIid}</Text>
            </Space>
          );
        }
        if (record.targetType === 'commit') {
          return (
            <Space size={4}>
              <Text strong>{repoName}</Text>
              <Text type="secondary" style={{ fontFamily: 'monospace' }}>
                {String(record.commitSha || '').slice(0, 7)}
              </Text>
            </Space>
          );
        }
        if (record.targetType === 'folder') {
          return (
            <Space size={4}>
              <Text strong>{repoName}</Text>
              <Text type="secondary">{record.folderPath || '/'}</Text>
              {record.branch && <Tag style={{ fontSize: 11 }}>{record.branch}</Tag>}
            </Space>
          );
        }
        return (
          <Space size={4}>
            <Text strong>{repoName}</Text>
            <Text type="secondary">{record.branch}</Text>
          </Space>
        );
      },
    },
    {
      title: t('Type'),
      dataIndex: 'targetType',
      width: 80,
      render: (v: string) => <Tag>{t(v.toUpperCase())}</Tag>,
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      width: 120,
      render: (v: string) => {
        const color = STATUS_COLOR[v] || 'default';
        const icon = v === 'running' ? <ClockCircleOutlined spin /> : null;
        return (
          <Tag color={color} icon={icon}>
            {t(v)}
          </Tag>
        );
      },
    },
    {
      title: t('Post Status'),
      dataIndex: 'postStatus',
      width: 140,
      render: (v: string) => <Tag color={POST_STATUS_COLOR[v] || 'default'}>{t(v)}</Tag>,
    },
    {
      title: t('Commit'),
      key: 'sha',
      width: 140,
      render: (_: any, record: any) => {
        const head = record.headSha;
        const latest = record.latestSha;
        const hasNew = head && latest && head !== latest;
        if (!head) return <Text type="secondary">—</Text>;
        return (
          <Space size={4}>
            <Tag style={{ fontFamily: 'monospace', fontSize: 11 }}>{String(head).slice(0, 7)}</Tag>
            {hasNew && (
              <Tooltip title={`${t('New commits')}: ${String(latest).slice(0, 7)}`}>
                <Tag color="orange" style={{ fontSize: 11 }}>
                  {t('new')}
                </Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: t('Trigger'),
      dataIndex: 'triggeredBy',
      width: 90,
      render: (v: string) => (
        <Tag color={v === 'poll' ? 'geekblue' : 'default'} style={{ fontSize: 11 }}>
          {v === 'poll' ? t('Polling') : t('Manual')}
        </Tag>
      ),
    },
    {
      title: t('Duration'),
      dataIndex: 'durationMs',
      width: 90,
      render: (v: number | null) => (v ? `${(v / 1000).toFixed(1)}s` : '—'),
    },
    {
      title: t('Created'),
      dataIndex: 'createdAt',
      width: 160,
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: any, record: any) => (
        <Tooltip title={t('View')}>
          <Button
            size="small"
            icon={<FileTextOutlined />}
            onClick={() => {
              setSelected(record);
              setEditing(false);
              setEditedMarkdown(record.reviewMarkdown || '');
            }}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          size="small"
          style={{ width: 140 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'all', label: t('All statuses') },
            { value: 'pending', label: t('pending') },
            { value: 'queued', label: t('queued') },
            { value: 'running', label: t('running') },
            { value: 'completed', label: t('completed') },
            { value: 'failed', label: t('failed') },
          ]}
        />
        <Select
          size="small"
          style={{ width: 180 }}
          value={postFilter}
          onChange={setPostFilter}
          options={[
            { value: 'all', label: t('All post statuses') },
            { value: 'pending_approval', label: t('pending_approval') },
            { value: 'approved', label: t('approved') },
            { value: 'posted', label: t('posted') },
            { value: 'post_failed', label: t('post_failed') },
            { value: 'post_unknown', label: t('post_unknown') },
            { value: 'posting', label: t('posting') },
            { value: 'skipped', label: t('skipped') },
            { value: 'rejected', label: t('rejected') },
          ]}
        />
        <Select
          size="small"
          style={{ width: 130 }}
          value={triggerFilter}
          onChange={setTriggerFilter}
          options={[
            { value: 'all', label: t('All triggers') },
            { value: 'manual', label: t('Manual') },
            { value: 'poll', label: t('Polling') },
          ]}
        />
        <Button size="small" icon={<ReloadOutlined />} onClick={reload}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={reviews}
        columns={columns}
        locale={{ emptyText: <Empty description={t('No reviews yet')} /> }}
        pagination={{ pageSize: 20 }}
        onRow={(record) => ({
          style: { cursor: 'pointer' },
          onClick: () => {
            setSelected(record);
            setEditing(false);
            setLegacyPost(null);
            setEditedMarkdown(record.reviewMarkdown || '');
          },
        })}
      />

      <Drawer
        title={
          selected ? (
            <Space>
              <RobotOutlined />
              <span>{t('Code Review')}</span>
              <Tag color={STATUS_COLOR[selected.status]}>{t(selected.status)}</Tag>
              <Tag color={POST_STATUS_COLOR[selected.postStatus]}>{t(selected.postStatus)}</Tag>
            </Space>
          ) : (
            t('Code Review')
          )
        }
        open={!!selected}
        onClose={() => {
          setSelected(null);
          setEditing(false);
        }}
        width={840}
        extra={
          selected && (
            <Space>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => refreshOne(selected.id)}>
                {t('Refresh')}
              </Button>
              {selected.targetType === 'mr' && (
                <Button
                  size="small"
                  icon={<ExportOutlined />}
                  onClick={() => {
                    const repo = repoMap[selected.repositoryId];
                    const url = repo?.repoUrl?.replace(/\.git$/, '');
                    if (url && selected.mrIid) {
                      window.open(`${url}/-/merge_requests/${selected.mrIid}`, '_blank');
                    }
                  }}
                >
                  {t('Open MR')}
                </Button>
              )}
            </Space>
          )
        }
      >
        {selected && (
          <ReviewDetailView
            review={selected}
            editing={editing}
            editedMarkdown={editedMarkdown}
            onEdit={() => setEditing(true)}
            onCancelEdit={() => {
              setEditing(false);
              setEditedMarkdown(selected.reviewMarkdown || '');
            }}
            onChangeMarkdown={setEditedMarkdown}
            onApprove={handleApprove}
            onReject={handleReject}
            onRetryPost={handleRetryPost}
            legacyPost={legacyPost?.reviewId === selected.id ? legacyPost : null}
            onLegacyPost={handleLegacyPost}
            reconcilingPost={reconcilingPost}
          />
        )}
      </Drawer>
    </div>
  );
};

const ReviewDetailView: React.FC<{
  review: any;
  editing: boolean;
  editedMarkdown: string;
  onEdit: () => void;
  onCancelEdit: () => void;
  onChangeMarkdown: (v: string) => void;
  onApprove: (markdown: string) => void;
  onReject: () => void;
  onRetryPost: (allowResend: boolean) => void;
  legacyPost: LegacyPostStatus | null;
  onLegacyPost: (action: 'check' | 'retry' | 'release') => void;
  reconcilingPost: boolean;
}> = ({
  review,
  editing,
  editedMarkdown,
  onEdit,
  onCancelEdit,
  onChangeMarkdown,
  onApprove,
  onReject,
  onRetryPost,
  legacyPost,
  onLegacyPost,
  reconcilingPost,
}) => {
  const t = useT();
  const { token } = useToken();
  const app = useApp();

  const canApprove =
    !review.metadata?.workflowManaged &&
    review.status === 'completed' &&
    review.targetType === 'mr' &&
    review.postStatus === 'pending_approval';
  const canRetryPost =
    review.metadata?.workflowManaged &&
    review.status !== 'running' &&
    review.targetType === 'mr' &&
    ['posting', 'post_unknown', 'post_failed', 'retrying'].includes(review.postStatus);
  const canCheckLegacy =
    !review.metadata?.workflowManaged &&
    review.targetType === 'mr' &&
    ['posting', 'post_unknown', 'post_failed'].includes(review.postStatus);

  return (
    <div>
      {review.metadata?.workflowManaged && review.postStatus === 'pending_approval' && (
        <Alert
          type="info"
          showIcon
          message={t('Use the workflow approval task for this review')}
          action={<Button href={reviewApprovalHref(app)}>{t('Open workflow tasks')}</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      {review.metadata?.workflowExecutionId && (
        <Button
          href={workflowHref(app, 'execution', review.metadata.workflowExecutionId)}
          target="_blank"
          rel="noreferrer"
          style={{ marginBottom: 16 }}
        >
          {t('Open workflow execution')}
        </Button>
      )}
      {canRetryPost && (
        <Space wrap style={{ marginBottom: 16 }}>
          <Button loading={reconcilingPost} onClick={() => onRetryPost(false)}>
            {t('Check publication')}
          </Button>
          <Popconfirm
            title={t('Has the previous outbound post stopped and settled?')}
            onConfirm={() => onRetryPost(true)}
          >
            <Button loading={reconcilingPost}>{t('Retry publication')}</Button>
          </Popconfirm>
        </Space>
      )}
      {canCheckLegacy && (
        <Space wrap style={{ marginBottom: 16 }}>
          <Button loading={reconcilingPost} onClick={() => onLegacyPost('check')}>
            {t('Check publication')}
          </Button>
          {legacyPost?.canRetry && (
            <Popconfirm
              title={t('Has the previous outbound post stopped and settled?')}
              description={
                legacyPost.baseUnverified && !legacyPost.baseAcknowledged
                  ? t(
                      'The original review base cannot be verified. Compare the review with the current merge request before continuing.',
                    )
                  : undefined
              }
              onConfirm={() => onLegacyPost('retry')}
            >
              <Button loading={reconcilingPost}>{t('Retry publication')}</Button>
            </Popconfirm>
          )}
          {legacyPost?.holdActive && (
            <Popconfirm
              title={t('Has the previous outbound post stopped and settled?')}
              onConfirm={() => onLegacyPost('release')}
            >
              <Button loading={reconcilingPost}>{t('Release legacy publication hold')}</Button>
            </Popconfirm>
          )}
        </Space>
      )}
      {canApprove && (
        <Alert
          type="warning"
          showIcon
          message={t(
            'The original review base cannot be verified. Compare the review with the current merge request before continuing.',
          )}
          style={{ marginBottom: 16 }}
        />
      )}
      {review.status === 'running' && (
        <Alert
          type="info"
          showIcon
          message={t('Review in progress…')}
          description={t('The AI employee is analyzing the code. This page will refresh automatically.')}
          style={{ marginBottom: 16 }}
        />
      )}
      {review.status === 'failed' && (
        <Alert
          type="error"
          showIcon
          message={t('Review failed')}
          description={<pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{review.error}</pre>}
          style={{ marginBottom: 16 }}
        />
      )}
      {review.status === 'completed' && review.postStatus === 'post_failed' && review.error && (
        <Alert
          type="error"
          showIcon
          message={t('Post Failed')}
          description={<pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{review.error}</pre>}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Action bar */}
      {canApprove && (
        <Space style={{ marginBottom: 16 }} wrap>
          {!editing ? (
            <>
              <Popconfirm
                title={t(
                  'The original review base cannot be verified. Compare the review with the current merge request before continuing.',
                )}
                onConfirm={() => onApprove(review.reviewMarkdown)}
              >
                <Button type="primary" icon={<CheckOutlined />}>
                  {t('Approve & Post')}
                </Button>
              </Popconfirm>
              <Button icon={<EditOutlined />} onClick={onEdit}>
                {t('Edit & Post')}
              </Button>
              <Popconfirm title={t('Reject this review?')} onConfirm={onReject}>
                <Button danger icon={<CloseOutlined />}>
                  {t('Reject')}
                </Button>
              </Popconfirm>
            </>
          ) : (
            <>
              <Popconfirm
                title={t(
                  'The original review base cannot be verified. Compare the review with the current merge request before continuing.',
                )}
                onConfirm={() => onApprove(editedMarkdown)}
              >
                <Button type="primary" icon={<CheckOutlined />}>
                  {t('Save & Post')}
                </Button>
              </Popconfirm>
              <Button onClick={onCancelEdit}>{t('Cancel')}</Button>
            </>
          )}
        </Space>
      )}

      {/* Body */}
      <Tabs
        defaultActiveKey="content"
        items={[
          {
            key: 'content',
            label: t('Review Content'),
            children: editing ? (
              <Input.TextArea
                value={editedMarkdown}
                onChange={(e) => onChangeMarkdown(e.target.value)}
                autoSize={{ minRows: 16, maxRows: 40 }}
                style={{ fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace", fontSize: 13 }}
              />
            ) : review.reviewMarkdown ? (
              <div
                style={{
                  background: token.colorBgLayout,
                  padding: 16,
                  borderRadius: 8,
                  maxHeight: '70vh',
                  overflowY: 'auto',
                }}
              >
                <MarkdownView content={review.reviewMarkdown} />
              </div>
            ) : (
              <Empty description={t('No content yet')} />
            ),
          },
          {
            key: 'metadata',
            label: t('Metadata'),
            children: (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 13 }}>
                <Meta label={t('Status')} value={review.status} />
                <Meta label={t('Post Status')} value={review.postStatus} />
                <Meta label={t('Trigger Type')} value={review.targetType} />
                {review.targetType === 'folder' && <Meta label={t('Folder')} value={review.folderPath || '/'} />}
                <Meta label={t('Triggered By')} value={review.triggeredBy} />
                <Meta label={t('Reviewed SHA')} value={review.headSha || '—'} />
                <Meta label={t('Latest SHA')} value={review.latestSha || '—'} />
                <Meta label={t('Started At')} value={review.startedAt && new Date(review.startedAt).toLocaleString()} />
                <Meta
                  label={t('Finished At')}
                  value={review.finishedAt && new Date(review.finishedAt).toLocaleString()}
                />
                <Meta
                  label={t('Duration')}
                  value={review.durationMs ? `${(review.durationMs / 1000).toFixed(1)}s` : '—'}
                />
                <Meta label={t('Posted Note ID')} value={review.postedNoteId || '—'} />
                <Meta label={t('Approved By')} value={review.approvedBy || '—'} />
                <Meta
                  label={t('Approved At')}
                  value={review.approvedAt && new Date(review.approvedAt).toLocaleString()}
                />
                <Meta label={t('Session ID')} value={review.sessionId || '—'} />
                <Meta label={t('Flow ID')} value={review.flowId || '—'} />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
};

const Meta: React.FC<{ label: string; value: any }> = ({ label, value }) => (
  <div>
    <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
      {label}
    </Text>
    <div style={{ wordBreak: 'break-all' }}>{value || '—'}</div>
  </div>
);
