/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useTranslation } from 'react-i18next';
import { GuideDocumentPicker } from './GuideDocumentPicker';

const namespace = 'build-guide-block';
import {
  DEFAULT_TARGET_CHAPTER_COUNT,
  MAX_TARGET_CHAPTER_COUNT,
  MIN_TARGET_CHAPTER_COUNT,
} from './schemas/spacesSchema';

const POLL_INTERVAL_MS = 3000;
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);
const RUN_STATUS_COLORS: Record<string, string> = {
  queued: 'processing',
  running: 'blue',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
  unknown: 'warning',
};
const STEP_STATUS_COLORS: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  unknown: 'warning',
};
const SAFE_ERROR_CODES = new Set([
  'BUILD_FAILED',
  'WORKFLOW_UNAVAILABLE',
  'SOURCE_ACCESS_DENIED',
  'SOURCE_NO_USABLE_TEXT',
  'INVALID_PLAN',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_FAILED',
  'PUBLISH_FAILED',
  'UNKNOWN_OUTCOME',
  'CANCELLED',
]);
const OUTPUT_FORMAT_OPTIONS = [
  { label: 'HTML', value: 'html' },
  { label: 'Markdown', value: 'markdown' },
];

type ID = string | number;
type Engine = 'legacy' | 'workflow';
type RunStep = {
  stepKey: string;
  status: string;
  attempt: number;
  errorCode?: string;
};
type SourceWarning = {
  code: 'SOURCE_UNSUPPORTED' | 'SOURCE_READ_FAILED' | 'SOURCE_PARSE_FAILED' | 'SOURCE_EMPTY';
  count: number;
};
type GuideBuildRun = {
  id: ID;
  spaceId: ID;
  engine: Engine;
  status: string;
  stage: string;
  expectedCount: number;
  completedCount: number;
  canCancel: boolean;
  canRetry: boolean;
  errorCode?: string;
  executionId?: ID;
  steps: RunStep[];
  sourceWarnings?: SourceWarning[];
};
type SpaceRecord = {
  id: ID;
  title?: string;
  status?: string;
  buildPhase?: string;
  pageCount?: number;
  llmService?: string;
  model?: string;
  engine?: Engine;
  activeRunId?: ID | null;
  latestRunId?: ID | null;
  publishedRunId?: ID | null;
  published?: boolean;
  outputFormat?: string;
  targetChapterCount?: number;
  chapterGuidance?: string;
  systemPrompt?: string;
};
type SpaceFormValues = {
  title: string;
  llmService: string;
  model: string;
  engine: Engine;
  outputFormat: string;
  targetChapterCount: number;
  chapterGuidance?: string;
  systemPrompt?: string;
  documents?: ID[];
};
type LLMOption = { label: string; value: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readApiData(response: unknown): unknown {
  if (!isRecord(response)) return response;
  const envelope = response.data;
  if (!isRecord(envelope)) return envelope ?? response;
  return envelope.data ?? envelope;
}

function isId(value: unknown): value is ID {
  return typeof value === 'string' || typeof value === 'number';
}

function isRunStep(value: unknown): value is RunStep {
  return (
    isRecord(value) &&
    typeof value.stepKey === 'string' &&
    typeof value.status === 'string' &&
    typeof value.attempt === 'number'
  );
}

function isSourceWarning(value: unknown): value is SourceWarning {
  return (
    isRecord(value) &&
    ['SOURCE_UNSUPPORTED', 'SOURCE_READ_FAILED', 'SOURCE_PARSE_FAILED', 'SOURCE_EMPTY'].includes(String(value.code)) &&
    typeof value.count === 'number'
  );
}

function isGuideBuildRun(value: unknown): value is GuideBuildRun {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isId(value.spaceId) &&
    (value.engine === 'legacy' || value.engine === 'workflow') &&
    typeof value.status === 'string' &&
    typeof value.stage === 'string' &&
    typeof value.expectedCount === 'number' &&
    typeof value.completedCount === 'number' &&
    typeof value.canCancel === 'boolean' &&
    typeof value.canRetry === 'boolean' &&
    Array.isArray(value.steps) &&
    value.steps.every(isRunStep) &&
    (value.sourceWarnings == null ||
      (Array.isArray(value.sourceWarnings) && value.sourceWarnings.every(isSourceWarning)))
  );
}

