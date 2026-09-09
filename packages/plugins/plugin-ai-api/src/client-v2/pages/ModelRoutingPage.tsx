import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Form, Input, Select, Space, Switch, Typography, message } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';

const { Text } = Typography;

interface VirtualModel {
  id?: string | number;
  name: string;
  mode: string;
  fallbackModel: string;
  visionModels: string[];
  toolModels: string[];
  reasoningModels: string[];
  cheapModels: string[];
  generalModels: string[];
  enabled: boolean;
}

interface EnabledLlmService {
  llmService: string;
  llmServiceTitle?: string;
  enabledModels?: Array<{ label?: string; value: string }>;
}

interface ModelOption {
  value: string; // "serviceName/modelId"
  label: string;
}

const DEFAULT_ALIAS = 'auto';

export default function ModelRoutingPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<Partial<VirtualModel>>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [recordId, setRecordId] = useState<string | number | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vmRes, servicesRes] = await Promise.all([
        ctx.api.request({
          url: 'aiApiVirtualModels:list',
          method: 'get',
          params: { filter: { name: DEFAULT_ALIAS }, pageSize: 1 },
        }),
        // Use the normalized catalog so recommended/provider/custom modes all surface their
        // actual runtime models. The raw llmServices endpoint can return an empty enabledModels
        // array for recommended-mode services, which would leave this page with no choices.
        ctx.api.request({ url: 'ai:listAllEnabledModels', method: 'get' }),
      ]);

      // Build the shared option list: every enabled model of every service, as "service/model".
      const svcList = unwrapData<EnabledLlmService[]>(servicesRes, []);
      const opts: ModelOption[] = [];
      for (const service of svcList) {
        const label = service.llmServiceTitle || service.llmService;
        for (const model of service.enabledModels || []) {
          if (!model?.value) continue;
          opts.push({
            value: `${service.llmService}/${model.value}`,
            label: `${label} / ${model.label || model.value}`,
          });
        }
      }

      const existing = unwrapData<VirtualModel[]>(vmRes, [])[0];
      // Keep stale references visible: values already configured on this alias but no longer
      // present in the enabled catalog are merged back into the options so admins can still
      // see, reorder, and replace them instead of being left with an opaque raw value.
      if (existing) {
        const known = new Set(opts.map((option) => option.value));
        const configured = [
          existing.fallbackModel,
          ...(existing.visionModels || []),
          ...(existing.toolModels || []),
          ...(existing.reasoningModels || []),
          ...(existing.cheapModels || []),
          ...(existing.generalModels || []),
        ].filter((value): value is string => typeof value === 'string' && value.length > 0);
        for (const value of configured) {
          if (known.has(value)) continue;
          known.add(value);
          opts.push({ value, label: `${value} (${t('unavailable')})` });
        }
      }
      setOptions(opts);
      if (existing) {
        setRecordId(existing.id);
        form.setFieldsValue({
          name: existing.name,
          mode: existing.mode || 'chat',
          fallbackModel: existing.fallbackModel,
          visionModels: existing.visionModels || [],
          toolModels: existing.toolModels || [],
          reasoningModels: existing.reasoningModels || [],
          cheapModels: existing.cheapModels || [],
          generalModels: existing.generalModels || [],
          enabled: existing.enabled !== false,
        });
      } else {
        form.setFieldsValue({
          name: DEFAULT_ALIAS,
          mode: 'chat',
          fallbackModel: undefined,
          enabled: true,
          visionModels: [],
          toolModels: [],
          reasoningModels: [],
          cheapModels: [],
          generalModels: [],
        });
      }
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [ctx.api, form, t]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (recordId) {
        await ctx.api.request({ url: `aiApiVirtualModels:update/${recordId}`, method: 'post', data: values });
      } else {
        const res = await ctx.api.request({ url: 'aiApiVirtualModels:create', method: 'post', data: values });
        const created = unwrapData<VirtualModel | undefined>(res, undefined);
        if (created?.id) setRecordId(created.id);
      }
      message.success(t('Saved successfully'));
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  // Keep stored order visible: render selected tags in the order of the field value,
  // and let the dropdown offer the remaining options.
  const orderedSelectProps = {
    options,
    optionFilterProp: 'label' as const,
    showSearch: true,
    loading,
  };

  const listField = (name: keyof VirtualModel, label: string, tooltip: string) => (
    <Form.Item name={name} label={label} tooltip={tooltip}>
      <Select
        mode="multiple"
        placeholder={t('Select models — the order shown is the routing priority')}
        {...orderedSelectProps}
      />
    </Form.Item>
  );

  return (
    <Card loading={loading} title={t('Model routing (virtual models)')}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label={t('Alias')} rules={[{ required: true }]}>
          <Input disabled style={{ maxWidth: 240 }} />
        </Form.Item>
        <Form.Item name="mode" hidden>
          <Input />
        </Form.Item>
        <Form.Item
          name="fallbackModel"
          label={t('Fallback model')}
          rules={[{ required: true, message: t('A fallback model is required') }]}
          tooltip={t(
            'Used when no capability bucket candidate is usable and the fallback is permitted for the caller.',
          )}
        >
          <Select
            placeholder={t('Select a fallback model')}
            options={options}
            optionFilterProp="label"
            showSearch
            style={{ maxWidth: 480 }}
          />
        </Form.Item>

        {listField(
          'visionModels',
          t('Vision models (in order)'),
          t('Requests with an image or file block use the first permitted model here.'),
        )}
        {listField(
          'toolModels',
          t('Tool-calling models (in order)'),
          t('Requests with tools/tool_choice use the first permitted model here.'),
        )}
        {listField(
          'reasoningModels',
          t('Reasoning models (in order)'),
          t('Requests with an explicit reasoning or reasoning_effort parameter use the first permitted model here.'),
        )}
        {listField(
          'cheapModels',
          t('Cheap models (in order)'),
          t('Optional. When set, cheap-eligible requests use the first permitted model here.'),
        )}
        {listField(
          'generalModels',
          t('General models (in order)'),
          t(
            'Default bucket when no capability rule matched. Leave empty to derive from all enabled models ordered by Model metadata sortOrder.',
          ),
        )}

        <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
          <Switch />
        </Form.Item>

        <Space>
          <Button type="primary" onClick={save} loading={saving}>
            {t('Save')}
          </Button>
          <Text type="secondary">
            {t('An empty bucket is derived automatically from Model metadata (capability flags + sortOrder).')}
          </Text>
        </Space>
      </Form>
    </Card>
  );
}
