import React, { useEffect, useState } from 'react';
import { Form, Input, Select, Button, message, InputNumber, Spin, Alert, Space } from 'antd';
import { SaveOutlined, LinkOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';

export const ServiceConfigTab = () => {
  const [form] = Form.useForm();
  const app = useApp();
  const api = app.apiClient;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .request({ url: 'docUnderstanding:getConfig' })
      .then(({ data }) => {
        form.setFieldsValue(data?.data || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [api, form]);

  const onFinish = async (values: any) => {
    setSaving(true);
    try {
      await api.request({
        url: 'docUnderstanding:updateConfig',
        method: 'POST',
        data: values,
      });
      message.success('Configuration saved successfully');
    } catch {
      message.error('Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spin style={{ marginTop: 40 }} />;

  return (
    <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 600 }}>
      <Alert
        message="Service Connection"
        description="Configure the connection to your external document processing service. All endpoints will use this base URL and authentication."
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Form.Item
        name="baseUrl"
        label="Base URL"
        rules={[{ required: true, message: 'Base URL is required' }]}
        help="The root URL of your document processing API"
      >
        <Input prefix={<LinkOutlined />} placeholder="http://my-ocr-service:8000" />
      </Form.Item>

      <Form.Item name="authType" label="Authentication Type" initialValue="none">
        <Select>
          <Select.Option value="none">None</Select.Option>
          <Select.Option value="api_key">API Key</Select.Option>
          <Select.Option value="bearer">Bearer Token</Select.Option>
          <Select.Option value="custom_header">Custom Header</Select.Option>
        </Select>
      </Form.Item>

      <Form.Item noStyle dependencies={['authType']}>
        {() => {
          const type = form.getFieldValue('authType');
          if (type === 'none') return null;
          return (
            <>
              {type === 'custom_header' && (
                <Form.Item name="authHeaderName" label="Custom Header Name" rules={[{ required: true }]}>
                  <Input placeholder="X-Api-Key" />
                </Form.Item>
              )}
              <Form.Item
                name="authKey"
                label={type === 'bearer' ? 'Bearer Token' : 'API Key'}
                rules={[{ required: true }]}
              >
                <Input.Password placeholder="Enter key or token" />
              </Form.Item>
            </>
          );
        }}
      </Form.Item>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        <Form.Item name="defaultTimeout" label="Request Timeout (ms)" initialValue={30000}>
          <InputNumber style={{ width: '100%' }} min={1000} step={1000} />
        </Form.Item>
        <Form.Item name="defaultRetries" label="Default Retries" initialValue={2}>
          <InputNumber style={{ width: '100%' }} min={0} max={10} />
        </Form.Item>
        <Form.Item name="pollInterval" label="Poll Interval (ms)" initialValue={5000}>
          <InputNumber style={{ width: '100%' }} min={1000} step={1000} />
        </Form.Item>
        <Form.Item name="pollTimeout" label="Poll Timeout (ms)" initialValue={300000}>
          <InputNumber style={{ width: '100%' }} min={5000} step={5000} />
        </Form.Item>
      </div>

      <Form.Item
        name="webhookSecret"
        label="Webhook Secret"
        help="Used to verify HMAC-SHA256 signatures on incoming webhook callbacks"
      >
        <Input.Password placeholder="Optional: secret for webhook signature verification" />
      </Form.Item>

      <Form.Item>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
          Save Configuration
        </Button>
      </Form.Item>
    </Form>
  );
};
