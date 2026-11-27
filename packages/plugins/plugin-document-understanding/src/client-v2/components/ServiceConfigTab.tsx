// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { Form, Input, Select, Button, message, InputNumber, Spin, Alert, Switch, Space, Card, Tag } from 'antd';
import { SaveOutlined, LinkOutlined, CheckCircleOutlined, SyncOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { ClientServiceConfig, ServiceConfig, errorMessage, unwrapData } from '../types';

interface LlmServiceOption {
  llmService: string;
  llmServiceTitle: string;
  provider: string;
  enabledModels: Array<{ label: string; value: string }>;
}

export const ServiceConfigTab = () => {
  const [form] = Form.useForm<Partial<ServiceConfig>>();
  const ctx = useFlowContext();
  const api = ctx.api;
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [syncingCatalog, setSyncingCatalog] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [llmServices, setLlmServices] = useState<LlmServiceOption[]>([]);
  const [healthInfo, setHealthInfo] = useState<Record<string, unknown> | null>(null);

  const watchedEngineMode = Form.useWatch('engineMode', form) || 'builtin';
  const watchedLlmService = Form.useWatch('llmService', form);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [configRes, llmRes] = await Promise.all([
          api.request({ url: 'docUnderstanding:getConfig' }),
          api.request({ url: 'docUnderstanding:listLlmServices' }).catch(() => null),
        ]);
        if (cancelled) return;
        form.setFieldsValue({
          engineMode: 'builtin',
          publicGatewayEnabled: true,
          maxFileSizeBytes: 10485760,
          maxFilesPerRequest: 20,
          ...unwrapData<Partial<ClientServiceConfig>>(configRes, {}),
        });
        if (llmRes) {
          setLlmServices(unwrapData<LlmServiceOption[]>(llmRes, []));
        }
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

  const handleCheckHealth = async () => {
    setCheckingHealth(true);
    try {
      const res = await api.request({ url: 'docUnderstanding:getHealth' });
      const data = unwrapData<Record<string, unknown>>(res, {});
      setHealthInfo(data);
      message.success(t('Health check succeeded'));
    } catch (error) {
      message.error(`${t('Health check failed')}: ${errorMessage(error)}`);
    } finally {
      setCheckingHealth(false);
    }
  };

  const handleSyncCatalog = async () => {
    setSyncingCatalog(true);
    try {
      const res = await api.request({ url: 'docUnderstanding:syncCatalog', method: 'POST' });
      const counts = unwrapData<{ endpoints?: number; pipelines?: number }>(res, {});
      message.success(
        `${t('Catalog synchronized')}: ${counts.endpoints ?? 36} endpoints / ${counts.pipelines ?? 36} pipelines`,
      );
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSyncingCatalog(false);
    }
  };

  if (loading) return <Spin style={{ marginTop: 40 }} />;

  const selectedServiceMeta = llmServices.find((s) => s.llmService === watchedLlmService);

  return (
    <Form form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 760 }}>
      {loadError && <Alert message={loadError} type="error" showIcon style={{ marginBottom: 16 }} />}

      <Alert
        message={t('Document Understanding Service & Public API Gateway')}
        description={
          <div>
            <div>
              {t(
                'Provides built-in Document Understanding APIs (/api/du/v1/* and /api/v1/*) compatible with du-rework, with optional delegation to an external gateway.',
              )}
            </div>
            <Space style={{ marginTop: 8 }} wrap>
              <Tag color="blue">POST /api/du/v1/uploads</Tag>
              <Tag color="blue">POST /api/du/v1/businesses/:id/actions/:action</Tag>
              <Tag color="blue">GET /api/du/v1/operations/:id</Tag>
              <Tag color="blue">GET /api/du/v1/artifacts/:id/download</Tag>
            </Space>
          </div>
        }
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<CheckCircleOutlined />} onClick={handleCheckHealth} loading={checkingHealth}>
          {t('Check Service Health')}
        </Button>
        <Button icon={<SyncOutlined />} onClick={handleSyncCatalog} loading={syncingCatalog}>
          {t('Sync du-rework Catalog (36 profiles)')}
        </Button>
      </Space>

      {healthInfo && (
        <Card size="small" style={{ marginBottom: 16 }} title={t('Runtime Health')}>
          <pre style={{ margin: 0, fontSize: 12, overflow: 'auto' }}>{JSON.stringify(healthInfo, null, 2)}</pre>
        </Card>
      )}

      <Card size="small" title={t('Execution Engine & Gateway Policy')} style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0 16px' }}>
          <Form.Item name="engineMode" label={t('Execution Engine Mode')} initialValue="builtin">
            <Select
              options={[
                { value: 'builtin', label: t('Built-in NocoBase AI & Document Parser Engine') },
                { value: 'hybrid', label: t('Hybrid (Built-in first, fallback to External Gateway)') },
                { value: 'du_rework', label: t('External du-rework API Gateway') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="publicGatewayEnabled"
            label={t('Public API Gateway')}
            valuePropName="checked"
            initialValue={true}
          >
            <Switch checkedChildren={t('Enabled')} unCheckedChildren={t('Disabled')} />
          </Form.Item>
        </div>

        {watchedEngineMode !== 'du_rework' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Form.Item
              name="llmService"
              label={t('Reasoning LLM Service (@nocobase/plugin-ai)')}
              help={t('Leave blank to auto-select the first enabled LLM service')}
            >
              <Select
                allowClear
                placeholder={t('Auto-select active LLM service')}
                options={llmServices.map((s) => ({
                  value: s.llmService,
                  label: `${s.llmServiceTitle || s.llmService} (${s.provider})`,
                }))}
              />
            </Form.Item>
            <Form.Item name="llmModel" label={t('Reasoning Model')}>
              {selectedServiceMeta ? (
                <Select
                  allowClear
                  placeholder={t('Auto-select default model')}
                  options={selectedServiceMeta.enabledModels}
                />
              ) : (
                <Input placeholder="gpt-4o / gemini-2.5-pro" />
              )}
            </Form.Item>
            <Form.Item name="visionLlmService" label={t('Vision / OCR LLM Service (Optional)')}>
              <Select
                allowClear
                placeholder={t('Same as Reasoning LLM Service')}
                options={llmServices.map((s) => ({
                  value: s.llmService,
                  label: `${s.llmServiceTitle || s.llmService} (${s.provider})`,
                }))}
              />
            </Form.Item>
            <Form.Item name="visionLlmModel" label={t('Vision / OCR Model (Optional)')}>
              <Input placeholder="gemini-2.5-flash / gpt-4o" />
            </Form.Item>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <Form.Item name="maxFilesPerRequest" label={t('Max Files per Operation (DI-06)')} initialValue={20}>
            <InputNumber style={{ width: '100%' }} min={1} max={50} />
          </Form.Item>
          <Form.Item name="maxFileSizeBytes" label={t('Max File Size (bytes)')} initialValue={10485760}>
            <InputNumber style={{ width: '100%' }} min={102400} step={1048576} />
          </Form.Item>
        </div>
      </Card>

      <Card size="small" title={t('External Gateway & Webhook Connection')} style={{ marginBottom: 16 }}>
        <Form.Item
          name="baseUrl"
          label={t('Base URL')}
          rules={[{ required: true, message: t('Base URL is required') }]}
          help={t('Used when delegating to an external du-rework gateway or custom REST endpoints')}
        >
          <Input prefix={<LinkOutlined />} placeholder="http://du-orchestrator:3000" />
        </Form.Item>

        <Form.Item name="authType" label={t('Authentication Type')} initialValue="none">
          <Select
            options={[
              { value: 'none', label: t('None') },
              { value: 'api_key', label: t('API Key (x-api-key)') },
              { value: 'bearer', label: t('Bearer Token') },
              { value: 'custom_header', label: t('Custom Header') },
            ]}
          />
        </Form.Item>

        <Form.Item noStyle dependencies={['authType']}>
          {() => {
            const type = form.getFieldValue('authType');
            if (!type || type === 'none') return null;
            return (
              <>
                {type === 'custom_header' && (
                  <Form.Item name="authHeaderName" label={t('Custom Header Name')} rules={[{ required: true }]}>
                    <Input placeholder="x-api-key" />
                  </Form.Item>
                )}
                <Form.Item name="authKey" label={type === 'bearer' ? t('Bearer Token') : t('API Key')}>
                  <Input.Password placeholder={t('Leave blank to keep existing secret')} />
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
          help={t('Signs outbound x-du-signature callbacks and verifies incoming webhooks')}
        >
          <Input.Password placeholder={t('Optional: secret for HMAC-SHA256 webhook signature')} />
        </Form.Item>
      </Card>

      <Form.Item>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
          {t('Save Configuration')}
        </Button>
      </Form.Item>
    </Form>
  );
};
