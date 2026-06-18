import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Space, Switch, Tabs, message } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { CategoriesManager } from './CategoriesManager';
import { OcrMonitorDashboard } from './OcrMonitorDashboard';
import { useT } from '../locale';

export const SettingsPage = () => {
  const api = useApp().apiClient;
  const t = useT();
  const [form] = Form.useForm();
  const [mapping, setMapping] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
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
  }, [api, form]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    const values = await form.validateFields();
    await api.resource('ocrVerifySettings').save({ values });
    message.success(t('Settings saved'));
    await load();
  }

  async function testCallback() {
    const values = await form.validateFields();
    const res = await api.resource('ocrVerifySettings').testCallback({ values });
    const data = res?.data?.data || res?.data;
    if (data?.ok) message.success(t('Callback test status: {{status}}', { status: data.callbackStatus }));
    else message.error(data?.callbackResponse || t('Callback test failed'));
  }

  return (
    <Tabs
      items={[
        {
          key: 'settings',
          label: t('Settings'),
          children: (
            <Card loading={loading}>
              <Form form={form} layout="vertical">
                <Form.Item label={t('PDF.js CDN URL')} name="pdfjsCdnUrl" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item label={t('PDF.js worker URL')} name="pdfjsWorkerUrl" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item label={t('Callback URL')} name="callbackUrl">
                  <Input />
                </Form.Item>
                <Form.Item
                  label={t('Callback API key')}
                  name="callbackApiKey"
                  extra={t('Leave empty to keep the existing key. Sent as X-API-Key.')}
                >
                  <Input.Password />
                </Form.Item>
                <Form.Item label={t('Callback timeout (ms)')} name="callbackTimeoutMs">
                  <InputNumber min={1000} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('Accept status')} name="acceptStatus">
                  <Input />
                </Form.Item>
                <Form.Item label={t('Reject status')} name="rejectStatus">
                  <Input />
                </Form.Item>
                <Form.Item label={t('Auto save edits')} name="autoSave" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Space>
                  <Button type="primary" onClick={save}>
                    {t('Save')}
                  </Button>
                  <Button onClick={testCallback}>{t('Test callback')}</Button>
                </Space>
              </Form>
            </Card>
          ),
        },
        {
          key: 'mapping',
          label: t('Default mapping'),
          children: (
            <Card>
              <Alert
                type="info"
                message={t('Default OCR JSON contract')}
                description={t(
                  'The default profile maps pages[].items[] with id/key/value/confidence/status and position/page metadata.',
                )}
                style={{ marginBottom: 16 }}
              />
              <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(mapping, null, 2)}</pre>
            </Card>
          ),
        },
        {
          key: 'categories',
          label: t('Categories (profiles)'),
          children: (
            <Card>
              <CategoriesManager />
            </Card>
          ),
        },
        {
          key: 'monitor',
          label: t('OCR monitor'),
          children: <OcrMonitorDashboard />,
        },
      ]}
    />
  );
};
