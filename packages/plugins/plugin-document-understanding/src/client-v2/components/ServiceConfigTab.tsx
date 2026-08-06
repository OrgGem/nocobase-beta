import React, { useEffect, useState } from 'react';
import { Form, Input, Select, Button, message, InputNumber, Spin, Alert } from 'antd';
import { SaveOutlined, LinkOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { ClientServiceConfig, ServiceConfig, errorMessage, unwrapData } from '../types';

export const ServiceConfigTab = () => {
  const [form] = Form.useForm<Partial<ServiceConfig>>();
  const ctx = useFlowContext();
  const api = ctx.api;
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await api.request({ url: 'docUnderstanding:getConfig' });
        if (cancelled) return;
        form.setFieldsValue(unwrapData<Partial<ClientServiceConfig>>(response, {}));
      } catch (error) {
        if (!cancelled) setLoadError(errorMessage(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [api, form]);

  const onFinish = async (values: Partial<ServiceConfig>) => {
    setSaving(true);
    try {
      await api.request({
        url: 'docUnderstanding:updateConfig',
        method: 'POST',
        data: values,
      });
      message.success(t('Configuration saved successfully'));
    } catch (error) {
      message.error(`${t('Failed to save config')}: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spin style={{ marginTop: 40 }} />;

  return (
    <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 600 }}>
      {loadError && <Alert message={loadError} type="error" showIcon style={{ marginBottom: 16 }} />}

      <Alert
        message={t('Service Connection')}
        description={t('Configure the connection to your external document processing service')}
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Form.Item
        name="baseUrl"
        label={t('Base URL')}
        rules={[{ required: true, message: t('Base URL is required') }]}
        help={t('The root URL of your document processing API')}
      >
        <Input prefix={<LinkOutlined />} placeholder="http://my-ocr-service:8000" />
      </Form.Item>

      <Form.Item name="authType" label={t('Authentication Type')} initialValue="none">
        <Select
          options={[
            { value: 'none', label: t('None') },
            { value: 'api_key', label: t('API Key') },
            { value: 'bearer', label: t('Bearer Token') },
            { value: 'custom_header', label: t('Custom Header') },
          ]}
        />
      </Form.Item>

      <Form.Item noStyle dependencies={['authType']}>
        {() => {
          const type = form.getFieldValue('authType');
          if (type === 'none') return null;
          return (
            <>
              {type === 'custom_header' && (
                <Form.Item name="authHeaderName" label={t('Custom Header Name')} rules={[{ required: true }]}>
                  <Input placeholder="X-Api-Key" />
                </Form.Item>
              )}
              <Form.Item
                name="authKey"
                label={type === 'bearer' ? t('Bearer Token') : t('API Key')}
                rules={[{ required: true }]}
              >
                <Input.Password placeholder={t('Enter key or token')} />
              </Form.Item>
            </>
          );
        }}
      </Form.Item>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        <Form.Item name="defaultTimeout" label={t('Request Timeout (ms)')} initialValue={30000}>
          <InputNumber style={{ width: '100%' }} min={1000} step={1000} />
        </Form.Item>
        <Form.Item name="defaultRetries" label={t('Default Retries')} initialValue={2}>
          <InputNumber style={{ width: '100%' }} min={0} max={10} />
        </Form.Item>
        <Form.Item name="pollInterval" label={t('Poll Interval (ms)')} initialValue={5000}>
          <InputNumber style={{ width: '100%' }} min={1000} step={1000} />
        </Form.Item>
        <Form.Item name="pollTimeout" label={t('Poll Timeout (ms)')} initialValue={300000}>
          <InputNumber style={{ width: '100%' }} min={5000} step={5000} />
        </Form.Item>
      </div>

      <Form.Item
        name="webhookSecret"
        label={t('Webhook Secret')}
        help={t('Used to verify HMAC-SHA256 signatures on incoming webhook callbacks')}
      >
        <Input.Password placeholder={t('Optional: secret for webhook signature verification')} />
      </Form.Item>

      <Form.Item>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
          {t('Save Configuration')}
        </Button>
      </Form.Item>
    </Form>
  );
};
