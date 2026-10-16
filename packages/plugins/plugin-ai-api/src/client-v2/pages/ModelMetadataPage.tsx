import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';

interface ModelMetadata {
  id: string | number;
  llmService: string;
  model: string;
  supportsVision?: boolean;
  supportsToolCalling?: boolean;
  supportsStructuredOutput?: boolean | null;
  supportsReasoning?: boolean | null;
  reasoningTier?: string;
  sortOrder?: number;
  contextWindow?: number | null;
  maxCompletionTokens?: number | null;
  ownedByOverride?: string | null;
  displayName?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  enabled: boolean;
  hidden?: boolean;
}

type MetadataFormValues = Omit<ModelMetadata, 'id'>;

interface LlmService {
  name: string;
  title?: string;
  provider: string;
}

interface LlmModel {
  id: string;
}

export default function ModelMetadataPage() {
  const api = useApp().apiClient;
  const t = useT();
  const [form] = Form.useForm<MetadataFormValues>();
  const selectedService = Form.useWatch('llmService', form);
  const [rows, setRows] = useState<ModelMetadata[]>([]);
  const [services, setServices] = useState<LlmService[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<ModelMetadata>();
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [metadataResponse, servicesResponse] = await Promise.all([
        api.request({
          url: 'aiApiModelMetadata:list',
          method: 'get',
          params: { pageSize: 200, sort: 'llmService' },
        }),
        api.request({ url: 'ai:listLLMServices', method: 'get' }),
      ]);
      setRows(unwrapData<ModelMetadata[]>(metadataResponse, []));
      setServices(unwrapData<LlmService[]>(servicesResponse, []));
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const loadModels = useCallback(
    async (llmService: string, currentModel?: string) => {
      setModelsLoading(true);
      try {
        const response = await api.request({
          url: 'ai:listModels',
          method: 'get',
          params: { llmService },
        });
        const loadedModels = unwrapData<LlmModel[]>(response, []);
        setModels(
          currentModel && !loadedModels.some((item) => item.id === currentModel)
            ? [{ id: currentModel }, ...loadedModels]
            : loadedModels,
        );
      } catch (error) {
        setModels(currentModel ? [{ id: currentModel }] : []);
        message.error(`${t('Failed to load models')}: ${errorMessage(error)}`);
      } finally {
        setModelsLoading(false);
      }
    },
    [api, t],
  );

  const showCreate = () => {
    setEditing(undefined);
    setModels([]);
    form.resetFields();
    form.setFieldsValue({ enabled: true, hidden: false } as MetadataFormValues);
    setOpen(true);
  };

  const showEdit = (record: ModelMetadata) => {
    setEditing(record);
    form.setFieldsValue({ ...record });
    setOpen(true);
    loadModels(record.llmService, record.model);
  };

  const changeService = (llmService: string) => {
    form.setFieldValue('model', undefined);
    setModels([]);
    loadModels(llmService);
  };

  const save = async () => {
    const values = await form.validateFields();
    const data = {
      ...values,
      contextWindow: values.contextWindow ?? null,
      maxCompletionTokens: values.maxCompletionTokens ?? null,
      ownedByOverride: values.ownedByOverride?.trim() || null,
      displayName: values.displayName?.trim() || null,
      description: values.description?.trim() || null,
      systemPrompt: values.systemPrompt?.trim() || null,
      supportsVision: !!values.supportsVision,
      supportsToolCalling: values.supportsToolCalling !== false,
      supportsStructuredOutput: values.supportsStructuredOutput ?? null,
      supportsReasoning: values.supportsReasoning ?? null,
      reasoningTier: values.reasoningTier || 'general',
      sortOrder: values.sortOrder ?? 0,
      hidden: !!values.hidden,
    };
    setSaving(true);
    try {
      await api.request({
        url: editing ? `aiApiModelMetadata:update/${editing.id}` : 'aiApiModelMetadata:create',
        method: 'post',
        data,
      });
      message.success(t('Saved successfully'));
      setOpen(false);
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string | number) => {
    try {
      await api.request({ url: `aiApiModelMetadata:destroy/${id}`, method: 'post' });
      message.success(t('Deleted successfully'));
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const columns: ColumnsType<ModelMetadata> = [
    { title: t('LLM service'), dataIndex: 'llmService', key: 'llmService', width: 160 },
    { title: t('Model'), dataIndex: 'model', key: 'model', width: 180 },
    { title: t('Context window'), dataIndex: 'contextWindow', key: 'contextWindow', width: 140 },
    { title: t('Max completion tokens'), dataIndex: 'maxCompletionTokens', key: 'maxCompletionTokens', width: 170 },
    { title: t('Owned by'), dataIndex: 'ownedByOverride', key: 'ownedByOverride', width: 140 },
    { title: t('Display name'), dataIndex: 'displayName', key: 'displayName', width: 160 },
    {
      title: t('Initial system prompt'),
      dataIndex: 'systemPrompt',
      key: 'systemPrompt',
      width: 220,
      ellipsis: true,
      render: (value?: string | null) => value || '-',
    },
    {
      title: t('Status'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'default'}>{enabled ? t('Enabled') : t('Disabled')}</Tag>
      ),
    },
    {
      title: t('Hidden'),
      dataIndex: 'hidden',
      key: 'hidden',
      width: 100,
      render: (hidden: boolean) => (hidden ? <Tag color="orange">{t('Hidden')}</Tag> : <Tag>{t('Visible')}</Tag>),
    },
    {
      title: t('Actions'),
      key: 'actions',
      fixed: 'right',
      width: 150,
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => showEdit(record)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this override?')} onConfirm={() => remove(record.id)}>
            <Button type="link" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('Model metadata')}
      extra={
        <Button type="primary" onClick={showCreate}>
          {t('Add override')}
        </Button>
      }
    >
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} scroll={{ x: 1550 }} />
      <Modal
        title={editing ? t('Edit override') : t('Add override')}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="llmService" label={t('LLM service')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              onChange={changeService}
              options={services.map((service) => ({ label: service.title || service.name, value: service.name }))}
            />
          </Form.Item>
          <Form.Item name="model" label={t('Model')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={modelsLoading}
              disabled={!selectedService}
              placeholder={t('Select a model')}
              options={models.map((model) => ({ label: model.id, value: model.id }))}
            />
          </Form.Item>
          <Form.Item
            name="contextWindow"
            label={t('Context window')}
            tooltip={t('Total input + output token capacity reported to clients.')}
          >
            <InputNumber
              min={1}
              precision={0}
              style={{ width: '100%' }}
              placeholder={t('Leave empty to not override')}
            />
          </Form.Item>
          <Form.Item
            name="maxCompletionTokens"
            label={t('Max completion tokens')}
            tooltip={t('Maximum output tokens reported to clients.')}
          >
            <InputNumber
              min={1}
              precision={0}
              style={{ width: '100%' }}
              placeholder={t('Leave empty to not override')}
            />
          </Form.Item>
          <Form.Item name="ownedByOverride" label={t('Owned by')}>
            <Input placeholder={t('Leave empty to not override')} />
          </Form.Item>
          <Form.Item name="displayName" label={t('Display name')}>
            <Input placeholder={t('Leave empty to not override')} />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="systemPrompt"
            label={t('Initial system prompt')}
            tooltip={t(
              'Prepended as the first system message, before any system prompt sent by the client. If the client sends no system prompt, this becomes the system prompt sent to the provider.',
            )}
          >
            <Input.TextArea rows={4} placeholder={t('Leave empty to not override')} />
          </Form.Item>
          <Form.Item
            name="supportsVision"
            label={t('Supports vision')}
            valuePropName="checked"
            tooltip={t('Used by virtual-model routing for image/file requests.')}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="supportsToolCalling"
            label={t('Supports tool calling')}
            valuePropName="checked"
            tooltip={t('Used by virtual-model routing for requests with tools/tool_choice.')}
          >
            <Switch defaultChecked />
          </Form.Item>
          <Form.Item
            name="reasoningTier"
            label={t('Reasoning tier')}
            tooltip={t('cheap | general | reasoning. Used by virtual-model routing buckets.')}
          >
            <Select
              options={[
                { value: 'cheap', label: t('Cheap') },
                { value: 'general', label: t('General') },
                { value: 'reasoning', label: t('Reasoning') },
              ]}
            />
          </Form.Item>
          {(['supportsStructuredOutput', 'supportsReasoning'] as const).map((name) => (
            <Form.Item
              key={name}
              name={name}
              label={t(
                name === 'supportsStructuredOutput' ? 'Supports structured output' : 'Supports reasoning parameters',
              )}
              tooltip={t(
                'Unknown capabilities are not assumed. Reasoning tier or routing lists can declare reasoning support.',
              )}
              getValueProps={(value: boolean | null | undefined) => ({
                value: value === true ? 'yes' : value === false ? 'no' : 'unknown',
              })}
              getValueFromEvent={(value: string) => (value === 'yes' ? true : value === 'no' ? false : null)}
            >
              <Select
                options={[
                  { value: 'unknown', label: t('Unknown') },
                  { value: 'yes', label: t('Supported') },
                  { value: 'no', label: t('Not supported') },
                ]}
              />
            </Form.Item>
          ))}
          <Form.Item
            name="sortOrder"
            label={t('Routing priority')}
            tooltip={t('Ascending — lower is preferred when a bucket is derived from metadata.')}
          >
            <InputNumber precision={0} style={{ width: '100%' }} placeholder="0" />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="hidden"
            label={t('Hidden from model list')}
            valuePropName="checked"
            tooltip={t(
              'The model is removed from GET /v1/models, but still works when reached through virtual-model routing (e.g. "auto").',
            )}
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