function isSpaceRecord(value: unknown): value is SpaceRecord {
  return isRecord(value) && isId(value.id);
}

function readSpaceDocumentIds(value: unknown): ID[] | null {
  if (!isRecord(value) || !Array.isArray(value.documents)) return null;
  return value.documents.flatMap((document) => (isRecord(document) && isId(document.id) ? [document.id] : []));
}

function normalizeTargetChapterCount(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_TARGET_CHAPTER_COUNT;
  return Math.max(MIN_TARGET_CHAPTER_COUNT, Math.min(MAX_TARGET_CHAPTER_COUNT, Math.round(count)));
}

function safeErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const response = isRecord(value.response) ? value.response : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const error = data && isRecord(data.error) ? data.error : undefined;
  const code = error?.code;
  return typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : undefined;
}

function errorMessage(error: unknown, t: (key: string) => string) {
  const code = safeErrorCode(error);
  return code ? t(code) : t('Build failed');
}

function translatedRunError(errorCode: string, t: (key: string) => string) {
  return SAFE_ERROR_CODES.has(errorCode) ? t(errorCode) : t('Build failed');
}

function getStageLabel(stage: string, t: (key: string) => string) {
  const labels: Record<string, string> = {
    queued: 'Queued',
    preparing: 'Preparing sources',
    planning: 'Planning chapters',
    writing_chapter: 'Writing chapters',
    publishing: 'Publishing guide',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return t(labels[stage] || 'Workflow step');
}

function getStepLabel(stepKey: string, t: (key: string) => string) {
  if (stepKey === 'prepare') return t('Prepare sources');
  if (stepKey === 'plan') return t('Plan chapters');
  if (stepKey === 'publish') return t('Publish guide');
  if (stepKey.startsWith('chapter:')) return `${t('Chapter')} ${stepKey.slice('chapter:'.length)}`;
  return t('Workflow step');
}

function getRunPercent(run: GuideBuildRun) {
  if (run.status === 'completed') return 100;
  if (run.expectedCount <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((run.completedCount / run.expectedCount) * 100)));
}

function isPublished(record: SpaceRecord) {
  return (
    record.published === true ||
    (record.status === 'completed' && (record.engine !== 'workflow' || record.published == null))
  );
}

function RunProgressSummary({ run }: { run: GuideBuildRun }) {
  const { t } = useTranslation([namespace, 'client']);
  const percent = getRunPercent(run);
  const progressStatus = run.status === 'failed' ? 'exception' : run.status === 'completed' ? 'success' : 'active';
  return (
    <Space direction="vertical" size={2} style={{ minWidth: 180 }}>
      <Space size={6}>
        <Tag color={RUN_STATUS_COLORS[run.status] || 'default'}>{t(run.status)}</Tag>
        <Typography.Text type="secondary">{getStageLabel(run.stage, t)}</Typography.Text>
      </Space>
      <Progress percent={percent} size="small" status={progressStatus} aria-label={t('Chapter progress')} />
      <Typography.Text type="secondary">
        {t('{{completed}} of {{expected}} chapters', {
          completed: run.completedCount,
          expected: run.expectedCount,
        })}
      </Typography.Text>
    </Space>
  );
}

