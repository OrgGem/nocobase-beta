/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useWorkflowTaskRecord, type TaskTypeOptions } from '@nocobase/plugin-workflow/client-v2';
import { Alert, Button, Card, Popconfirm, Space, Spin, Typography, message } from 'antd';
import { tExpr, useT } from './locale';

type ApprovalDetail = { id: string | number; markdown: string; fingerprint: string };

function ApprovalItem() {
  const { record } = useWorkflowTaskRecord();
  const t = useT();
  return <Card size="small" hoverable title={String(record.title ?? t('Review approval'))} />;
}

function ApprovalDetailView() {
  const app = useApp();
  const t = useT();
  const { record, refresh } = useWorkflowTaskRecord();
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    app.apiClient
      .request({ url: 'workflowGitReview:approval', params: { filterByTk: record.id } })
      .then((response) => {
        if (!cancelled) setDetail(response.data?.data ?? null);
      })
      .catch(() => {
        if (!cancelled) message.error(t('Review task is unavailable'));
      });
    return () => {
      cancelled = true;
    };
  }, [app.apiClient, record.id, t]);

  const submit = async (decision: 'approve' | 'reject') => {
    if (!detail) return;
    setBusy(true);
    try {
      await app.apiClient.request({
        url: 'workflowManualTasks:submit',
        method: 'post',
        params: { filterByTk: detail.id },
        data: { result: { review: { fingerprint: detail.fingerprint }, _: decision } },
      });
      setDetail(null);
      await refresh?.();
      message.success(t('Decision submitted'));
    } catch (_error) {
      message.error(t('Could not submit the decision'));
    } finally {
      setBusy(false);
    }
  };

  if (!detail)
    return (
      <Spin spinning={busy}>
        <Alert type="info" message={t('Review task is unavailable')} />
      </Spin>
    );
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text>
        {t('Review fingerprint')}: <Typography.Text code>{detail.fingerprint}</Typography.Text>
      </Typography.Text>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '55vh', overflow: 'auto' }}>
        {detail.markdown}
      </pre>
      <Space>
        <Popconfirm
          title={t('Approve this exact review?')}
          onConfirm={() => submit('approve')}
          okText={t('Approve')}
          cancelText={t('Cancel')}
        >
          <Button type="primary" loading={busy}>
            {t('Approve')}
          </Button>
        </Popconfirm>
        <Popconfirm
          title={t('Reject this review?')}
          onConfirm={() => submit('reject')}
          okText={t('Reject')}
          cancelText={t('Cancel')}
        >
          <Button danger loading={busy}>
            {t('Reject')}
          </Button>
        </Popconfirm>
      </Space>
    </Space>
  );
}

export const reviewApprovalTaskType: TaskTypeOptions = {
  key: 'git-review-approval',
  title: tExpr('Git review approvals'),
  collection: 'workflowGitReview',
  action: 'approvals',
  alwaysShow: true,
  Item: ApprovalItem,
  Detail: ApprovalDetailView,
  getPopupRecord: async (api, { params }) => api.resource('workflowGitReview').approval?.(params),
};
