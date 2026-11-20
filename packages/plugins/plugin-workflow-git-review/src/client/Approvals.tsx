// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useState } from 'react';
import { ReloadOutlined } from '@ant-design/icons';
import {
  useAPIClient,
  useActionContext,
  useApp,
  useCollectionRecordData,
  useListBlockContext,
  type APIClient,
} from '@nocobase/client';
import { usePopupRecordContext, useTasksCountsContext } from '@nocobase/plugin-workflow/client';
import { Alert, Button, Card, Drawer, Modal, Popconfirm, Space, Spin, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';

const NAMESPACE = 'plugin-workflow-git-review';
const tExpr = (key: string) => `{{t("${key}", { ns: "${NAMESPACE}" })}}`;

type ApprovalRecord = {
  id?: string | number;
  title?: string;
  executionId?: string | number;
  reviewId?: string | number;
};

type ApprovalDetail = {
  id: string | number;
  title?: string;
  markdown: string;
  fingerprint: string;
};

export interface V1TaskTypeOptions {
  key: string;
  title: string;
  collection: string;
  action?: string;
  useActionParams: (status: string, workflowKey?: string) => Record<string, unknown>;
  Actions?: React.ComponentType<{ onlyIcon?: boolean }>;
  Item: React.ComponentType;
  Detail: React.ComponentType;
  getPopupRecord?: (apiClient: APIClient, context: { params: Record<string, unknown> }) => Promise<unknown>;
  alwaysShow?: boolean;
}

function useT() {
  const app = useApp();
  return useCallback((key: string) => app.i18n.t(key, { ns: [NAMESPACE, 'client'] }) as string, [app.i18n]);
}

function useApprovalActionParams(status: string): Record<string, unknown> {
  return status === 'completed' ? { status: 'completed' } : {};
}

function ApprovalActions({ onlyIcon }: { onlyIcon?: boolean }) {
  const t = useT();
  const listContext = useListBlockContext() as { service?: { refresh?: () => void; loading?: boolean } } | undefined;
  const { reload } = useTasksCountsContext();
  const handleRefresh = useCallback(() => {
    listContext?.service?.refresh?.();
    reload();
  }, [listContext?.service, reload]);

  return (
    <Button
      icon={<ReloadOutlined />}
      loading={Boolean(listContext?.service?.loading)}
      onClick={handleRefresh}
      aria-label={t('Refresh')}
    >
      {onlyIcon ? null : t('Refresh')}
    </Button>
  );
}

function ApprovalItem() {
  const record = useCollectionRecordData() as ApprovalRecord | undefined;
  const navigate = useNavigate();
  const { setRecord } = usePopupRecordContext();
  const t = useT();

  const openApproval = useCallback(() => {
    if (record?.id == null) return;
    setRecord(record);
    navigate(`./${encodeURIComponent(String(record.id))}`);
  }, [navigate, record, setRecord]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openApproval();
      }
    },
    [openApproval],
  );

  const title = String(record?.title ?? t('Review approval'));
  return (
    <Card
      size="small"
      hoverable
      role="button"
      tabIndex={0}
      aria-label={title}
      title={title}
      onClick={openApproval}
      onKeyDown={handleKeyDown}
    />
  );
}

function ApprovalDetailModal() {
  const apiClient = useAPIClient();
  const t = useT();
  const record = useCollectionRecordData() as ApprovalRecord | undefined;
  const { visible, setVisible, openMode } = useActionContext();
  const listContext = useListBlockContext() as { service?: { refresh?: () => void } } | undefined;
  const { reload: reloadCounts } = useTasksCountsContext();
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (record?.id == null) {
      setDetail(null);
      setLoading(false);
      return;
    }
    const loadDetail = async () => {
      setDetail(null);
      setLoading(true);
      try {
        const response = await apiClient.request({
          url: 'workflowGitReview:approval',
          params: { filterByTk: record.id },
        });
        if (!cancelled) setDetail((response.data?.data as ApprovalDetail | undefined) ?? null);
      } catch (_error) {
        if (!cancelled) message.error(t('Review task is unavailable'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [apiClient, record?.id, t]);

  const submit = async (decision: 'approve' | 'reject') => {
    if (!detail) return;
    setBusy(true);
    try {
      await apiClient.request({
        url: 'workflowManualTasks:submit',
        method: 'post',
        params: { filterByTk: detail.id },
        data: { result: { review: { fingerprint: detail.fingerprint }, _: decision } },
      });
      setDetail(null);
      setVisible(false);
      listContext?.service?.refresh?.();
      reloadCounts();
      message.success(t('Decision submitted'));
    } catch (_error) {
      message.error(t('Could not submit the decision'));
    } finally {
      setBusy(false);
    }
  };

  const title = String(detail?.title ?? record?.title ?? t('Review approval'));
  const content = loading ? (
    <Spin spinning>
      <div style={{ minHeight: 120 }} />
    </Spin>
  ) : !detail ? (
    <Alert type="info" message={t('Review task is unavailable')} />
  ) : (
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

  if (openMode === 'drawer') {
    return (
      <Drawer open={Boolean(visible)} onClose={() => setVisible(false)} title={title} width="100%" destroyOnClose>
        {content}
      </Drawer>
    );
  }

  return (
    <Modal
      open={Boolean(visible)}
      onCancel={() => setVisible(false)}
      title={title}
      footer={null}
      width={780}
      destroyOnClose
    >
      {content}
    </Modal>
  );
}

export const reviewApprovalTaskType: V1TaskTypeOptions = {
  key: 'git-review-approval',
  title: tExpr('Git review approvals'),
  collection: 'workflowGitReview',
  action: 'approvals',
  alwaysShow: true,
  useActionParams: useApprovalActionParams,
  Actions: ApprovalActions,
  Item: ApprovalItem,
  Detail: ApprovalDetailModal,
  getPopupRecord: (apiClient, { params }) => apiClient.request({ url: 'workflowGitReview:approval', params }),
};
