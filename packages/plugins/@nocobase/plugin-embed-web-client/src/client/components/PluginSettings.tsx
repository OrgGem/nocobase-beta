/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAPIClient, useTranslation } from '@nocobase/client';
import {
  Form,
  InputNumber,
  Select,
  Switch,
  Button,
  Card,
  Space,
  Typography,
  Divider,
  Alert,
  message,
  Spin,
  Tag,
  List,
  Badge,
} from 'antd';
import {
  ThunderboltOutlined,
  ExperimentOutlined,
  CloudDownloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

const MODEL_PRESETS = [
  { label: 'all-MiniLM-L6-v2 (384-dim, ~23 MB, English)', value: 'Xenova/all-MiniLM-L6-v2' },
  { label: 'bge-small-en-v1.5 (384-dim, ~33 MB, English)', value: 'Xenova/bge-small-en-v1.5' },
  { label: 'gte-small (384-dim, ~67 MB, English)', value: 'Supabase/gte-small' },
  {
    label: 'paraphrase-multilingual-MiniLM-L12-v2 (384-dim, ~120 MB, multilingual)',
    value: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  },
];

const DTYPE_OPTIONS = [
  { label: 'q4 (smallest, fastest, lowest quality)', value: 'q4' },
  { label: 'q8 (recommended — good balance)', value: 'q8' },
  { label: 'fp16 (higher quality, larger)', value: 'fp16' },
  { label: 'fp32 (full precision, largest)', value: 'fp32' },
];

interface ModelFileStatus {
  file: string;
  present: boolean;
}

interface ModelStatus {
  modelId: string;
  dtype: string;
  downloaded: boolean;
  files: ModelFileStatus[];
}

export const PluginSettings: React.FC = () => {
  const api = useAPIClient();
  const { t } = useTranslation('plugin-embed-web-client');
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ dims: number; timeMs: number } | null>(null);
  const [webGPUAvailable, setWebGPUAvailable] = useState<boolean | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Check WebGPU availability
  useEffect(() => {
    setWebGPUAvailable(!!(navigator as any).gpu);
  }, []);

  const fetchModelStatus = useCallback(async () => {
    try {
      const res = await api.request({ url: 'embedWebClient:getModelStatus' });
      setModelStatus(res?.data?.data ?? null);
    } catch {
      // non-fatal — status panel just won't show
    }
  }, [api]);

  useEffect(() => {
    // eslint-disable-next-line promise/catch-or-return
    api
      .request({ url: 'embedWebClient:getConfig' })
      .then((res) => {
        form.setFieldsValue(res?.data?.data ?? {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    fetchModelStatus().catch(() => {});
  }, [api, form, fetchModelStatus]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await api.request({
        url: 'embedWebClient:updateConfig',
        method: 'post',
        data: { values },
      });
      message.success(t('Settings saved'));
      // Refresh model status — model may have changed
      await fetchModelStatus();
    } catch {
      message.error(t('Failed to save settings'));
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadModel = async () => {
    const values = form.getFieldsValue();
    const modelId = Array.isArray(values.modelId) ? values.modelId[0] : values.modelId;
    const dtype = values.dtype ?? 'q8';

    if (!modelId) {
      message.warning(t('Select a model first'));
      return;
    }

    setDownloading(true);
    try {
      const res = await api.request({
        url: 'embedWebClient:downloadModel',
        method: 'post',
        data: { values: { modelId, dtype } },
      });
      const result = res?.data?.data;
      if (result?.success) {
        message.success(t('Model downloaded successfully'));
      } else {
        message.error(`${t('Download failed')}: ${result?.error ?? 'unknown error'}`);
      }
      await fetchModelStatus();
    } catch (err: any) {
      message.error(`${t('Download failed')}: ${err?.message}`);
    } finally {
      setDownloading(false);
    }
  };

  const handleTestEmbedding = async () => {
    const values = form.getFieldsValue();
    setTesting(true);
    setTestResult(null);
    try {
      // Dynamically import and run in-browser for a quick test
      const { pipeline } = await import('@huggingface/transformers' as any);
      const t0 = Date.now();
      const pipe = await pipeline('feature-extraction', values.modelId, {
        dtype: values.dtype,
        device: values.preferWebGPU && (navigator as any).gpu ? 'webgpu' : 'wasm',
      });
      const output = await pipe(['Hello world, this is a test sentence.'], {
        pooling: 'mean',
        normalize: true,
      });
      const dims = output[0].data.length;
      setTestResult({ dims, timeMs: Date.now() - t0 });
    } catch (err: any) {
      message.error(`${t('Embedding test failed')}: ${err?.message}`);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, padding: '32px 0' }}>
      <Title level={4} style={{ marginBottom: 8 }}>
        {t('Browser Embedding Settings')}
      </Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        {t("Documents will be embedded in the user's browser using a lightweight AI model. No API cost for embedding.")}
      </Text>

      <Alert
        type="info"
        showIcon
        message={t('Vector dimension compatibility')}
        description={t(
          'The Dimensions value must match the vector size configured in your PGVector table. If you change the model to one with different dimensions, you must recreate the vector store.',
        )}
        style={{ marginBottom: 24 }}
      />

      {/* ── Model file status (offline readiness) ─────────────────────────── */}
      <Card
        title={
          <Space>
            <CloudDownloadOutlined />
            <span>{t('Model Files (Offline Readiness)')}</span>
            {modelStatus &&
              (modelStatus.downloaded ? (
                <Tag color="success" icon={<CheckCircleOutlined />}>
                  {t('Ready')}
                </Tag>
              ) : (
                <Tag color="warning" icon={<CloseCircleOutlined />}>
                  {t('Not downloaded')}
                </Tag>
              ))}
          </Space>
        }
        style={{ marginBottom: 24 }}
        extra={
          <Button icon={<CloudDownloadOutlined />} loading={downloading} onClick={handleDownloadModel}>
            {t('Download Model to Server')}
          </Button>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          {t(
            'Model files are served from the NocoBase server — no internet access required in the browser. Click "Download Model to Server" once (requires server internet access) to cache all model files locally.',
          )}
        </Text>

        {modelStatus && (
          <List
            size="small"
            dataSource={modelStatus.files}
            renderItem={(f) => (
              <List.Item>
                <Space>
                  {f.present ? (
                    <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  ) : (
                    <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                  )}
                  <Text code>{f.file}</Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      {webGPUAvailable !== null && (
        <div style={{ marginBottom: 16 }}>
          <Text>WebGPU: </Text>
          {webGPUAvailable ? (
            <Tag color="success" icon={<ThunderboltOutlined />}>
              {t('WebGPU available')} (10–50× speedup)
            </Tag>
          ) : (
            <Tag color="default">{t('WebGPU not available (using WASM)')}</Tag>
          )}
        </div>
      )}

      <Card>
        <Form form={form} layout="vertical">
          <Form.Item
            name="modelId"
            label={t('Embedding Model')}
            rules={[{ required: true }]}
            extra={t('Must be an ONNX-compatible feature-extraction model from HuggingFace Hub')}
          >
            <Select
              options={MODEL_PRESETS}
              showSearch
              allowClear={false}
              mode="tags"
              maxCount={1}
              placeholder={t('Select or type a model ID')}
              filterOption={(input, opt) => (opt?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>

          <Form.Item
            name="dtype"
            label={t('Quantization')}
            rules={[{ required: true }]}
            extra={t('q8 is recommended for most use cases')}
          >
            <Select options={DTYPE_OPTIONS} />
          </Form.Item>

          <Form.Item
            name="dimensions"
            label={t('Dimensions')}
            rules={[{ required: true, type: 'number', min: 1 }]}
            extra={t("Must match the vector store's configured dimension. all-MiniLM-L6-v2 = 384")}
          >
            <InputNumber min={1} max={4096} style={{ width: '100%' }} />
          </Form.Item>

          <Divider>{t('Text Splitting')}</Divider>

          <Space style={{ width: '100%' }} direction="vertical">
            <Space>
              <Form.Item
                name="chunkSize"
                label={t('Chunk Size')}
                rules={[{ required: true, type: 'number', min: 100 }]}
                style={{ marginBottom: 0 }}
              >
                <InputNumber min={100} max={8000} />
              </Form.Item>

              <Form.Item
                name="chunkOverlap"
                label={t('Chunk Overlap')}
                rules={[{ required: true, type: 'number', min: 0 }]}
                style={{ marginBottom: 0 }}
              >
                <InputNumber min={0} max={2000} />
              </Form.Item>

              <Form.Item
                name="batchSize"
                label={t('Batch Size')}
                rules={[{ required: true, type: 'number', min: 1 }]}
                style={{ marginBottom: 0 }}
              >
                <InputNumber min={1} max={128} />
              </Form.Item>
            </Space>
          </Space>

          <Divider />

          <Form.Item name="preferWebGPU" label={t('Prefer WebGPU')} valuePropName="checked">
            <Switch />
          </Form.Item>

          <Space>
            <Button type="primary" onClick={handleSave} loading={saving}>
              {t('Save Settings')}
            </Button>
            <Button icon={<ExperimentOutlined />} onClick={handleTestEmbedding} loading={testing}>
              {t('Test Embedding')}
            </Button>
          </Space>

          {testResult && (
            <Alert
              type="success"
              showIcon
              message={`${t('Embedding test passed')} — ${testResult.dims} ${t('Dimensions')} in ${
                testResult.timeMs
              } ms`}
              style={{ marginTop: 16 }}
            />
          )}
        </Form>
      </Card>
    </div>
  );
};
