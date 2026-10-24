import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Card, Form, Input, InputNumber, Space, Switch, Tabs } from 'antd';
import React, { useState } from 'react';
import CategoriesManager from '../components/CategoriesManager';
import OcrMonitorDashboard from '../components/OcrMonitorDashboard';
import { useT } from '../locale';
import type { OcrSettings } from '../types';

export default function SettingsPage() {
  const api = useApp().apiClient;
  const t = useT();
  const { message } = App.useApp();
  const [form] = Form.useForm<OcrSettings>();
  const [mapping, setMapping] = useState<unknown>();
  const load = useRequest(
    async () => {
      const [settings, profile] = await Promise.all([
        api.request<{ data: OcrSettings }>({ url: 'ocrVerifySettings:get', method: 'get' }),
        api.request<{ data: unknown }>({ url: 'ocrVerifyMappingProfiles:default', method: 'post' }),
      ]);
      return { settings: settings.data.data, mapping: profile.data.data };
    },
    {
      onSuccess: (result) => {
        form.setFieldsValue({ ...result.settings, callbackApiKey: '' });
        setMapping(result.mapping);
      },
    },
  );
  const save = useRequest(
    async (values: OcrSettings) => {
      await api.request({ url: 'ocrVerifySettings:save', method: 'post', data: values });
      form.setFieldValue('callbackApiKey', '');
      message.success(t('Settings saved'));
    },
    { manual: true, onError: () => message.error(t('Operation failed')) },
  );
  const callback = useRequest(
    async (values: OcrSettings) => {
      const response = await api.request<{
        data: { ok?: boolean; callbackStatus?: string; callbackResponse?: string };
      }>({ url: 'ocrVerifySettings:testCallback', method: 'post', data: values });
      const result = response.data.data;
      if (result.ok) message.success(t('Callback test status: {{status}}', { status: result.callbackStatus }));
      else message.error(result.callbackResponse || t('Callback test failed'));
    },
    { manual: true, onError: () => message.error(t('Callback test failed')) },
  );
  async function testCallback() {
    let values: OcrSettings;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    callback.run(values);
  }
  return (
    <Tabs
      items={[
        {
          key: 'settings',
          label: t('Settings'),
          children: (
            <Card loading={load.loading}>
              {load.error && (
                <Alert
                  type="error"
                  showIcon
                  message={t('Failed to load settings')}
                  action={<Button onClick={load.refresh}>{t('Refresh status')}</Button>}
                />
              )}
              <Form
                form={form}
                layout="vertical"
                disabled={!!load.error || save.loading || callback.loading}
                onFinish={(values) => save.run(values)}
              >
                <Form.Item name="pdfjsCdnUrl" label={t('PDF.js CDN URL')} rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="pdfjsWorkerUrl" label={t('PDF.js worker URL')} rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="callbackUrl" label={t('Callback URL')}>
                  <Input />
                </Form.Item>
                <Form.Item
                  name="callbackApiKey"
                  label={t('Callback API key')}
                  extra={t('Leave empty to keep the existing key. Sent as X-API-Key.')}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Form.Item name="callbackTimeoutMs" label={t('Callback timeout (ms)')}>
                  <InputNumber min={1000} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="acceptStatus" label={t('Accept status')}>
                  <Input />
                </Form.Item>
                <Form.Item name="rejectStatus" label={t('Reject status')}>
                  <Input />
                </Form.Item>
                <Form.Item name="autoSave" label={t('Auto save edits')} valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Space>
                  <Button type="primary" htmlType="submit" loading={save.loading}>
                    {t('Save')}
                  </Button>
                  <Button loading={callback.loading} onClick={testCallback}>
                    {t('Test callback')}
                  </Button>
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
        { key: 'monitor', label: t('OCR monitor'), children: <OcrMonitorDashboard /> },
      ]}
    />
  );
}
