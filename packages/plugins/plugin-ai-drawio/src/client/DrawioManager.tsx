import React, { useEffect, useState } from 'react';
import { Tabs, Card, Button, Form, Input, App as AntApp, Typography, Space } from 'antd';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { useT } from './locale';
import { getWrappedData } from './apiResponse';

const { Text } = Typography;

type DrawioConfig = {
  drawioBaseUrl?: string;
  fromEnv?: boolean;
};

const SettingsTab: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const { data, refresh, loading } = useRequest(() => api.resource('aiDrawio').getConfig());
  const [saving, setSaving] = useState(false);
  const config = getWrappedData<DrawioConfig>(data);

  useEffect(() => {
    form.setFieldsValue({ drawioBaseUrl: config?.drawioBaseUrl || '' });
  }, [config?.drawioBaseUrl, form]);

  const onSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await api.request({
        url: 'aiDrawio:setConfig',
        method: 'post',
        data: values,
      });
      message.success(t('Saved successfully'));
      refresh();
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'errorFields' in err) return;
      message.error(err instanceof Error ? err.message : t('Save failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card loading={loading}>
      <Form form={form} layout="vertical">
        <Form.Item
          label={t('Drawio base URL')}
          name="drawioBaseUrl"
          rules={[{ required: true, type: 'url', message: t('Invalid URL') }]}
          extra={t('Drawio base URL is the self-hosted drawio editor URL (e.g. https://drawio.example.com)')}
        >
          <Input placeholder="https://drawio.example.com" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" onClick={onSave} loading={saving}>
            {t('Save')}
          </Button>
        </Form.Item>
      </Form>
      {config?.fromEnv && (
        <Text type="secondary">{t('Currently sourced from DRAWIO_BASE_URL env var. Saving will override.')}</Text>
      )}
    </Card>
  );
};

const SystemPromptTab: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { message } = AntApp.useApp();
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const loadPrompt = async () => {
      setLoading(true);
      try {
        const res = await api.request({ url: 'aiDrawio:getSystemPrompt', method: 'get' });
        if (cancelled) return;
        const body = res?.data;
        setPrompt(typeof body === 'string' ? body : String(body ?? ''));
      } catch (err: unknown) {
        if (cancelled) return;
        message.error(err instanceof Error ? err.message : t('Save failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadPrompt();
    return () => {
      cancelled = true;
    };
  }, [api, message, t]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      message.success(t('Saved successfully'));
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : t('Copy failed'));
    }
  };

  return (
    <Card loading={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Text type="secondary">
          {t(
            'Paste this prompt into the "About" / instructions field of an AI Employee when you want it to follow the complete Drawio workflow. Drawio tools are available automatically.',
          )}
        </Text>
        <Space>
          <Button onClick={onCopy} type="primary">
            {t('Copy to clipboard')}
          </Button>
        </Space>
        <Input.TextArea
          value={prompt}
          autoSize={{ minRows: 18, maxRows: 40 }}
          readOnly
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Space>
    </Card>
  );
};

export const DrawioManager: React.FC = () => {
  const t = useT();
  const items = [
    { key: 'settings', label: t('Settings'), children: <SettingsTab /> },
    { key: 'systemPrompt', label: t('AI Employee prompt'), children: <SystemPromptTab /> },
  ];
  return <Tabs defaultActiveKey="settings" items={items} />;
};
