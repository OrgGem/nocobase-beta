/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Dropdown, Modal, Form, Select, Input, message, Space, Tooltip, Tag, Alert } from 'antd';
import { RobotOutlined, ThunderboltOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { REVIEW_PROMPT_TEMPLATES } from '../promptTemplates';
import { useT } from '../locale';

interface ExistingReview {
  status: string;
  headSha?: string;
  latestSha?: string;
}

interface ReviewFlow {
  id: number;
  name: string;
  enabled: boolean;
  triggerMode: string;
  aiEmployeeUsername?: string;
  postMode: string;
  repositoryId?: number;
  llmService?: string;
  model?: string;
  instructions?: string;
}

type Target =
  | { type: 'mr'; repositoryId: number; mrIid: number; title?: string }
  | { type: 'commit'; repositoryId: number; commitSha: string; title?: string }
  | { type: 'branch'; repositoryId: number; branch: string; title?: string }
  | { type: 'folder'; repositoryId: number; folderPath: string; ref?: string; title?: string };

/**
 * Button that lets the user kick off a code review for a given target.
 * Submits review requests through the project-scoped admission service.
 */
export const RunReviewButton: React.FC<{
  target: Target;
  label?: string;
  size?: 'small' | 'middle' | 'large';
  type?: 'default' | 'primary' | 'link';
  onTriggered?: (reviewId: number) => void;
}> = ({ target, label, size = 'small', type = 'default', onTriggered }) => {
  const t = useT();
  const api = useApp().apiClient;
  const [open, setOpen] = useState(false);
  const [flows, setFlows] = useState<ReviewFlow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [existingReview, setExistingReview] = useState<ExistingReview | null>(null);
  const [templateKey, setTemplateKey] = useState<string | undefined>();
  const [form] = Form.useForm();

  const loadExistingReview = useCallback(() => {
    let cancelled = false;
    const filter: Record<string, unknown> = {
      repositoryId: target.repositoryId,
      targetType: target.type,
    };
    if (target.type === 'mr') filter.mrIid = target.mrIid;
    if (target.type === 'commit') filter.commitSha = target.commitSha;
    if (target.type === 'branch') filter.branch = target.branch;
    if (target.type === 'folder') {
      filter.folderPath = target.folderPath;
      filter.branch = target.ref || null;
    }

    api
      .request({
        url: 'gitCodeReviews:list',
        params: {
          pageSize: 1,
          sort: ['-id'],
          filter,
        },
      })
      .then((res) => {
        if (cancelled) return;
        const list = res?.data?.data || [];
        setExistingReview(list[0] || null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, target]);

  useEffect(() => {
    return loadExistingReview();
  }, [loadExistingReview]);

  const loadFlows = useCallback(async () => {
    const { data } = await api.request({
      url: 'gitReviewFlows:list',
      params: {
        pageSize: 100,
        filter: {
          enabled: true,
          $or: [{ repositoryId: target.repositoryId }, { repositoryId: null }],
        },
      },
    });
    const list: ReviewFlow[] = data?.data || [];
    setFlows(list);
    return list;
  }, [api, target.repositoryId]);

  const pickFlow = useCallback(
    (list: ReviewFlow[]) => {
      const repoFlow = list.find((f) => f.repositoryId === target.repositoryId);
      return repoFlow ?? list[0] ?? null;
    },
    [target.repositoryId],
  );

  useEffect(() => {
    if (!open) return;
    setTemplateKey(undefined);
    let cancelled = false;
    loadFlows()
      .then((list) => {
        if (cancelled) return;
        const flow = pickFlow(list);
        if (flow?.id) form.setFieldValue('flowId', flow.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, loadFlows, pickFlow, form]);

  const handleRun = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const params: Record<string, unknown> = {
        repositoryId: target.repositoryId,
        targetType: target.type,
        flowId: values.flowId,
        extraInstructions: values.extraInstructions || undefined,
      };
      if (target.type === 'mr') params.mrIid = target.mrIid;
      if (target.type === 'commit') params.commitSha = target.commitSha;
      if (target.type === 'branch') params.branch = target.branch;
      if (target.type === 'folder') {
        params.folderPath = target.folderPath;
        params.branch = target.ref;
      }
      const res = await api.request({
        url: 'gitManager:triggerReview',
        method: 'post',
        data: params,
      });
      const reviewId = res?.data?.data?.reviewId;
      message.success(t('Review queued'));
      setOpen(false);
      form.resetFields();
      loadExistingReview();
      onTriggered?.(reviewId);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      const responseError = err as { response?: { data?: { errors?: Array<{ message?: string }> } } } | null;
      message.error(
        responseError?.response?.data?.errors?.[0]?.message ||
          (err instanceof Error && err.message) ||
          t('Failed to trigger review'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const buildContextHint = () => {
    if (target.type === 'mr') return `MR !${target.mrIid}`;
    if (target.type === 'commit') return `Commit ${String(target.commitSha).slice(0, 7)}`;
    if (target.type === 'folder') return `${t('Folder')} ${target.folderPath || '/'}`;
    return `${t('Branch')} ${target.branch}`;
  };

  // Derive re-run state for MR targets
  const hasNewCommits =
    existingReview &&
    existingReview.headSha &&
    existingReview.latestSha &&
    existingReview.headSha !== existingReview.latestSha;
  const isReReview = !!existingReview;
  const buttonLabel = isReReview
    ? hasNewCommits
      ? t('Re-review (new commits)')
      : t('Re-run review')
    : t('Code Review');
  const ButtonIcon = isReReview ? ReloadOutlined : RobotOutlined;

  const items = [
    {
      key: 'run',
      icon: <ThunderboltOutlined />,
      label: isReReview ? t('Re-run automated review') : t('Run automated review'),
      onClick: () => setOpen(true),
    },
    ...(existingReview
      ? [
          {
            key: 'view',
            icon: <RobotOutlined />,
            label: t(`Status: ${existingReview.status}`) + ' - ' + t('View in Review History tab'),
            onClick: () => {
              message.info(t('Please switch to the "Review History" tab to see the details.'));
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <Dropdown menu={{ items }} placement="bottomRight" trigger={['click']}>
        <Button size={size} type={hasNewCommits ? 'primary' : type} icon={<ButtonIcon />} danger={!!hasNewCommits}>
          {label ?? buttonLabel}
        </Button>
      </Dropdown>
      <Modal
        title={
          <Space>
            <RobotOutlined />
            <span>{isReReview ? t('Re-run code review') : t('Run code review')}</span>
            <span style={{ color: '#999', fontSize: 12, fontWeight: 400 }}>{buildContextHint()}</span>
          </Space>
        }
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleRun}
        okText={isReReview ? t('Re-run') : t('Start Review')}
        confirmLoading={submitting}
        destroyOnClose
      >
        {isReReview && (
          <Alert
            type={hasNewCommits ? 'warning' : 'info'}
            showIcon
            style={{ marginBottom: 12 }}
            message={
              hasNewCommits
                ? t('New commits detected. A new review will be queued.')
                : t('A new review will be queued and existing history will be kept.')
            }
            description={
              <Space size={8} wrap style={{ fontSize: 12 }}>
                {existingReview?.headSha && (
                  <span>
                    {t('Reviewed at')}:&nbsp;
                    <Tag style={{ fontFamily: 'monospace' }}>{String(existingReview.headSha).slice(0, 7)}</Tag>
                  </span>
                )}
                {hasNewCommits && existingReview?.latestSha && (
                  <span>
                    {t('Latest')}:&nbsp;
                    <Tag color="orange" style={{ fontFamily: 'monospace' }}>
                      {String(existingReview.latestSha).slice(0, 7)}
                    </Tag>
                  </span>
                )}
              </Space>
            }
          />
        )}
        <Form form={form} layout="vertical">
          <Form.Item
            name="flowId"
            label={t('Review Flow')}
            rules={[{ required: true, message: t('Please select a review flow') }]}
            extra={
              flows.length === 0 ? (
                <Tooltip title={t('Create a review flow in the Review Flows tab first')}>
                  <span style={{ color: '#faad14' }}>{t('No enabled flow found for this repository')}</span>
                </Tooltip>
              ) : null
            }
          >
            <Select
              options={flows.map((f) => ({
                value: f.id,
                label: `${f.name}${f.aiEmployeeUsername ? ` — @${f.aiEmployeeUsername}` : ''}${
                  f.repositoryId == null ? ` (${t('global')})` : ''
                }`,
              }))}
              placeholder={t('Select a review flow')}
            />
          </Form.Item>
          <Form.Item
            label={t('Prompt template')}
            extra={t('Selecting a template replaces the extra instructions text')}
          >
            <Select
              allowClear
              value={templateKey}
              placeholder={t('Load a default prompt by code type')}
              options={REVIEW_PROMPT_TEMPLATES.map((tpl) => ({ value: tpl.key, label: t(tpl.label) }))}
              onChange={(key) => {
                setTemplateKey(key);
                const tpl = REVIEW_PROMPT_TEMPLATES.find((item) => item.key === key);
                if (tpl) form.setFieldValue('extraInstructions', tpl.text);
              }}
            />
          </Form.Item>
          <Form.Item name="extraInstructions" label={t('Extra instructions (optional)')}>
            <Input.TextArea rows={4} placeholder={t('e.g. Focus on security issues in authentication')} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};