function RunDetails({ run }: { run: GuideBuildRun }) {
  const { t } = useTranslation([namespace, 'client']);
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Typography.Text>
          {t('Run')} {run.id}
        </Typography.Text>
        <Tag color={RUN_STATUS_COLORS[run.status] || 'default'}>{t(run.status)}</Tag>
        <Typography.Text type="secondary">{getStageLabel(run.stage, t)}</Typography.Text>
        {run.errorCode && <Typography.Text type="danger">{translatedRunError(run.errorCode, t)}</Typography.Text>}
      </Space>
      {!!run.sourceWarnings?.length && (
        <Alert
          type="warning"
          showIcon
          message={t('Some source documents were skipped')}
          description={
            <ul aria-label={t('Source warnings')}>
              {run.sourceWarnings.map((warning) => (
                <li key={warning.code}>
                  {t(warning.code)} ({t('{{count}} documents', { count: warning.count })})
                </li>
              ))}
            </ul>
          }
        />
      )}
      <List
        size="small"
        dataSource={run.steps}
        locale={{ emptyText: t('No workflow steps yet') }}
        renderItem={(step) => (
          <List.Item>
            <Space wrap>
              <Typography.Text>{getStepLabel(step.stepKey, t)}</Typography.Text>
              <Tag color={STEP_STATUS_COLORS[step.status] || 'default'}>{t(step.status)}</Tag>
              <Typography.Text type="secondary">{t('Attempt {{attempt}}', { attempt: step.attempt })}</Typography.Text>
              {step.errorCode && (
                <Typography.Text type="danger">{translatedRunError(step.errorCode, t)}</Typography.Text>
              )}
            </Space>
          </List.Item>
        )}
      />
    </Space>
  );
}

