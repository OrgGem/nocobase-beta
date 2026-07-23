import { useFlowContext } from '@nocobase/flow-engine';
import { Alert, Button, Card, Form, Input, InputNumber, Space, message } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { actionData, ActionResponse, ApiEnvelope, errorMessage } from './shared';

interface Settings {
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  maxAttempts: number;
  concurrency: number;
  batchSize: number;
  retryBaseSeconds: number;
  processingTimeoutMinutes: number;
}

export default function ConfigurationPage() {
  const api = useFlowContext().api;
  const t = useT();
  const [form] = Form.useForm<Settings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.request<ActionResponse<ApiEnvelope<Settings | null>>>({
        url: 'msGraphGateway:getSettings',
      });
      const settings = actionData(response.data).data;
      if (settings) form.setFieldsValue(settings);
      else
        form.setFieldsValue({
          name: 'default',
          maxAttempts: 5,
          concurrency: 2,
          batchSize: 10,
          retryBaseSeconds: 30,
          processingTimeoutMinutes: 15,
        });
    } finally {
      setLoading(false);
    }
  }, [api, form]);
  useEffect(() => {
    load().catch((error) => message.error(errorMessage(error, t('Load failed'))));
  }, [load, t]);
  const save = async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      await api.request({ url: 'msGraphGateway:saveSettings', method: 'post', data: values });
      message.success(t('Saved successfully'));
      await load();
    } catch (error) {
      message.error(errorMessage(error, t('Save failed')));
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      await api.request({ url: 'msGraphGateway:testConnection', method: 'post' });
      message.success(t('Connection successful'));
    } catch (error) {
      message.error(errorMessage(error, t('Connection failed')));
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card title={t('Microsoft Graph configuration')} loading={loading}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t(
          'Use an Entra ID application with Microsoft Graph application permissions and tenant admin consent.',
        )}
      />
      <Form form={form} layout="vertical" style={{ maxWidth: 760 }}>
        <Form.Item name="name" label={t('Configuration name')} rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="tenantId" label={t('Tenant ID')} rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="clientId" label={t('Client ID')} rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item
          name="clientSecret"
          label={t('Client secret')}
          rules={[{ required: true }]}
          extra={t('The secret is encrypted at rest. Leave the masked value unchanged to keep it.')}
        >
          <Input.Password />
        </Form.Item>
        <Space wrap align="start">
          <Form.Item name="maxAttempts" label={t('Maximum attempts')}>
            <InputNumber min={1} max={20} />
          </Form.Item>
          <Form.Item name="concurrency" label={t('Concurrency')}>
            <InputNumber min={1} max={20} />
          </Form.Item>
          <Form.Item name="batchSize" label={t('Batch size')}>
            <InputNumber min={1} max={100} />
          </Form.Item>
          <Form.Item name="retryBaseSeconds" label={t('Retry base seconds')}>
            <InputNumber min={1} />
          </Form.Item>
          <Form.Item name="processingTimeoutMinutes" label={t('Processing timeout minutes')}>
            <InputNumber min={1} />
          </Form.Item>
        </Space>
        <Form.Item>
          <Space>
            <Button type="primary" loading={saving} onClick={save}>
              {t('Save')}
            </Button>
            <Button loading={testing} onClick={test}>
              {t('Test connection')}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Card>
  );
}
