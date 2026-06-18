import React, { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Drawer, Form, Input, InputNumber, Select, Space, Table, Tag } from 'antd';
import { PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_TARGET_CHAPTER_COUNT,
  MAX_TARGET_CHAPTER_COUNT,
  MIN_TARGET_CHAPTER_COUNT,
} from './schemas/spacesSchema';

const POLL_INTERVAL_MS = 3000;
const STILL_RUNNING_AFTER_MS = 5 * 60 * 1000;
const SLOW_POLL_INTERVAL_MS = 10000;

const STATUS_COLORS: Record<string, string> = {
  draft: 'default',
  building: 'blue',
  completed: 'success',
  error: 'error',
};

const OUTPUT_FORMAT_OPTIONS = [
  { label: 'HTML', value: 'html' },
  { label: 'Markdown', value: 'markdown' },
];

interface SpaceRecord {
  id: number;
  title?: string;
  status?: string;
  buildPhase?: string;
  pageCount?: number;
  buildLog?: string;
  llmService?: string;
  model?: string;
  outputFormat?: string;
  targetChapterCount?: number;
  chapterGuidance?: string;
  systemPrompt?: string;
  generatedHtml?: string;
  generatedMarkdown?: string;
  documents?: any[];
}

const normalizeTargetChapterCount = (value: unknown) => {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_TARGET_CHAPTER_COUNT;
  return Math.max(MIN_TARGET_CHAPTER_COUNT, Math.min(MAX_TARGET_CHAPTER_COUNT, Math.round(count)));
};

export const UserGuideManager = () => {
  const { t } = useTranslation();
  const api = useApp().apiClient;
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const selectedService = Form.useWatch('llmService', form);

  const [data, setData] = useState<SpaceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serviceOptions, setServiceOptions] = useState<{ label: string; value: string }[]>([]);
  const [modelOptions, setModelOptions] = useState<{ label: string; value: string }[]>([]);
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.resource('aiBuildGuideSpaces').list({
        appends: ['documents'],
        sort: ['-createdAt'],
        paginate: false,
      });
      setData(res?.data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const loadServices = useCallback(async () => {
    try {
      const res = await api.resource('ai').listLLMServices();
      const list = res?.data?.data || [];
      setServiceOptions(list.map((s: any) => ({ label: s.title || s.name, value: s.name })));
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
        const res = await api.resource('ai').listModels({ llmService: service });
        const list = res?.data?.data || [];
        setModelOptions(list.map((m: any) => ({ label: m.id || m.name, value: m.id || m.name })));
      } catch {
        setModelOptions([]);
      }
    },
    [api],
  );

  useEffect(() => {
    loadModels(selectedService);
  }, [selectedService, loadModels]);

  const openCreate = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({
      outputFormat: 'html',
      targetChapterCount: DEFAULT_TARGET_CHAPTER_COUNT,
      systemPrompt:
        'You are an expert technical writer. Generate a comprehensive user guide based on the provided documents.',
    });
    loadServices();
    setDrawerOpen(true);
  };

  const openEdit = (record: SpaceRecord) => {
    setEditingId(record.id);
    form.resetFields();
    form.setFieldsValue({
      title: record.title,
      llmService: record.llmService,
      model: record.model,
      outputFormat: record.outputFormat || 'html',
      targetChapterCount: normalizeTargetChapterCount(record.targetChapterCount),
      chapterGuidance: record.chapterGuidance,
      systemPrompt: record.systemPrompt,
    });
    loadServices();
    loadModels(record.llmService);
    setDrawerOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    values.targetChapterCount = normalizeTargetChapterCount(values.targetChapterCount);
    setSubmitting(true);
    try {
      if (editingId) {
        await api.resource('aiBuildGuideSpaces').update({ filterByTk: editingId, values });
      } else {
        await api.resource('aiBuildGuideSpaces').create({ values });
      }
      message.success(t('Saved successfully'));
      setDrawerOpen(false);
      await loadList();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.response?.data?.error?.message || t('Save failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (record: SpaceRecord) => {
    await api.resource('aiBuildGuideSpaces').destroy({ filterByTk: record.id });
    message.success(t('Deleted'));
    await loadList();
  };

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setBuildingId(null);
  }, []);

  const handleBuild = async (record: SpaceRecord) => {
    setBuildingId(record.id);
    try {
      await api.resource('aiBuildGuideSpaces').build({ filterByTk: record.id });
      message.success(t('Build started'));
      const startedAt = Date.now();
      let stillRunningNotified = false;
      const poll = async () => {
        try {
          const res = await api.resource('aiBuildGuideSpaces').get({ filterByTk: record.id });
          const status = res?.data?.data?.status;
          if (status !== 'building') {
            stopPolling();
            await loadList();
            if (status === 'completed') message.success(t('Build completed'));
            else if (status === 'error') message.error(t('Build failed'));
            return;
          }
          const elapsed = Date.now() - startedAt;
          if (elapsed >= STILL_RUNNING_AFTER_MS && !stillRunningNotified) {
            stillRunningNotified = true;
            message.info(t('Build is still running'));
          }
          const next = elapsed >= STILL_RUNNING_AFTER_MS ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
          timerRef.current = setTimeout(poll, next);
        } catch {
          stopPolling();
          await loadList();
        }
      };
      timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (err: any) {
      message.error(err?.response?.data?.error?.message || t('Build failed'));
      setBuildingId(null);
    }
  };

  const columns = [
    { title: t('Title'), dataIndex: 'title' },
    {
      title: t('Status'),
      dataIndex: 'status',
      render: (v: string) => (v ? <Tag color={STATUS_COLORS[v] || 'default'}>{String(v).toUpperCase()}</Tag> : null),
    },
    { title: t('Build Phase'), dataIndex: 'buildPhase' },
    { title: t('Chapters'), dataIndex: 'pageCount' },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: unknown, record: SpaceRecord) => (
        <Space split="|">
          <Button
            type="link"
            icon={<PlayCircleOutlined />}
            loading={buildingId === record.id}
            disabled={record.status === 'building'}
            onClick={() => handleBuild(record)}
          >
            {t('Build')}
          </Button>
          <a onClick={() => openEdit(record)}>{t('Edit')}</a>
          <a
            onClick={() =>
              modal.confirm({
                title: t('Delete'),
                content: t('Are you sure you want to delete this space?'),
                onOk: () => handleDelete(record),
              })
            }
          >
            {t('Delete')}
          </a>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Create space')}
        </Button>
        <Button onClick={loadList}>{t('Refresh')}</Button>
      </Space>
      <Table rowKey="id" loading={loading} dataSource={data} columns={columns} />
      <Drawer
        title={editingId ? t('Edit space') : t('Create space')}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={640}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setDrawerOpen(false)}>{t('Cancel')}</Button>
            <Button type="primary" loading={submitting} onClick={handleSubmit}>
              {t('Submit')}
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            if ('llmService' in changed) form.setFieldValue('model', undefined);
          }}
        >
          <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="llmService" label={t('LLM Service')} rules={[{ required: true }]}>
            <Select options={serviceOptions} onFocus={loadServices} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="model" label={t('Model')} rules={[{ required: true }]}>
            <Select options={modelOptions} disabled={!selectedService} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="outputFormat" label={t('Output format')} rules={[{ required: true }]}>
            <Select options={OUTPUT_FORMAT_OPTIONS} />
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
        </Form>
      </Drawer>
    </div>
  );
};
