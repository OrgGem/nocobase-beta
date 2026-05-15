/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAPIClient } from '@nocobase/client';
import { useTranslation } from 'react-i18next';
import {
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Button,
  Card,
  Space,
  Typography,
  Divider,
  Alert,
  App,
  Spin,
  Tag,
  List,
  Collapse,
} from 'antd';
import {
  ThunderboltOutlined,
  ExperimentOutlined,
  CloudDownloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudServerOutlined,
  GlobalOutlined,
} from '@ant-design/icons';
import { mainDataSourceRequest, MAIN_DATA_SOURCE_HEADERS } from '../api';

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
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [configData, setConfigData] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ dims: number; timeMs: number } | null>(null);
  const [webGPUAvailable, setWebGPUAvailable] = useState<boolean | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [storageMode, setStorageMode] = useState<'local' | 's3'>('local');
  const [modelSource, setModelSource] = useState<'server' | 'cdn' | 'huggingface'>('server');
  const [installedModels, setInstalledModels] = useState<any[]>([]);
  const [s3Storages, setS3Storages] = useState<any[]>([]);

  // Check WebGPU availability
  useEffect(() => {
    setWebGPUAvailable(!!(navigator as any).gpu);
  }, []);

  const fetchModelStatus = useCallback(async () => {
    try {
      const res = await api.request(mainDataSourceRequest({ url: 'embedWebClient:getModelStatus' }));
      setModelStatus(res?.data?.data ?? res?.data ?? null);
    } catch {
      // non-fatal
    }
    try {
      const resModels = await api.request(mainDataSourceRequest({ url: 'embedWebClient:listModels' }));
      let arr = resModels?.data?.data ?? resModels?.data;
      if (arr && !Array.isArray(arr) && Array.isArray(arr.data)) arr = arr.data;
      setInstalledModels(Array.isArray(arr) ? arr : []);
    } catch {
      // non-fatal
    }
  }, [api]);

  useEffect(() => {
    // eslint-disable-next-line promise/catch-or-return
    api
      .request(mainDataSourceRequest({ url: 'embedWebClient:getConfig' }))
      .then((res) => {
        const data = res?.data?.data ?? res?.data ?? {};
        // Normalize modelId to array for tags Select
        if (data.modelId && !Array.isArray(data.modelId)) {
          data.modelId = [data.modelId];
        } else if (!data.modelId) {
          data.modelId = [];
        }
        data.modelSource = 'server';
        setConfigData(data);
        form.setFieldsValue(data);
        setStorageMode(data.storageMode ?? 'local');
        setModelSource('server');
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    fetchModelStatus().catch(() => {});

    api
      .resource('storages', undefined, MAIN_DATA_SOURCE_HEADERS)
      .list({ pageSize: 200, fields: ['id', 'title', 'name', 'type'] })
      .then((res: any) => {
        const arr = res?.data?.data ?? res?.data ?? [];
        setS3Storages(Array.isArray(arr) ? arr.filter((s) => ['s3', 's3-private'].includes(s.type)) : []);
      })
      .catch(() => setS3Storages([]));
  }, [api, form, fetchModelStatus]);

  const handleSave = async () => {
    const values = await form.validateFields();
    // Normalize modelId from tags array back to string for the API
    const submitValues = { ...values };
    if (Array.isArray(submitValues.modelId)) {
      submitValues.modelId = submitValues.modelId[0] ?? '';
    }
    submitValues.modelSource = 'server';
    setSaving(true);
    try {
      const res = await api.request(
        mainDataSourceRequest({
          url: 'embedWebClient:updateConfig',
          method: 'post',
          data: submitValues,
        }),
      );
      // Sync local state with the server response so the form doesn't "reset"
      const saved = res?.data?.data ?? res?.data ?? {};
      if (saved.modelId && !Array.isArray(saved.modelId)) {
        saved.modelId = [saved.modelId];
      } else if (!saved.modelId) {
        saved.modelId = [];
      }
      saved.modelSource = 'server';
      setConfigData(saved);
      form.setFieldsValue(saved);
      setStorageMode(saved.storageMode ?? 'local');
      setModelSource('server');
      message.success(t('Settings saved'));
      // Refresh model status — model may have changed
      await fetchModelStatus();
    } catch {
      message.error(t('Failed to save settings'));
    } finally {
      setSaving(false);
    }
  };

  const handleTestEmbedding = async () => {
    const values = form.getFieldsValue();
    setTesting(true);
    setTestResult(null);
    try {
      // Dynamically import and run in-browser for a quick test
      const { pipeline, env } = await import('@huggingface/transformers' as any);
      const t0 = Date.now();
      let device = 'wasm';
      if (values.preferWebGPU && (navigator as any).gpu) {
        try {
          const adapter = await (navigator as any).gpu.requestAdapter();
          if (adapter) device = 'webgpu';
        } catch {
          // WebGPU not available on this platform, fall back to wasm
        }
      }

      const origin = window.location.origin;
      env.remoteHost = `${origin}/`;
      env.remotePathTemplate = 'embed-web-client/models/{model}/';
      env.allowRemoteModels = true;
      env.allowLocalModels = false;

      const testModelId = Array.isArray(values.modelId) ? values.modelId[0] : values.modelId;
      if (!testModelId) {
        message.warning(t('Select a model first'));
        return;
      }

      try {
        const checkRes = await fetch(`${window.location.origin}/embed-web-client/models/${testModelId}/config.json`, {
          method: 'HEAD',
        });
        if (!checkRes.ok) {
          message.error(
            t(
              'Model files not found on server. Select the bundled model or upload the required ONNX files in the Models tab.',
            ),
          );
          return;
        }
      } catch {
        message.error(t('Cannot reach model server. Check that the server is running.'));
        return;
      }

      const pipeOptions: any = {
        dtype: values.dtype,
        device,
        // Bypass transformers.js cache to ensure fresh model files are loaded
        cache_dir: false,
      };
      const pipe = await pipeline('feature-extraction', testModelId, pipeOptions);
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

      {/* ── Model file status (offline readiness) — only relevant for server mode ── */}
      {modelSource === 'server' && (
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
          extra={null}
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            {t(
              'Model files are served from this NocoBase server. The bundled MiniLM model works without internet; upload additional ONNX files in the Models tab when needed.',
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
      )}

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
        <Form form={form} layout="vertical" initialValues={configData ?? {}}>
          <Form.Item
            name="modelId"
            label={t('Embedding Model')}
            rules={[{ required: true }]}
            extra={t('Must match a bundled or uploaded ONNX feature-extraction model')}
          >
            <Select
              options={[
                ...MODEL_PRESETS,
                ...installedModels
                  .filter((m) => !MODEL_PRESETS.some((p) => p.value === m.modelId))
                  .map((m) => ({
                    label: `${m.modelId} (${m.source}${m.dimensions ? `, ${m.dimensions}-dim` : ''})`,
                    value: m.modelId,
                  })),
              ]}
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

          {/* ── Model Source ───────────────────────────────────────────────── */}
          <Form.Item
            hidden
            name="modelSource"
            initialValue="server"
            label={t('Model Source')}
            extra={t(
              "'Server' serves files from this NocoBase instance (offline-ready). 'CDN' fetches from a public CDN URL — no server download needed. 'HuggingFace' fetches directly from HuggingFace Hub.",
            )}
          >
            <Select
              options={[
                { label: t('Server (local / S3 — offline ready)'), value: 'server' },
                { label: t('CDN (public URL configured below)'), value: 'cdn' },
                { label: t('HuggingFace Hub (direct internet)'), value: 'huggingface' },
              ]}
              onChange={(v) => setModelSource(v)}
            />
          </Form.Item>

          {modelSource === 'cdn' && (
            <Collapse
              defaultActiveKey={['cdn']}
              style={{ marginBottom: 16 }}
              items={[
                {
                  key: 'cdn',
                  label: (
                    <Space>
                      <GlobalOutlined />
                      <span>{t('CDN Configuration')}</span>
                    </Space>
                  ),
                  children: (
                    <Space direction="vertical" style={{ width: '100%' }} size={0}>
                      <Alert
                        type="info"
                        showIcon
                        message={t(
                          'Enter the full URL of the CDN folder that contains the model files (config.json, tokenizer.json, model.onnx, …). The URL must point to the model directory, not an individual file.',
                        )}
                        style={{ marginBottom: 16 }}
                      />
                      <Form.Item
                        name="cdnBaseUrl"
                        label={t('CDN Model URL')}
                        rules={[
                          { required: modelSource === 'cdn', message: t('CDN URL is required when using CDN source') },
                          {
                            type: 'url',
                            message: t('Must be a valid URL starting with https://'),
                          },
                        ]}
                        extra={
                          <span>
                            {t('Example')}:{' '}
                            <code>
                              https://cdn.jsdelivr.net/npm/@alvix/all-minilm-l6-v2@1.0.1/dist/Xenova/all-MiniLM-L6-v2
                            </code>
                          </span>
                        }
                      >
                        <Input placeholder="https://cdn.jsdelivr.net/npm/@scope/pkg@version/dist/Org/ModelName" />
                      </Form.Item>
                      <Form.Item
                        name="cdnModelFileName"
                        label={t('Custom Model File Name')}
                        extra={
                          <span>
                            {t(
                              "Leave empty for default. Enter 'model' to force fetching 'model.onnx' (instead of model_quantized.onnx) from the CDN.",
                            )}
                          </span>
                        }
                      >
                        <Input placeholder="model" />
                      </Form.Item>
                      <Alert
                        type="warning"
                        showIcon
                        message={t(
                          "The CDN package must contain all required model files (config.json, tokenizer.json, model.onnx or model_quantized.onnx). Make sure the CDN URL matches the model ID configured in 'Embedding Model' above.",
                        )}
                        style={{ marginBottom: 8 }}
                      />
                    </Space>
                  ),
                },
              ]}
            />
          )}

          {modelSource === 'huggingface' && (
            <Alert
              type="warning"
              showIcon
              message={t('HuggingFace Hub')}
              description={t(
                'Model files will be fetched directly from huggingface.co on first use and cached in the browser (IndexedDB). Requires internet access from the browser. No server download needed.',
              )}
              style={{ marginBottom: 16 }}
            />
          )}

          {/* ── S3 Storage — only relevant when server is the model source ─── */}
          {modelSource === 'server' && (
            <>
              <Divider>{t('Model Storage')}</Divider>

              <Form.Item
                name="storageMode"
                label={t('Storage Mode')}
                extra={t(
                  "'local' saves model files on the NocoBase server disk. 's3' uploads them to a File Manager S3 storage.",
                )}
              >
                <Select
                  options={[
                    { label: t('Local disk (default)'), value: 'local' },
                    { label: t('S3 / object storage'), value: 's3' },
                  ]}
                  onChange={(v) => setStorageMode(v)}
                />
              </Form.Item>

              {storageMode === 's3' && (
                <Collapse
                  defaultActiveKey={['s3']}
                  items={[
                    {
                      key: 's3',
                      label: (
                        <Space>
                          <CloudServerOutlined />
                          <span>{t('S3 Configuration')}</span>
                        </Space>
                      ),
                      children: (
                        <Space direction="vertical" style={{ width: '100%' }} size={0}>
                          <Alert
                            type="info"
                            showIcon
                            message={t(
                              'Select an S3 storage configured in File Manager. Credentials are not duplicated in this plugin.',
                            )}
                            style={{ marginBottom: 16 }}
                          />
                          <Form.Item
                            name="s3StorageId"
                            label={t('File Manager S3 Storage')}
                            rules={[{ required: storageMode === 's3', message: t('S3 storage is required') }]}
                          >
                            <Select
                              showSearch
                              optionFilterProp="label"
                              placeholder={t('Select a File Manager S3 storage')}
                              options={s3Storages.map((s) => ({
                                label: `${s.title || s.name} (${s.name}, ${s.type})`,
                                value: s.id,
                              }))}
                            />
                          </Form.Item>
                          <Form.Item
                            name="s3KeyPrefix"
                            label={t('Key Prefix')}
                            extra={t("Folder prefix inside the selected bucket. Defaults to 'embed-web-client'.")}
                          >
                            <Input placeholder="embed-web-client" />
                          </Form.Item>
                        </Space>
                      ),
                    },
                  ]}
                />
              )}
            </>
          )}

          <Divider />

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
