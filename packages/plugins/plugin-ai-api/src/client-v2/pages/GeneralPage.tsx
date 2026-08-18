import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Form, InputNumber, Select, Space, Switch, Typography, message } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';

interface GeneralSettings {
  mode: 'llm' | 'agent';
  defaultAiEmployee?: string;
  defaultLlmService?: string;
  enabledLlmServices: string[];
  maxRequestBodyMb: number;
  quotaEnabled: boolean;
  defaultReservationOutputTokens: number;
}

interface LlmService {
  name: string;
  title?: string;
}

interface AiEmployee {
  username: string;
  nickname?: string;
}

const defaults: GeneralSettings = {
  mode: 'llm',
  enabledLlmServices: [],
  maxRequestBodyMb: 10,
  quotaEnabled: false,
  defaultReservationOutputTokens: 4096,
};

/** Mirrors MAX_REQUEST_BODY_MB_LIMIT in server/routes/router.ts, which rejects anything higher. */
const MAX_REQUEST_BODY_MB = 100;

export default function GeneralPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<GeneralSettings>();
  const mode = Form.useWatch('mode', form);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [services, setServices] = useState<LlmService[]>([]);
  const [employees, setEmployees] = useState<AiEmployee[]>([]);
  const [loadError, setLoadError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const [configResponse, servicesResponse, employeesResponse] = await Promise.all([
        ctx.api.request({ url: 'aiApiConfig:get', method: 'get' }),
        ctx.api.request({ url: 'ai:listLLMServices', method: 'get' }),
        ctx.api.request({ url: 'aiEmployees:list', method: 'get', params: { paginate: false } }),
      ]);
      form.setFieldsValue({ ...defaults, ...unwrapData<Partial<GeneralSettings>>(configResponse, {}) });
      setServices(unwrapData<LlmService[]>(servicesResponse, []));
      setEmployees(unwrapData<AiEmployee[]>(employeesResponse, []));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [ctx.api, form]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await ctx.api.request({ url: 'aiApiConfig:save', method: 'post', data: values });
      message.success(t('Configuration saved'));
    } catch (error) {
      message.error(`${t('Failed to save configuration')}: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const serviceOptions = services.map((service) => ({
    label: service.title || service.name,
    value: service.name,
  }));
  const employeeOptions = employees.map((employee) => ({
    label: employee.nickname ? `${employee.nickname} (${employee.username})` : employee.username,
    value: employee.username,
  }));
  const baseUrl = `${window.location.origin}/api/ai-llm/v1`;

  return (
    <Card title={t('Configuration')} loading={loading}>
      {loadError ? <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} /> : null}
      <Form form={form} layout="vertical" style={{ maxWidth: 720 }} initialValues={defaults}>
        <Form.Item name="mode" label={t('API mode')} rules={[{ required: true }]}>
          <Select
            options={[
              { label: t('Direct LLM'), value: 'llm' },
              { label: t('AI Employee agent'), value: 'agent' },
            ]}
          />
        </Form.Item>
        <Form.Item name="defaultLlmService" label={t('Default LLM service')}>
          <Select allowClear showSearch optionFilterProp="label" options={serviceOptions} />
        </Form.Item>
        <Form.Item name="enabledLlmServices" label={t('Enabled LLM Services')}>
          <Select mode="multiple" allowClear showSearch optionFilterProp="label" options={serviceOptions} />
        </Form.Item>
        {mode === 'agent' ? (
          <Form.Item name="defaultAiEmployee" label={t('Default AI Employee')}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('Select an AI Employee')}
              options={employeeOptions}
            />
          </Form.Item>
        ) : null}
        <Form.Item
          name="maxRequestBodyMb"
          label={t('Max request body size (MB)')}
          extra={t('Raise this to accept inline base64 images. Base64 adds about 33% to the original file size.')}
          rules={[{ required: true }]}
        >
          <InputNumber min={1} max={MAX_REQUEST_BODY_MB} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="quotaEnabled" label={t('Enable user quotas')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="defaultReservationOutputTokens"
          label={t('Default reserved output tokens')}
          rules={[{ required: true }]}
        >
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
        <Space>
          <Button type="primary" loading={saving} onClick={save}>
            {t('Save Configuration')}
          </Button>
          <Button onClick={load}>{t('Refresh')}</Button>
        </Space>
      </Form>
      <Card title={t('Usage guide')} size="small" style={{ marginTop: 24 }}>
        <Alert
          type="info"
          showIcon
          message={t('OpenAI-compatible endpoint')}
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text>{t('Base URL')}</Typography.Text>
              <Typography.Text code copyable>
                {baseUrl}
              </Typography.Text>
              <Typography.Text>{t('Use a NocoBase API key as the Bearer token.')}</Typography.Text>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />
        <Typography.Paragraph>{t('List available models')}</Typography.Paragraph>
        <Typography.Paragraph
          code
          copyable
        >{`curl ${baseUrl}/models -H "Authorization: Bearer <your-api-key>"`}</Typography.Paragraph>
        <Typography.Paragraph>{t('Send a chat completion')}</Typography.Paragraph>
        <Typography.Paragraph code copyable>{`curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer <your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<service>/<model>","messages":[{"role":"user","content":"Hello"}]}'`}</Typography.Paragraph>
      </Card>
    </Card>
  );
}
