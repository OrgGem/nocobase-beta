/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useApp, getRouteRuntimeVersion, getV2EffectiveBasePath, stripModernClientPrefix } from '@nocobase/client-v2';
import { getWorkflowCanvasPath } from '@nocobase/plugin-workflow/client-v2';
import { Alert, Button, Card, Input, List, Popconfirm, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { useT } from './locale';

type ID = string | number;
type FlowStatus = {
  flowId: ID;
  name: string;
  workflowId: ID | null;
  workflowKey: string | null;
  enabled: boolean;
  blockers: string[];
  template: 'quick' | 'full';
  approverIds: ID[];
  canWrite?: boolean;
};
type CutoverStatus = {
  state: string;
  canConfirmCutover?: boolean;
  legacyPending: number;
  legacyRunning: number;
  quarantined: Array<{ requestId: ID; executionId: ID | null; reviewId: ID; reason: string; canWrite?: boolean }>;
  legacyRunningReviews: Array<{ legacyReviewId: ID; canWrite?: boolean }>;
  legacyPendingReviews?: Array<{ legacyReviewId: ID; repositoryId: ID; reason?: string; canWrite?: boolean }>;
  legacyUncertainReviews?: Array<{ legacyReviewId: ID; repositoryId: ID }>;
  orphaned?: Array<{ inboxId: ID; reviewId: ID; canWrite?: boolean }>;
  postUnknownReviews?: Array<{
    reviewId: ID;
    postStatus: string;
    hasClaim: boolean;
    attemptId: string | null;
    canWrite?: boolean;
  }>;
  queuedBlockedReviews?: Array<{ inboxId: ID; reviewId: ID; repositoryId: ID; reason: string; canWrite?: boolean }>;
  legacyPublicationHolds?: Array<{
    reviewId: ID;
    repositoryId: ID | null;
    attemptId: string | null;
    canWrite?: boolean;
  }>;
};

function FlowCard({ flow, refresh }: { flow: FlowStatus; refresh: () => Promise<void> }) {
  const app = useApp();
  const t = useT();
  const [template, setTemplate] = useState<'quick' | 'full'>(flow.template);
  const [approvers, setApprovers] = useState(flow.approverIds.map(String).join(', '));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setTemplate(flow.template);
    setApprovers(flow.approverIds.map(String).join(', '));
  }, [flow.template, flow.approverIds]);

  const submit = async () => {
    const ids = approvers
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.some((id) => !/^\d+$/.test(id))) {
      message.error(t('Approver IDs must be numbers'));
      return;
    }
    setSaving(true);
    try {
      await app.apiClient.request({
        url: `workflowGitReview:${flow.workflowId ? 'repair' : 'setup'}`,
        method: 'post',
        data: { flowId: flow.flowId, template, approverIds: ids },
      });
      await refresh();
      message.success(t('Workflow setup updated'));
    } catch (_error) {
      message.error(t('Could not set up the review workflow'));
    } finally {
      setSaving(false);
    }
  };
  const path =
    flow.workflowId == null
      ? null
      : getRouteRuntimeVersion() === 'modern'
        ? getWorkflowCanvasPath(flow.workflowId)
        : `/admin/settings/workflow/workflows/${flow.workflowId}`;

  return (
    <Card
      title={flow.name || String(flow.flowId)}
      extra={<Tag color={flow.enabled ? 'green' : 'default'}>{t(flow.enabled ? 'Enabled' : 'Disabled')}</Tag>}
      size="small"
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {flow.blockers.map((blocker) => (
          <Alert key={blocker} type="warning" message={t(blocker)} showIcon />
        ))}
        <label htmlFor={`template-${flow.flowId}`}>{t('Starter template')}</label>
        <Select
          id={`template-${flow.flowId}`}
          disabled={flow.canWrite === false}
          value={template}
          onChange={setTemplate}
          options={[
            { value: 'quick', label: t('Quick') },
            { value: 'full', label: t('Full') },
          ]}
          style={{ width: '100%' }}
        />
        <label htmlFor={`approvers-${flow.flowId}`}>{t('Approver user IDs, separated by commas')}</label>
        <Input
          id={`approvers-${flow.flowId}`}
          disabled={flow.canWrite === false}
          value={approvers}
          onChange={(event) => setApprovers(event.target.value)}
        />
        <Space wrap>
          {flow.canWrite !== false && (
            <Popconfirm
              title={t('Create a new workflow revision?')}
              onConfirm={submit}
              okText={t('Create revision')}
              cancelText={t('Cancel')}
            >
              <Button loading={saving}>{t(flow.workflowId ? 'Create revision' : 'Set up workflow')}</Button>
            </Popconfirm>
          )}
          {path && (
            <Button
              href={`${(getRouteRuntimeVersion() === 'modern'
                ? getV2EffectiveBasePath(app)
                : stripModernClientPrefix(window.__nocobase_public_path__ || app.getPublicPath())
              ).replace(/\/+$/, '')}${path}`}
            >
              {t('Open workflow')}
            </Button>
          )}
        </Space>
      </Space>
    </Card>
  );
}

