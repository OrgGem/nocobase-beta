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
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';

interface ModelMetadata {
  id: string | number;
  llmService: string;
  model: string;
  contextWindow?: number | null;
  maxCompletionTokens?: number | null;
  ownedByOverride?: string | null;
  displayName?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  enabled: boolean;
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
  const ctx = useFlowContext();
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
        ctx.api.request({
          url: 'aiApiModelMetadata:list',
          method: 'get',
          params: { pageSize: 200, sort: 'llmService' },
        }),
        ctx.api.request({ url: 'ai:listLLMServices', method: 'get' }),
      ]);
      setRows(unwrapData<ModelMetadata[]>(metadataResponse, []));
      setServices(unwrapData<LlmService[]>(servicesResponse, []));
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [ctx.api]);

  useEffect(() => {
    load();
  }, [load]);

  const loadModels = useCallback(
    async (llmService: string, currentModel?: string) => {
      setModelsLoading(true);
      try {
        const response = await ctx.api.request({
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
    [ctx.api, t],
  );

  const showCreate = () => {
    setEditing(undefined);
    setModels([]);
    form.resetFields();
    form.setFieldsValue({ enabled: true } as MetadataFormValues);
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
    };
    setSaving(true);
    try {
      await ctx.api.request({
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
      await ctx.api.request({ url: `aiApiModelMetadata:destroy/${id}`, method: 'post' });
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
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} scroll={{ x: 1450 }} />
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
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
