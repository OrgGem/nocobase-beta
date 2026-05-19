import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Space, Switch, Tabs, message } from 'antd';
import { useAPIClient } from '@nocobase/client';
import { CategoriesManager } from './CategoriesManager';

export const SettingsPage = () => {
  const api = useAPIClient();
  const [form] = Form.useForm();
  const [mapping, setMapping] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [settingsRes, mappingRes] = await Promise.all([
        api.resource('ocrVerifySettings').get(),
        api.resource('ocrVerifyMappingProfiles').default(),
      ]);
      form.setFieldsValue(settingsRes?.data?.data || settingsRes?.data || {});
      setMapping(mappingRes?.data?.data || mappingRes?.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    const values = await form.validateFields();
    await api.resource('ocrVerifySettings').save({ values });
    message.success('Settings saved');
    await load();
  }

  async function testCallback() {
    const values = await form.validateFields();
    const res = await api.resource('ocrVerifySettings').testCallback({ values });
    const data = res?.data?.data || res?.data;
    if (data?.ok) message.success(`Callback test status: ${data.callbackStatus}`);
    else message.error(data?.callbackResponse || 'Callback test failed');
  }

  return (
    <Tabs
      items={[
        {
          key: 'settings',
          label: 'Settings',
          children: (
            <Card loading={loading}>
              <Form form={form} layout="vertical">
                <Form.Item label="PDF.js CDN URL" name="pdfjsCdnUrl" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item label="PDF.js worker URL" name="pdfjsWorkerUrl" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item label="Callback URL" name="callbackUrl">
                  <Input />
                </Form.Item>
                <Form.Item label="Callback API key" name="callbackApiKey" extra="Leave empty to keep the existing key. Sent as X-API-Key.">
                  <Input.Password />
                </Form.Item>
                <Form.Item label="Callback timeout (ms)" name="callbackTimeoutMs">
                  <InputNumber min={1000} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="Accept status" name="acceptStatus">
                  <Input />
                </Form.Item>
                <Form.Item label="Reject status" name="rejectStatus">
                  <Input />
                </Form.Item>
                <Form.Item label="Auto save edits" name="autoSave" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Space>
                  <Button type="primary" onClick={save}>
                    Save
                  </Button>
                  <Button onClick={testCallback}>Test callback</Button>
                </Space>
              </Form>
            </Card>
          ),
        },
        {
          key: 'mapping',
          label: 'Default mapping',
          children: (
            <Card>
              <Alert
                type="info"
                message="Default OCR JSON contract"
                description="The MVP maps pages[].items[] with id/key/value/confidence/status and position/page metadata. Custom mapping profiles are stored as records in ocrVerifyMappingProfiles."
                style={{ marginBottom: 16 }}
              />
              <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(mapping, null, 2)}</pre>
            </Card>
          ),
        },
        {
          key: 'categories',
          label: 'Categories (Profiles)',
          children: (
            <Card>
              <CategoriesManager />
            </Card>
          ),
        },
      ]}
    />
  );
};