export default function Settings() {
  const app = useApp();
  const t = useT();
  const [flows, setFlows] = useState<FlowStatus[]>([]);
  const [cutover, setCutover] = useState<CutoverStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await app.apiClient.request({ url: 'workflowGitReview:status' });
      setFlows(result.data?.data?.flows ?? []);
      try {
        const state = await app.apiClient.request({ url: 'gitManager:reviewCutoverStatus' });
        const payload = state.data?.data;
        setCutover(payload?.success ? payload.data : payload ?? null);
      } catch (_error) {
        setCutover(null);
      }
    } catch (_error) {
      message.error(t('Could not load workflow status'));
    } finally {
      setLoading(false);
    }
  }, [app.apiClient, t]);
  useEffect(() => {
    load();
  }, [load]);

  const confirmCutover = async () => {
    try {
      await app.apiClient.request({
        url: 'gitManager:reviewConfirmCutover',
        method: 'post',
        data: { confirmation: 'OLD_WORKERS_AND_AI_STOPPED' },
      });
      await load();
    } catch (_error) {
      message.error(t('Could not confirm cutover'));
    }
  };
  const recover = async (
    target: { requestId: ID; executionId: ID | null } | { legacyReviewId: ID } | { inboxId: ID },
  ) => {
    try {
      await app.apiClient.request({
        url: 'gitManager:reviewRecover',
        method: 'post',
        data: { confirmation: 'AI_STOPPED', ...target },
      });
      await load();
      message.success(t('Recovery recorded'));
    } catch (error: unknown) {
      const responseError = error as { response?: { data?: { errors?: Array<{ message?: string }> } } } | null;
      message.error(responseError?.response?.data?.errors?.[0]?.message || t('Could not recover review'));
    }
  };
  const cancelLegacy = async (legacyReviewId: ID) => {
    try {
      await app.apiClient.request({
        url: 'gitManager:reviewCancelLegacy',
        method: 'post',
        data: { confirmation: 'CANCEL_LEGACY_REVIEW', legacyReviewId },
      });
      await load();
      message.success(t('Legacy review cancelled'));
    } catch (_error) {
      message.error(t('Could not cancel legacy review'));
    }
  };
  const retryPost = async (reviewId: ID, stopped: boolean) => {
    try {
      const response = await app.apiClient.request({
        url: 'gitManager:reviewWorkflowRetryPost',
        method: 'post',
        data: { reviewId, ...(stopped ? { confirmation: 'OUTBOUND_POST_STOPPED' } : {}) },
      });
      const payload = response.data?.data;
      const result = payload?.success ? payload.data : payload;
      if (result?.status === 'posted') message.success(t('Review publication confirmed'));
      else if (result?.status === 'observed')
        message.info(t('Matching comment found; another publication attempt still owns the review'));
      else message.warning(t('Publication is still unconfirmed'));
      await load();
    } catch (_error) {
      message.error(t('Could not reconcile review publication'));
    }
  };
  const resetPostClaim = async (reviewId: ID, expectedAttempt: string | null) => {
    try {
      await app.apiClient.request({
        url: 'gitManager:reviewResetPostClaim',
        method: 'post',
        data: { reviewId, expectedAttempt, confirmation: 'OUTBOUND_POST_STOPPED' },
      });
      await load();
      message.success(t('Publication claim reset'));
    } catch (error: unknown) {
      const responseError = error as { response?: { data?: { errors?: Array<{ message?: string }> } } } | null;
      message.error(responseError?.response?.data?.errors?.[0]?.message || t('Could not reset publication claim'));
    }
  };
  const cancelQueued = async (inboxId: ID) => {
    try {
      await app.apiClient.request({
        url: 'gitManager:reviewCancelQueued',
        method: 'post',
        data: { inboxId, confirmation: 'CANCEL_QUEUED_REVIEW' },
      });
      await load();
      message.success(t('Queued review cancelled'));
    } catch (_error) {
      message.error(t('Could not cancel queued review'));
    }
  };
  const releaseLegacyHold = async (reviewId: ID, expectedAttempt: string | null) => {
    try {
      await app.apiClient.request({
        url: 'gitManager:reviewLegacyReleaseHold',
        method: 'post',
        data: { reviewId, expectedAttempt, confirmation: 'OUTBOUND_POST_STOPPED' },
      });
      await load();
      message.success(t('Legacy publication hold released'));
    } catch (_error) {
      message.error(t('Could not release legacy publication hold'));
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3}>{t('Git Review Workflows')}</Typography.Title>
      <Typography.Paragraph>
        {t('Configure each Git review flow, then open its native workflow to inspect or edit it.')}
      </Typography.Paragraph>
      {cutover && cutover.state !== 'ready' && (
        <Alert
          type="warning"
          showIcon
          message={t('Legacy worker cutover requires confirmation')}
          description={t(
            'Confirm only after every old worker and its AI calls have stopped. Uncertain reviews remain quarantined.',
          )}
          action={
            cutover.canConfirmCutover !== false && (
              <Popconfirm
                title={t('Have all old workers and AI calls stopped?')}
                onConfirm={confirmCutover}
                okText={t('Confirm')}
                cancelText={t('Cancel')}
              >
                <Button>{t('Confirm cutover')}</Button>
              </Popconfirm>
            )
          }
        />
      )}
      {Boolean(cutover?.legacyPendingReviews?.length) && (
        <Card title={t('Pending legacy reviews')}>
          <List
            dataSource={cutover?.legacyPendingReviews ?? []}
            renderItem={(item) => (
              <List.Item
                actions={
                  item.canWrite === false
                    ? []
                    : [
                        <Popconfirm
                          key="cancel"
                          title={t('Cancel this legacy review?')}
                          onConfirm={() => cancelLegacy(item.legacyReviewId)}
                          okText={t('Cancel review')}
                          cancelText={t('Back')}
                        >
                          <Button danger>{t('Cancel review')}</Button>
                        </Popconfirm>,
                      ]
                }
              >
                <Space direction="vertical">
                  <span>
                    {t('Legacy review')} {item.legacyReviewId}
                  </span>
                  {item.reason && <Typography.Text type="secondary">{t(item.reason)}</Typography.Text>}
                </Space>
              </List.Item>
            )}
          />
        </Card>
      )}
      {Boolean(cutover?.legacyUncertainReviews?.length) && (
        <Alert
          type="warning"
          showIcon
          message={t('Some failed legacy reviews have uncertain AI state.')}
          description={t('These historical records are informational; check the old provider and worker state.')}
        />
      )}
      {Boolean(cutover?.queuedBlockedReviews?.length) && (
        <Card title={t('Blocked queued reviews')}>
          <List
            dataSource={cutover?.queuedBlockedReviews ?? []}
            renderItem={(item) => (
              <List.Item
                actions={
                  item.canWrite === false
                    ? []
                    : [
                        <Popconfirm
                          key="cancel"
                          title={t('Cancel this queued review?')}
                          onConfirm={() => cancelQueued(item.inboxId)}
                          okText={t('Cancel review')}
                          cancelText={t('Back')}
                        >
                          <Button danger>{t('Cancel review')}</Button>
                        </Popconfirm>,
                      ]
                }
              >
                <Space direction="vertical">
                  <span>
                    {t('Review')} {item.reviewId} / {t('Queue item')} {item.inboxId}
                  </span>
                  <Typography.Text type="secondary">{t(item.reason)}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </Card>
      )}
      {cutover &&
        (Boolean(cutover.quarantined?.length) ||
          Boolean(cutover.legacyRunningReviews?.length) ||
          Boolean(cutover.orphaned?.length)) && (
          <Card title={t('Quarantined reviews')}>
            <Typography.Paragraph>
              {t('Recover only after confirming that the underlying AI work has stopped.')}
            </Typography.Paragraph>
            <List
              dataSource={[
                ...(cutover.quarantined ?? []).map((item) => ({
                  key: `request-${item.requestId}`,
                  label: `${t('Review')} ${item.reviewId}${
                    item.executionId == null ? '' : ` / ${t('Execution')} ${item.executionId}`
                  } — ${t(item.reason)}`,
                  target: { requestId: item.requestId, executionId: item.executionId },
                  canWrite: item.canWrite,
                })),
                ...(cutover.legacyRunningReviews ?? []).map((item) => ({
                  key: `legacy-${item.legacyReviewId}`,
                  label: `${t('Legacy review')} ${item.legacyReviewId}`,
                  target: { legacyReviewId: item.legacyReviewId },
                  canWrite: item.canWrite,
                })),
                ...(cutover.orphaned ?? []).map((item) => ({
                  key: `orphaned-${item.inboxId}`,
                  label: `${t('Review')} ${item.reviewId} / ${t('Queue item')} ${item.inboxId}`,
                  target: { inboxId: item.inboxId },
                  canWrite: item.canWrite,
                })),
              ]}
              renderItem={(item) => (
                <List.Item
                  key={item.key}
                  actions={
                    item.canWrite === false
                      ? []
                      : [
                          <Popconfirm
                            key="recover"
                            title={t('Has all underlying AI work stopped?')}
                            onConfirm={() => recover(item.target)}
                            okText={t('Recover')}
                            cancelText={t('Cancel')}
                          >
                            <Button>{t('Recover')}</Button>
                          </Popconfirm>,
                        ]
                  }
                >
                  {item.label}
                </List.Item>
              )}
            />
          </Card>
        )}
      {Boolean(cutover?.postUnknownReviews?.length) && (
        <Card title={t('Unconfirmed publications')}>
          <Typography.Paragraph>
            {t(
              'Check the provider first. Resend only after confirming that the previous outbound request has stopped.',
            )}
          </Typography.Paragraph>
          <List
            dataSource={cutover?.postUnknownReviews ?? []}
            renderItem={(item) => (
              <List.Item
                actions={
                  item.canWrite === false
                    ? []
                    : [
                        <Button key="check" onClick={() => retryPost(item.reviewId, false)}>
                          {t('Check publication')}
                        </Button>,
                        <Popconfirm
                          key="reset"
                          title={t('Has the previous outbound request stopped?')}
                          onConfirm={() => resetPostClaim(item.reviewId, item.attemptId)}
                          okText={t('Release publication hold')}
                          cancelText={t('Cancel')}
                        >
                          <Button>{t('Release publication hold')}</Button>
                        </Popconfirm>,
                        ...(!item.hasClaim
                          ? [
                              <Popconfirm
                                key="resend"
                                title={t('Has the previous outbound request stopped?')}
                                onConfirm={() => retryPost(item.reviewId, true)}
                                okText={t('Resend')}
                                cancelText={t('Cancel')}
                              >
                                <Button>{t('Resend')}</Button>
                              </Popconfirm>,
                            ]
                          : []),
                      ]
                }
              >
                {t('Review')} {item.reviewId} ({item.postStatus})
              </List.Item>
            )}
          />
        </Card>
      )}
      {Boolean(cutover?.legacyPublicationHolds?.length) && (
        <Card title={t('Legacy publication holds')}>
          <Typography.Paragraph>
            {t('Confirm that the previous outbound request has stopped before releasing a hold.')}
          </Typography.Paragraph>
          <List
            dataSource={cutover?.legacyPublicationHolds ?? []}
            renderItem={(item) => (
              <List.Item
                actions={
                  item.repositoryId == null || item.canWrite === false
                    ? []
                    : [
                        <Popconfirm
                          key="release"
                          title={t('Has the previous outbound request stopped?')}
                          onConfirm={() => releaseLegacyHold(item.reviewId, item.attemptId)}
                        >
                          <Button>{t('Release publication hold')}</Button>
                        </Popconfirm>,
                      ]
                }
              >
                {t('Review')} {item.reviewId} /{' '}
                {item.repositoryId == null
                  ? t('Repository unavailable; investigate this legacy hold')
                  : `${t('Repository')} ${item.repositoryId}`}
              </List.Item>
            )}
          />
        </Card>
      )}
      <Button onClick={load}>{t('Refresh')}</Button>
      <Spin spinning={loading}>
        <List
          dataSource={flows}
          locale={{ emptyText: t('Create a review flow in Git Manager first.') }}
          renderItem={(flow) => (
            <List.Item>
              <FlowCard flow={flow} refresh={load} />
            </List.Item>
          )}
        />
      </Spin>
    </Space>
  );
}
