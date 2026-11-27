// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useState } from 'react';
import { useApp, getRouteRuntimeVersion, getV2EffectiveBasePath, stripModernClientPrefix } from '@nocobase/client-v2';
import { getWorkflowCanvasPath } from '@nocobase/plugin-workflow/client-v2';
import { BranchesOutlined, LinkOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Input,
  List,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useT } from './locale';

type ID = string | number;
type TriggerMode = 'manual' | 'onMergeRequestCreated' | 'both';
type PostMode = 'manual' | 'auto' | 'disabled';

type FlowStatus = {
  flowId: ID;
  name: string;
  repositoryId?: ID | null;
  repositoryName?: string | null;
  flowEnabled?: boolean;
  triggerMode?: TriggerMode;
  postMode?: PostMode;
  aiEmployeeUsername?: string | null;
  llmService?: string | null;
  model?: string | null;
  workflowId: ID | null;
  draftWorkflowId?: ID;
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

function parseApproverIds(raw: string): { ids: string[]; valid: boolean } {
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return { ids, valid: ids.every((id) => /^\d+$/.test(id)) };
}

function triggerLabelKey(mode?: TriggerMode): string {
  if (mode === 'onMergeRequestCreated') return 'Trigger: On MR created';
  if (mode === 'both') return 'Trigger: Manual & MR';
  return 'Trigger: Manual';
}

function postLabelKey(mode?: PostMode): { key: string; color: string } {
  if (mode === 'auto') return { key: 'Publish: Auto post', color: 'cyan' };
  if (mode === 'disabled') return { key: 'Publish: Save only', color: 'default' };
  return { key: 'Publish: Manual approval', color: 'gold' };
}

function FlowCard({ flow, refresh }: { flow: FlowStatus; refresh: () => Promise<void> }) {
  const app = useApp();
  const t = useT();
  const [template, setTemplate] = useState<'quick' | 'full'>(flow.template);
  const [approvers, setApprovers] = useState(flow.approverIds.map(String).join(', '));
  const [approverError, setApproverError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTemplate(flow.template);
    setApprovers(flow.approverIds.map(String).join(', '));
    setApproverError(null);
  }, [flow.template, flow.approverIds]);

  const validateApprovers = (raw = approvers): string[] | null => {
    const parsed = parseApproverIds(raw);
    if (!parsed.valid) {
      const errorText = t('Approver IDs must be numbers');
      setApproverError(errorText);
      return null;
    }
    setApproverError(null);
    return parsed.ids;
  };

  const submit = async () => {
    const ids = validateApprovers();
    if (!ids) {
      message.error(t('Approver IDs must be numbers'));
      return;
    }
    setSaving(true);
    try {
      const response = await app.apiClient.request({
        url: `workflowGitReview:${flow.workflowId ? 'repair' : 'setup'}`,
        method: 'post',
        data: { flowId: flow.flowId, template, approverIds: ids },
      });
      await refresh();
      const result = response.data?.data;
      if (result?.draftWorkflowId || !result?.enabled) message.warning(t('Revision saved as draft'));
      else message.success(t('Workflow setup updated'));
    } catch (_error) {
      message.error(t('Could not set up the review workflow'));
    } finally {
      setSaving(false);
    }
  };

  const workflowPath = (id?: ID | null) =>
    id == null
      ? null
      : getRouteRuntimeVersion() === 'modern'
        ? getWorkflowCanvasPath(id)
        : `/admin/settings/workflow/workflows/${id}`;
  const base = (
    getRouteRuntimeVersion() === 'modern'
      ? getV2EffectiveBasePath(app)
      : stripModernClientPrefix(window.__nocobase_public_path__ || app.getPublicPath())
  ).replace(/\/+$/, '');

  const flowTitle = flow.name || String(flow.flowId);
  const headingId = `flow-heading-${flow.flowId}`;
  const templateId = `template-${flow.flowId}`;
  const templateHintId = `template-hint-${flow.flowId}`;
  const approversId = `approvers-${flow.flowId}`;
  const approversHintId = `approvers-hint-${flow.flowId}`;
  const approversErrorId = `approvers-error-${flow.flowId}`;
  const actionLabel = t(flow.workflowId ? 'Create revision' : 'Set up workflow');
  const postBadge = postLabelKey(flow.postMode);
  const manualPublish = (flow.postMode ?? 'manual') === 'manual';

  const repositoryDisplay = flow.repositoryName
    ? `${flow.repositoryName}${flow.repositoryId != null ? ` (#${flow.repositoryId})` : ''}`
    : flow.repositoryId != null
      ? `#${flow.repositoryId}`
      : '—';

  return (
    <article aria-labelledby={headingId} style={{ inlineSize: '100%', minInlineSize: 0 }}>
      <Card
        style={{ height: '100%', inlineSize: '100%' }}
        title={
          <span id={headingId}>
            <BranchesOutlined aria-hidden="true" style={{ marginInlineEnd: 8 }} />
            {flowTitle}
          </span>
        }
        extra={
          <Space size={6} wrap>
            {flow.flowEnabled === false && <Tag>{t('Flow disabled')}</Tag>}
            {flow.draftWorkflowId != null && <Tag color="orange">{t('Draft available')}</Tag>}
            <Tag color={flow.enabled ? 'green' : 'default'}>{t(flow.enabled ? 'Enabled' : 'Disabled')}</Tag>
          </Space>
        }
      >
        <Flex vertical gap={16} style={{ inlineSize: '100%' }}>
          {flow.blockers.length > 0 && (
            <Flex vertical gap={8} style={{ inlineSize: '100%' }}>
              {flow.blockers.map((blocker) => (
                <Alert key={blocker} type="warning" message={t(blocker)} showIcon />
              ))}
            </Flex>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
              gap: 20,
              inlineSize: '100%',
              alignItems: 'start',
            }}
          >
            <div style={{ minInlineSize: 0 }}>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label={t('Repository')}>
                  <Typography.Text strong={Boolean(flow.repositoryName)}>{repositoryDisplay}</Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label={t('Trigger & publish')}>
                  <Space size={6} wrap>
                    <Tag color="blue">{t(triggerLabelKey(flow.triggerMode))}</Tag>
                    <Tag color={postBadge.color}>{t(postBadge.key)}</Tag>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('AI reviewer')}>
                  <Space size={6} wrap>
                    <Typography.Text>{flow.aiEmployeeUsername ? `@${flow.aiEmployeeUsername}` : '—'}</Typography.Text>
                    {flow.model ? <Typography.Text code>{flow.model}</Typography.Text> : null}
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label={t('Bound workflow')}>
                  {flow.workflowId != null ? (
                    <Space size={6} wrap>
                      {flow.workflowKey ? <Typography.Text code>{flow.workflowKey}</Typography.Text> : null}
                      <Typography.Text type="secondary">#{String(flow.workflowId)}</Typography.Text>
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">{t('Not created')}</Typography.Text>
                  )}
                </Descriptions.Item>
              </Descriptions>
            </div>

            <form
              aria-labelledby={headingId}
              onSubmit={(event) => {
                event.preventDefault();
              }}
              style={{ minInlineSize: 0, display: 'flex', flexDirection: 'column', gap: 14 }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label htmlFor={templateId} style={{ fontWeight: 500 }}>
                  {t('Starter template')}
                </label>
                <Select
                  id={templateId}
                  aria-describedby={templateHintId}
                  disabled={flow.canWrite === false}
                  value={template}
                  onChange={setTemplate}
                  options={[
                    { value: 'quick', label: t('Quick') },
                    { value: 'full', label: t('Full') },
                  ]}
                  style={{ inlineSize: '100%' }}
                />
                <Typography.Text id={templateHintId} type="secondary" style={{ fontSize: 12 }}>
                  {t('Quick runs correctness + synthesis; Full adds security and change impact passes.')}
                </Typography.Text>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label htmlFor={approversId} style={{ fontWeight: 500 }}>
                  {t('Approver user IDs, separated by commas')}
                </label>
                <Input
                  id={approversId}
                  name="approverIds"
                  inputMode="numeric"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  status={approverError ? 'error' : undefined}
                  aria-invalid={approverError ? true : undefined}
                  aria-describedby={approverError ? `${approversHintId} ${approversErrorId}` : approversHintId}
                  disabled={flow.canWrite === false}
                  value={approvers}
                  onChange={(event) => {
                    setApprovers(event.target.value);
                    if (approverError && parseApproverIds(event.target.value).valid) {
                      setApproverError(null);
                    }
                  }}
                  onBlur={(event) => {
                    if (event.target.value.trim()) validateApprovers(event.target.value);
                  }}
                />
                <Typography.Text id={approversHintId} type="secondary" style={{ fontSize: 12 }}>
                  {manualPublish
                    ? t('Example: 1, 2. Required when publish mode uses manual approval.')
                    : t('Used only when publish mode is set to manual approval in Git Manager.')}
                </Typography.Text>
                {approverError && (
                  <Typography.Text id={approversErrorId} type="danger" role="alert" style={{ fontSize: 12 }}>
                    {approverError}
                  </Typography.Text>
                )}
              </div>

              <Flex wrap="wrap" gap={8} align="center" style={{ marginBlockStart: 2 }}>
                {flow.canWrite !== false && (
                  <Popconfirm
                    title={t('Create a new workflow revision?')}
                    onConfirm={submit}
                    okText={t('Create revision')}
                    cancelText={t('Cancel')}
                  >
                    <Button
                      type="primary"
                      htmlType="button"
                      icon={<SyncOutlined />}
                      loading={saving}
                      aria-label={`${actionLabel} ${flowTitle}`}
                    >
                      {actionLabel}
                    </Button>
                  </Popconfirm>
                )}
                {flow.workflowId != null && (
                  <Button
                    icon={<LinkOutlined />}
                    href={base + workflowPath(flow.workflowId)}
                    aria-label={`${t('Open workflow')} ${flowTitle}`}
                  >
                    {t('Open workflow')}
                  </Button>
                )}
                {flow.draftWorkflowId != null && (
                  <Button
                    icon={<LinkOutlined />}
                    href={base + workflowPath(flow.draftWorkflowId)}
                    aria-label={`${t('Open draft revision')} ${flowTitle}`}
                  >
                    {t('Open draft revision')}
                  </Button>
                )}
              </Flex>
            </form>
          </div>
        </Flex>
      </Card>
    </article>
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

  const enabledCount = flows.filter((item) => item.enabled).length;

  return (
    <Card
      style={{ inlineSize: '100%' }}
      title={
        <Space size={8} wrap>
          <span>{t('Git Review Workflows')}</span>
          <Tag color="blue">
            {flows.length} {t('Flows')}
          </Tag>
          {enabledCount > 0 && (
            <Tag color="green">
              {enabledCount} {t('Active')}
            </Tag>
          )}
        </Space>
      }
      extra={
        <Button htmlType="button" icon={<ReloadOutlined />} loading={loading} onClick={load}>
          {t('Refresh')}
        </Button>
      }
    >
      <Flex vertical gap={16} style={{ inlineSize: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={t('Configure each Git review flow, then open its native workflow to inspect or edit it.')}
        />

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
                  <Button htmlType="button">{t('Confirm cutover')}</Button>
                </Popconfirm>
              )
            }
          />
        )}

        {Boolean(cutover?.legacyPendingReviews?.length) && (
          <Card size="small" title={t('Pending legacy reviews')} style={{ inlineSize: '100%' }}>
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
                            <Button htmlType="button" danger>
                              {t('Cancel review')}
                            </Button>
                          </Popconfirm>,
                        ]
                  }
                >
                  <Space direction="vertical" size={2}>
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
          <Card size="small" title={t('Blocked queued reviews')} style={{ inlineSize: '100%' }}>
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
                            <Button htmlType="button" danger>
                              {t('Cancel review')}
                            </Button>
                          </Popconfirm>,
                        ]
                  }
                >
                  <Space direction="vertical" size={2}>
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
            <Card size="small" title={t('Quarantined reviews')} style={{ inlineSize: '100%' }}>
              <Typography.Paragraph type="secondary" style={{ marginBlockEnd: 8 }}>
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
                              <Button htmlType="button">{t('Recover')}</Button>
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
          <Card size="small" title={t('Unconfirmed publications')} style={{ inlineSize: '100%' }}>
            <Typography.Paragraph type="secondary" style={{ marginBlockEnd: 8 }}>
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
                          <Button key="check" htmlType="button" onClick={() => retryPost(item.reviewId, false)}>
                            {t('Check publication')}
                          </Button>,
                          <Popconfirm
                            key="reset"
                            title={t('Has the previous outbound request stopped?')}
                            onConfirm={() => resetPostClaim(item.reviewId, item.attemptId)}
                            okText={t('Release publication hold')}
                            cancelText={t('Cancel')}
                          >
                            <Button htmlType="button">{t('Release publication hold')}</Button>
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
                                  <Button htmlType="button">{t('Resend')}</Button>
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
          <Card size="small" title={t('Legacy publication holds')} style={{ inlineSize: '100%' }}>
            <Typography.Paragraph type="secondary" style={{ marginBlockEnd: 8 }}>
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
                            <Button htmlType="button">{t('Release publication hold')}</Button>
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

        <Spin spinning={loading}>
          {flows.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('Create a review flow in Git Manager first.')}
              style={{ paddingBlock: 32 }}
            />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 540px), 1fr))',
                gap: 16,
                inlineSize: '100%',
                alignItems: 'stretch',
              }}
            >
              {flows.map((flow) => (
                <FlowCard key={String(flow.flowId)} flow={flow} refresh={load} />
              ))}
            </div>
          )}
        </Spin>
      </Flex>
    </Card>
  );
}
