import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
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
import dayjs, { type Dayjs } from 'dayjs';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';

interface ModelPrice {
  id: string | number;
  llmService: string;
  provider: string;
  model: string;
  currency: string;
  inputPricePerMillionTokens: string;
  cacheInputPricePerMillionTokens: string;
  outputPricePerMillionTokens: string;
  fixedCostPerRequest: string;
  effectiveFrom: string;
  effectiveTo?: string;
  enabled: boolean;
  notes?: string;
}

interface PriceFormValues extends Omit<ModelPrice, 'id' | 'effectiveFrom' | 'effectiveTo'> {
  effectiveFrom: Dayjs;
  effectiveTo?: Dayjs;
}

interface LlmService {
  name: string;
  title?: string;
  provider: string;
}

interface LlmModel {
  id: string;
}

export default function ModelPricingPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<PriceFormValues>();
  const selectedService = Form.useWatch('llmService', form);
  const [rows, setRows] = useState<ModelPrice[]>([]);
  const [services, setServices] = useState<LlmService[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<ModelPrice>();
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pricesResponse, servicesResponse] = await Promise.all([
        ctx.api.request({
          url: 'aiApiModelPrices:list',
          method: 'get',
          params: { pageSize: 200, sort: '-effectiveFrom' },
        }),
        ctx.api.request({ url: 'ai:listLLMServices', method: 'get' }),
      ]);
      setRows(unwrapData<ModelPrice[]>(pricesResponse, []));
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

  const showCreate = () => {
    setEditing(undefined);
    setModels([]);
    form.setFieldsValue({
      currency: 'USD',
      inputPricePerMillionTokens: '0',
      cacheInputPricePerMillionTokens: '0',
      outputPricePerMillionTokens: '0',
      fixedCostPerRequest: '0',
      effectiveFrom: dayjs(),
      enabled: true,
    } as PriceFormValues);
    setOpen(true);
  };

  const showEdit = (record: ModelPrice) => {
    setEditing(record);
    form.setFieldsValue({
      ...record,
      effectiveFrom: dayjs(record.effectiveFrom),
      effectiveTo: record.effectiveTo ? dayjs(record.effectiveTo) : undefined,
    });
    setOpen(true);
    loadModels(record.llmService, record.model);
  };

  const loadModels = async (llmService: string, currentModel?: string) => {
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
  };

  const changeService = (llmService: string) => {
    form.setFieldValue('model', undefined);
    setModels([]);
    loadModels(llmService);
  };

  const save = async () => {
    const values = await form.validateFields();
    const service = services.find((item) => item.name === values.llmService);
    const data = {
      ...values,
      provider: service?.provider ?? values.provider,
      effectiveFrom: values.effectiveFrom.toISOString(),
      effectiveTo: values.effectiveTo?.toISOString() ?? null,
    };
    setSaving(true);
    try {
      await ctx.api.request({
        url: editing ? `aiApiModelPrices:update/${editing.id}` : 'aiApiModelPrices:create',
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
      await ctx.api.request({ url: `aiApiModelPrices:destroy/${id}`, method: 'post' });
      message.success(t('Deleted successfully'));
      await load();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const columns: ColumnsType<ModelPrice> = [
    { title: t('LLM service'), dataIndex: 'llmService', key: 'llmService', width: 180 },
    { title: t('Model'), dataIndex: 'model', key: 'model', width: 180 },
    { title: t('Input price / 1M'), dataIndex: 'inputPricePerMillionTokens', key: 'inputPrice', width: 150 },
    {
      title: t('Cache input price / 1M'),
      dataIndex: 'cacheInputPricePerMillionTokens',
      key: 'cacheInputPrice',
      width: 170,
    },
    { title: t('Output price / 1M'), dataIndex: 'outputPricePerMillionTokens', key: 'outputPrice', width: 150 },
    { title: t('Fixed request cost'), dataIndex: 'fixedCostPerRequest', key: 'fixedCost', width: 150 },
    { title: t('Currency'), dataIndex: 'currency', key: 'currency', width: 90 },
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
          <Popconfirm title={t('Delete this price?')} onConfirm={() => remove(record.id)}>
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
      title={t('Model pricing')}
      extra={
        <Button type="primary" onClick={showCreate}>
          {t('Add price')}
        </Button>
      }
    >
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} scroll={{ x: 1200 }} />
      <Modal
        title={editing ? t('Edit price') : t('Add price')}
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
          <Form.Item name="provider" hidden>
            <Input />
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
          <Form.Item name="currency" label={t('Currency')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="inputPricePerMillionTokens" label={t('Input price / 1M')} rules={[{ required: true }]}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="cacheInputPricePerMillionTokens"
            label={t('Cache input price / 1M')}
            rules={[{ required: true }]}
          >
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="outputPricePerMillionTokens" label={t('Output price / 1M')} rules={[{ required: true }]}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="fixedCostPerRequest" label={t('Fixed request cost')} rules={[{ required: true }]}>
            <InputNumber min={0} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="effectiveFrom" label={t('Effective from')} rules={[{ required: true }]}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="effectiveTo" label={t('Effective to')}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="notes" label={t('Notes')}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