export const UserGuideManager = () => {
  const { t } = useTranslation([namespace, 'client']);
  const app = useApp();
  const api = app.apiClient;
  const { message } = App.useApp();
  const [form] = Form.useForm<SpaceFormValues>();
  const selectedService = Form.useWatch('llmService', form);

  const [data, setData] = useState<SpaceRecord[]>([]);
  const [runStatuses, setRunStatuses] = useState<Map<string, GuideBuildRun>>(new Map());
  const runStatusesRef = useRef<Map<string, GuideBuildRun>>(new Map());
  const listRequestInFlight = useRef(false);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<ID | null>(null);
  const [documentsEditable, setDocumentsEditable] = useState(true);
  const [documentsBusy, setDocumentsBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busySpaceId, setBusySpaceId] = useState<ID | null>(null);
  const [serviceOptions, setServiceOptions] = useState<LLMOption[]>([]);
  const [modelOptions, setModelOptions] = useState<LLMOption[]>([]);

  const loadList = useCallback(
    async (showLoading = false) => {
      if (listRequestInFlight.current) return false;
      listRequestInFlight.current = true;
      if (showLoading) setLoading(true);
      try {
        const response: unknown = await api.resource('aiBuildGuideSpaces').list({
          sort: ['-createdAt'],
          paginate: false,
        });
        const records = readApiData(response);
        const rows = Array.isArray(records) ? records.filter(isSpaceRecord) : [];
        setData(rows);

        const activeRunIds = new Set(
          rows.filter((record) => record.activeRunId != null).map((record) => String(record.activeRunId)),
        );
        const runRows = await Promise.all(
          rows
            .map((record) => record.latestRunId ?? record.activeRunId)
            .filter((runId): runId is ID => runId != null)
            .filter((runId, index, runIds) => runIds.findIndex((item) => String(item) === String(runId)) === index)
            .filter((runId) => {
              const cached = runStatusesRef.current.get(String(runId));
              return !cached || (activeRunIds.has(String(runId)) && ACTIVE_RUN_STATUSES.has(cached.status));
            })
            .map(async (runId) => {
              try {
                const runResponse: unknown = await api.resource('aiBuildGuideRuns').getStatus({ filterByTk: runId });
                const run = readApiData(runResponse);
                return isGuideBuildRun(run) ? ([String(runId), run] as const) : null;
              } catch {
                return null;
              }
            }),
        );
        const nextStatuses = new Map(runStatusesRef.current);
        for (const entry of runRows) {
          if (entry) nextStatuses.set(entry[0], entry[1]);
        }
        runStatusesRef.current = nextStatuses;
        setRunStatuses(nextStatuses);
        return true;
      } catch {
        if (showLoading) message.error(t('Could not load guide spaces'));
        return false;
      } finally {
        listRequestInFlight.current = false;
        if (showLoading) setLoading(false);
      }
    },
    [api, message, t],
  );

  useEffect(() => {
    loadList(true);
  }, [loadList]);

  const hasActiveRuns = data.some((record) => record.activeRunId != null || record.status === 'building');
  useEffect(() => {
    if (!hasActiveRuns) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failedPolls = 0;
    const poll = async () => {
      const loaded = await loadList();
      if (disposed) return;
      failedPolls = loaded ? 0 : failedPolls + 1;
      const delay = loaded ? POLL_INTERVAL_MS : Math.min(POLL_INTERVAL_MS * 2 ** failedPolls, 30000);
      timer = setTimeout(() => {
        poll();
      }, delay);
    };
    timer = setTimeout(() => {
      poll();
    }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasActiveRuns, loadList]);

  const loadServices = useCallback(async () => {
    try {
      const response: unknown = await api.resource('ai').listLLMServices();
      const list = readApiData(response);
      setServiceOptions(
        Array.isArray(list)
          ? list.flatMap((item): LLMOption[] => {
              if (!isRecord(item)) return [];
              const value = typeof item.name === 'string' ? item.name : undefined;
              if (!value) return [];
              return [{ label: typeof item.title === 'string' ? item.title : value, value }];
            })
          : [],
      );
    } catch {
      setServiceOptions([]);
    }
  }, [api]);

  const loadModels = useCallback(
    async (service?: string) => {
      if (!service) {
        setModelOptions([]);
        return;
      }
      try {
        const response: unknown = await api.resource('ai').listModels({ llmService: service });
        const list = readApiData(response);
        setModelOptions(
          Array.isArray(list)
            ? list.flatMap((item): LLMOption[] => {
                if (!isRecord(item)) return [];
                const value =
                  typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : undefined;
                return value ? [{ label: value, value }] : [];
              })
            : [],
        );
      } catch {
        setModelOptions([]);
      }
    },
    [api],
  );

  const openCreate = () => {
    setEditingId(null);
    setDocumentsEditable(true);
    setDocumentsBusy(false);
    form.resetFields();
    form.setFieldsValue({
      engine: 'legacy',
      outputFormat: 'html',
      targetChapterCount: DEFAULT_TARGET_CHAPTER_COUNT,
      documents: [],
      systemPrompt:
        'You are an expert technical writer. Generate a comprehensive user guide based on the provided documents.',
    });
    loadServices();
    setDrawerOpen(true);
  };

  const openEdit = async (record: SpaceRecord) => {
    setDocumentsEditable(false);
    setDocumentsBusy(false);
    try {
      const response: unknown = await api.resource('aiBuildGuideSpaces').get({
        filterByTk: record.id,
        fields: ['id', 'documents.id'],
        appends: ['documents'],
      });
      const documentIds = readSpaceDocumentIds(readApiData(response));
      setEditingId(record.id);
      form.resetFields();
      form.setFieldsValue({
        title: record.title,
        llmService: record.llmService,
        model: record.model,
        engine: record.engine || 'legacy',
        outputFormat: record.outputFormat || 'html',
        targetChapterCount: normalizeTargetChapterCount(record.targetChapterCount),
        chapterGuidance: record.chapterGuidance,
        systemPrompt: record.systemPrompt,
        ...(documentIds ? { documents: documentIds } : {}),
      });
      setDocumentsEditable(documentIds !== null);
      loadServices();
      loadModels(record.llmService);
      setDrawerOpen(true);
    } catch {
      setEditingId(record.id);
      form.resetFields();
      form.setFieldsValue({
        title: record.title,
        llmService: record.llmService,
        model: record.model,
        engine: record.engine || 'legacy',
        outputFormat: record.outputFormat || 'html',
        targetChapterCount: normalizeTargetChapterCount(record.targetChapterCount),
        chapterGuidance: record.chapterGuidance,
        systemPrompt: record.systemPrompt,
      });
      loadServices();
      loadModels(record.llmService);
      setDrawerOpen(true);
    }
  };

  const handleSubmit = async () => {
    if (documentsBusy) return;
    const values = await form.validateFields();
    values.targetChapterCount = normalizeTargetChapterCount(values.targetChapterCount);
    const payload: Record<string, unknown> = { ...values };
    if (editingId == null || documentsEditable) {
      payload.documents = (values.documents || []).filter(isId).map((id) => ({ id }));
    } else {
      delete payload.documents;
    }
    setSubmitting(true);
    try {
      if (editingId != null) {
        await api.resource('aiBuildGuideSpaces').update({ filterByTk: editingId, values: payload });
      } else {
        await api.resource('aiBuildGuideSpaces').create({ values: payload });
      }
      message.success(t('Saved successfully'));
      setDrawerOpen(false);
      await loadList(true);
    } catch (error: unknown) {
      if (isRecord(error) && Array.isArray(error.errorFields)) return;
      message.error(t('Save failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (record: SpaceRecord) => {
    try {
      await api.resource('aiBuildGuideSpaces').destroy({ filterByTk: record.id });
      message.success(t('Deleted'));
      await loadList(true);
    } catch {
      message.error(t('Could not delete guide space'));
    }
  };

  const handleBuild = async (record: SpaceRecord) => {
    setBusySpaceId(record.id);
    try {
      const response: unknown = await api.resource('aiBuildGuideSpaces').build({ filterByTk: record.id });
      const payload = readApiData(response);
      const runId = isRecord(payload) && isId(payload.runId) ? payload.runId : undefined;
      if (runId == null) {
        message.error(t('Build failed'));
        return;
      }
      setData((current) =>
        current.map((item) => (item.id === record.id ? { ...item, activeRunId: runId, latestRunId: runId } : item)),
      );
      message.success(t('Build started'));
      await loadList();
    } catch (error: unknown) {
      message.error(errorMessage(error, t));
    } finally {
      setBusySpaceId(null);
    }
  };

  const handleRunAction = async (record: SpaceRecord, action: 'cancel' | 'retry') => {
    const runId = record.latestRunId ?? record.activeRunId;
    if (runId == null) return;
    setBusySpaceId(record.id);
    try {
      await api.resource('aiBuildGuideRuns')[action]({ filterByTk: runId });
      message.success(t(action === 'cancel' ? 'Run cancelled' : 'Retry started'));
      await loadList();
    } catch (error: unknown) {
      message.error(errorMessage(error, t));
      await loadList();
    } finally {
      setBusySpaceId(null);
    }
  };

  const closeEditor = () => {
    if (!documentsBusy) setDrawerOpen(false);
  };

  const columns: TableColumnsType<SpaceRecord> = [
    { title: t('Title'), dataIndex: 'title' },
    {
      title: t('Engine'),
      dataIndex: 'engine',
      render: (engine: Engine | undefined) => t(engine === 'workflow' ? 'Workflow' : 'Legacy worker'),
    },
    {
      title: t('Status'),
      key: 'status',
      render: (_value, record) => {
        const run = runStatuses.get(String(record.latestRunId ?? record.activeRunId));
        if (run) return <Tag color={RUN_STATUS_COLORS[run.status] || 'default'}>{t(run.status)}</Tag>;
        if (isPublished(record)) return <Tag color="success">{t('Published')}</Tag>;
        return record.status ? <Tag>{t(record.status === 'error' ? 'Failed' : record.status)}</Tag> : null;
      },
    },
    {
      title: t('Run progress'),
      key: 'progress',
      render: (_value, record) => {
        const run = runStatuses.get(String(record.latestRunId ?? record.activeRunId));
        return run ? <RunProgressSummary run={run} /> : <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
    {
      title: t('Published guide'),
      key: 'published',
      render: (_value, record) =>
        isPublished(record) ? (
          <Tag color="success">
            {t('Published')} {record.publishedRunId ? `· ${record.publishedRunId}` : ''}
          </Tag>
        ) : (
          <Tag>{t('Not published')}</Tag>
        ),
    },
    { title: t('Chapters'), dataIndex: 'pageCount' },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_value, record) => {
        const run = runStatuses.get(String(record.latestRunId ?? record.activeRunId));
        const canCancel = record.engine === 'workflow' && run?.engine === 'workflow' && run.canCancel;
        const canRetry = record.engine === 'workflow' && run?.engine === 'workflow' && run.canRetry;
        return (
          <Space wrap>
            <Button
              type="link"
              icon={<PlayCircleOutlined />}
              loading={busySpaceId === record.id}
              disabled={record.activeRunId != null}
              onClick={() => handleBuild(record)}
            >
              {t('Build')}
            </Button>
            {canCancel && (
              <Popconfirm
                title={t('Cancel this guide build?')}
                onConfirm={() => handleRunAction(record, 'cancel')}
                okText={t('Cancel build')}
                cancelText={t('Back')}
              >
                <Button danger type="link" loading={busySpaceId === record.id}>
                  {t('Cancel build')}
                </Button>
              </Popconfirm>
            )}
            {canRetry && (
              <Button type="link" loading={busySpaceId === record.id} onClick={() => handleRunAction(record, 'retry')}>
                {t('Retry')}
              </Button>
            )}
            {run?.executionId != null && (
              <Button type="link" href={app.getHref(`/admin/settings/workflow/executions/${run.executionId}`)}>
                {t('Open execution')}
              </Button>
            )}
            <Button type="link" onClick={() => openEdit(record)}>
              {t('Edit')}
            </Button>
            <Popconfirm
              title={t('Are you sure you want to delete this space?')}
              onConfirm={() => handleDelete(record)}
              okText={t('Delete')}
              cancelText={t('Cancel')}
            >
              <Button danger type="link">
                {t('Delete')}
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const expandedRowRender = (record: SpaceRecord) => {
    const run = runStatuses.get(String(record.latestRunId ?? record.activeRunId));
    return run ? <RunDetails run={run} /> : null;
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Create space')}
        </Button>
        <Button onClick={() => loadList(true)}>{t('Refresh')}</Button>
      </Space>
      <Table rowKey="id" loading={loading} dataSource={data} columns={columns} expandable={{ expandedRowRender }} />
      <Drawer
        title={editingId != null ? t('Edit space') : t('Create space')}
        open={drawerOpen}
        onClose={closeEditor}
        maskClosable={!documentsBusy}
        keyboard={!documentsBusy}
        width={640}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={closeEditor} disabled={documentsBusy}>
              {t('Cancel')}
            </Button>
            <Button type="primary" loading={submitting} disabled={documentsBusy} onClick={handleSubmit}>
              {t('Submit')}
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed: Partial<SpaceFormValues>) => {
            if ('llmService' in changed) form.setFieldValue('model', undefined);
          }}
        >
          <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="engine" label={t('Build engine')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'legacy', label: t('Legacy worker') },
                { value: 'workflow', label: t('Workflow') },
              ]}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary">{t('The engine selection applies to new runs.')}</Typography.Paragraph>
          <Form.Item name="llmService" label={t('LLM Service')} rules={[{ required: true }]}>
            <Select
              options={serviceOptions}
              onFocus={loadServices}
              onChange={(service: string | undefined) => loadModels(service)}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="model" label={t('Model')} rules={[{ required: true }]}>
            <Select options={modelOptions} disabled={!selectedService} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="outputFormat" label={t('Output format')} rules={[{ required: true }]}>
            <Select options={OUTPUT_FORMAT_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))} />
          </Form.Item>
          <Form.Item name="targetChapterCount" label={t('Target chapters')} rules={[{ required: true }]}>
            <InputNumber
              min={MIN_TARGET_CHAPTER_COUNT}
              max={MAX_TARGET_CHAPTER_COUNT}
              precision={0}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="chapterGuidance" label={t('Chapter guidance')}>
            <Input.TextArea rows={3} placeholder={t('Describe how the guide should be split into chapters')} />
          </Form.Item>
          <Form.Item name="systemPrompt" label={t('System Prompt')}>
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="documents" label={t('Documents')}>
            <GuideDocumentPicker disabled={!documentsEditable} onMutationChange={setDocumentsBusy} />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};
