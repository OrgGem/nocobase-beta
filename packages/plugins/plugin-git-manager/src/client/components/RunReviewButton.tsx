import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Dropdown, Modal, Form, Select, Input, message, Space, Tooltip, Tag, Alert } from 'antd';
import { RobotOutlined, MessageOutlined, ThunderboltOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import * as aiClient from '@nocobase/plugin-ai/client';
import { useT } from '../locale';

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
  | { type: 'branch'; repositoryId: number; branch: string; title?: string };

/**
 * Button that lets the user kick off a code review for a given target.
 * Two paths:
 *  - "Run review" → POST gitManager:triggerReview (server-side, async)
 *  - "Open chat" → call (aiClient as any).useChatBoxActions?.() || {}.triggerTask if plugin-ai is loaded,
 *    so the user can chat with the AI employee using the same context.
 */
export const RunReviewButton: React.FC<{
  target: Target;
  size?: 'small' | 'middle' | 'large';
  type?: 'default' | 'primary' | 'link';
  onTriggered?: (reviewId: number) => void;
}> = ({ target, size = 'small', type = 'default', onTriggered }) => {
  const t = useT();
  const api = useApp().apiClient;
  const aiConfigRepository = (aiClient as any).useAIConfigRepository?.() || {};
  const { triggerTask } = (aiClient as any).useChatBoxActions?.() || {};
  const [open, setOpen] = useState(false);
  const [flows, setFlows] = useState<ReviewFlow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [existingReview, setExistingReview] = useState<any | null>(null);
  const [form] = Form.useForm();

  const loadExistingReview = useCallback(() => {
    let cancelled = false;
    const filter: any = {
      repositoryId: target.repositoryId,
      targetType: target.type,
    };
    if (target.type === 'mr') filter.mrIid = target.mrIid;
    if (target.type === 'commit') filter.commitSha = target.commitSha;
    if (target.type === 'branch') filter.branch = target.branch;

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

  const pickFlow = useCallback((list: ReviewFlow[]) => {
    const repoFlow = list.find((f) => f.repositoryId === target.repositoryId);
    return repoFlow ?? list[0] ?? null;
  }, [target.repositoryId]);

  useEffect(() => {
    if (!open) return;
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
      const params: any = {
        repositoryId: target.repositoryId,
        targetType: target.type,
        flowId: values.flowId,
        extraInstructions: values.extraInstructions || undefined,
      };
      if (target.type === 'mr') params.mrIid = target.mrIid;
      if (target.type === 'commit') params.commitSha = target.commitSha;
      if (target.type === 'branch') params.branch = target.branch;
      const res = await api.request({
        url: 'gitManager:triggerReview',
        method: 'post',
        data: params,
      });
      const reviewId = res?.data?.data?.reviewId;
      message.success(t('Review started'));
      setOpen(false);
      form.resetFields();
      loadExistingReview();
      onTriggered?.(reviewId);
    } catch (err: any) {
      if (err?.errorFields) return; // validation error
      message.error(err?.response?.data?.errors?.[0]?.message || err?.message || t('Failed to trigger review'));
    } finally {
      setSubmitting(false);
    }
  };

  const buildWorkContext = () => {
    const title = target.title || buildContextHint();
    if (target.type === 'mr') {
      return {
        type: 'git-merge-request',
        uid: `${target.repositoryId}:${target.mrIid}`,
        title,
        content: {
          repositoryId: target.repositoryId,
          mrIid: target.mrIid,
          title,
        },
      };
    }
    if (target.type === 'commit') {
      return {
        type: 'git-commit',
        uid: `${target.repositoryId}:${target.commitSha}`,
        title,
        content: {
          repositoryId: target.repositoryId,
          commitSha: target.commitSha,
          title,
        },
      };
    }
    return {
      type: 'git-repository',
      uid: String(target.repositoryId),
      title,
      content: {
        repositoryId: target.repositoryId,
        branch: target.branch,
        title,
      },
    };
  };

  const buildChatPrompt = () => {
    if (target.type === 'mr') {
      return `Please review merge request !${target.mrIid} (${target.title || 'untitled'}). Use the attached Git merge request context and the available git tools when you need more detail.`;
    }
    if (target.type === 'commit') {
      return `Please review commit ${target.commitSha} (${target.title || 'untitled'}). Use the attached Git commit context and the available git tools when you need more detail.`;
    }
    return `Please help me inspect branch ${target.branch}. Use the attached Git repository context and the available git tools when you need more detail.`;
  };

  const handleOpenChat = async () => {
    if (!triggerTask || !aiConfigRepository?.getAIEmployees) {
      message.warning(t('AI plugin is not available'));
      return;
    }
    setAsking(true);
    try {
      const list = flows.length ? flows : await loadFlows();
      const flow = pickFlow(list);
      if (!flow?.aiEmployeeUsername) {
        message.warning(t('No matching flow available'));
        return;
      }
      const employees: any[] = aiConfigRepository.aiEmployees?.length
        ? aiConfigRepository.aiEmployees
        : await aiConfigRepository.getAIEmployees();
      const aiEmployee = employees.find((item) => item.username === flow.aiEmployeeUsername);
      if (!aiEmployee) {
        message.warning(t('AI employee not found'));
        return;
      }
      await triggerTask({
        aiEmployee,
        tasks: [
          {
            title: `${flow.name}: ${buildContextHint()}`,
            message: {
              user: buildChatPrompt(),
              system: flow.instructions || undefined,
              workContext: [buildWorkContext()],
            },
            model: flow.llmService && flow.model ? { llmService: flow.llmService, model: flow.model } : null,
            autoSend: false,
          },
        ],
      });
    } catch (err: any) {
      message.error(err?.message || t('Failed to open AI chat'));
    } finally {
      setAsking(false);
    }
  };

  const buildContextHint = () => {
    if (target.type === 'mr') return `MR !${target.mrIid}`;
    if (target.type === 'commit') return `Commit ${String(target.commitSha).slice(0, 7)}`;
    return `Branch ${target.branch}`;
  };

  // Derive re-run state for MR targets
  const hasNewCommits =
    existingReview &&
    existingReview.headSha &&
    existingReview.latestSha &&
    existingReview.headSha !== existingReview.latestSha;
  const isReReview = !!existingReview && existingReview.status !== 'pending';
  const buttonLabel = isReReview
    ? hasNewCommits
      ? t('Re-review (new commits)')
      : t('Re-run review')
    : t('Code Review');
  const ButtonIcon = isReReview ? ReloadOutlined : RobotOutlined;

  const items = useMemo(() => [
    {
      key: 'run',
      icon: <ThunderboltOutlined />,
      label: isReReview ? t('Re-run automated review') : t('Run automated review'),
      onClick: () => setOpen(true),
    },
    ...(existingReview ? [{
      key: 'view',
      icon: <RobotOutlined />,
      label: t(`Status: ${existingReview.status}`) + ' - ' + t('View in Review History tab'),
      onClick: () => {
        message.info(t('Please switch to the "Review History" tab to see the details.'));
      },
    }] : []),
    {
      key: 'chat',
      icon: <MessageOutlined />,
      label: t('Ask AI Employee'),
      onClick: handleOpenChat,
      disabled: asking,
    },
  ], [isReReview, existingReview, asking, handleOpenChat]);

  return (
    <>
      <Dropdown menu={{ items }} placement="bottomRight" trigger={['click']}>
        <Button
          size={size}
          type={hasNewCommits ? 'primary' : type}
          icon={<ButtonIcon />}
          danger={!!hasNewCommits}
          loading={asking}
        >
          {buttonLabel}
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
                ? t('New commits detected since last review. Re-running will overwrite the existing review.')
                : t('A review already exists for this target. Re-running will overwrite it.')
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
          <Form.Item name="extraInstructions" label={t('Extra instructions (optional)')}>
            <Input.TextArea rows={4} placeholder={t('e.g. Focus on security issues in authentication')} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};
