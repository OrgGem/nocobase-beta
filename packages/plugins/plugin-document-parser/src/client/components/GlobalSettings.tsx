import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
  message,
} from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client';
import { useDocParserTranslation } from '../locale';

const { Text } = Typography;
const MEBIBYTE = 1024 * 1024;

type OcrConfig =
  | { kind: 'none' }
  | { kind: 'external-provider'; providerId: string | number }
  | { kind: 'llm-vision'; serviceId: string; model: string };

type Pipeline = {
  pdf: {
    enabled: boolean;
    textThreshold: { minCharacters: number };
    maxBytes: number;
    maxPages: number;
  };
  ocr: {
    enabled: boolean;
    primary: OcrConfig;
    fallback: OcrConfig;
    timeoutMs: number;
  };
  chat: { fallbackToProviderDefault: boolean };
};

type Settings = {
  pipeline: Pipeline;
  imagePassThrough: boolean;
  includedExtnames: string[];
  useDocpixie: boolean;
  enableMarkitdown: boolean;
};

type Provider = {
  id: string | number;
  title: string;
  enabled: boolean;
};

type RuntimeStatus = {
  pdfInspector?: { available?: boolean; message?: string };
  markitdown?: { available?: boolean; message?: string; command?: string; timeoutMs?: number };
};

type FormValues = {
  pdfEnabled: boolean;
  minTextCharacters: number;
  maxFileSizeMb: number;
  maxPages: number;
  ocrEnabled: boolean;
  timeoutMs: number;
  primaryKind: OcrConfig['kind'];
  primaryProviderId?: string | number;
  primaryVisionServiceId?: string;
  primaryVisionModel?: string;
  fallbackKind: OcrConfig['kind'];
  fallbackProviderId?: string | number;
  fallbackVisionServiceId?: string;
  fallbackVisionModel?: string;
  fallbackToProviderDefault: boolean;
  imagePassThrough: boolean;
  includedExtnames: string[];
  useDocpixie: boolean;
  enableMarkitdown: boolean;
};

const DEFAULT_PIPELINE: Pipeline = {
  pdf: { enabled: true, textThreshold: { minCharacters: 200 }, maxBytes: 50 * MEBIBYTE, maxPages: 20 },
  ocr: { enabled: true, primary: { kind: 'none' }, fallback: { kind: 'none' }, timeoutMs: 60_000 },
  chat: { fallbackToProviderDefault: true },
};

export const GlobalSettings: React.FC = () => {
  const { t } = useDocParserTranslation();
  const api = useApp().apiClient;
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [runtime, setRuntime] = useState<RuntimeStatus>({});
  const [checkingEngine, setCheckingEngine] = useState<string>();
  const primaryKind = Form.useWatch('primaryKind', form);
  const fallbackKind = Form.useWatch('fallbackKind', form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResponse, providersResponse, runtimeResponse] = await Promise.all([
        api.request({ url: 'docParserSettings:get' }),
        api.request({ url: 'docParserProviders:list', params: { pageSize: 200 } }),
        api.request({ url: 'docParser:getRuntime' }),
      ]);
      const settings = unwrapData<Settings>(settingsResponse, {
        pipeline: DEFAULT_PIPELINE,
        imagePassThrough: true,
        includedExtnames: [],
        useDocpixie: false,
        enableMarkitdown: true,
      });
      form.setFieldsValue(toFormValues(settings));
      setProviders(unwrapData<Provider[]>(providersResponse, []));
      setRuntime(unwrapData<RuntimeStatus>(runtimeResponse, {}));
    } catch (error) {
      message.error(errorMessage(error, t));
    } finally {
      setLoading(false);
    }
  }, [api, form, t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await api.request({
        url: 'docParserSettings:save',
        method: 'POST',
        data: {
          imagePassThrough: values.imagePassThrough,
          includedExtnames: values.includedExtnames,
          useDocpixie: values.useDocpixie,
          enableMarkitdown: values.enableMarkitdown,
          pipeline: toPipeline(values),
        },
      });
      message.success(t('Settings saved'));
    } catch (error) {
      message.error(errorMessage(error, t));
    } finally {
      setSaving(false);
    }
  };

  const checkEngine = async (engine: 'pdf-inspector' | 'markitdown') => {
    setCheckingEngine(engine);
    try {
      const response = await api.request({ url: 'docParser:checkEngine', method: 'POST', data: { engine } });
      const status = unwrapData<{ available?: boolean; message?: string }>(response, {});
      setRuntime((current) =>
        engine === 'pdf-inspector'
          ? { ...current, pdfInspector: status }
          : { ...current, markitdown: { ...current.markitdown, ...status } },
      );
      message.success(status.available ? t('Engine is available') : t('Engine is unavailable'));
    } catch (error) {
      message.error(errorMessage(error, t));
    } finally {
      setCheckingEngine(undefined);
    }
  };

  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />;

  const providerOptions = providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({ label: provider.title, value: provider.id }));

  return (
    <Card bordered={false} style={{ maxWidth: 860 }}>
      <Alert
        showIcon
        type="info"
        message={t('Canonical parsing pipeline')}
        description={t(
          'PDFs use PDF Inspector before the configured OCR route. Other supported documents use specialized parsers and MarkItDown.',
        )}
        style={{ marginBottom: 24 }}
      />
      <Form form={form} layout="vertical">
        <Card title={t('PDF & OCR')}>
          <Form.Item name="pdfEnabled" label={t('Enable PDF Inspector')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="minTextCharacters"
            label={t('Minimum extracted characters')}
            extra={t('PDF Inspector output below this threshold continues to OCR.')}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} precision={0} style={{ width: 220 }} />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item name="maxFileSizeMb" label={t('PDF max size (MiB)')} rules={[{ required: true }]}>
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item name="maxPages" label={t('PDF maximum pages')} rules={[{ required: true }]}>
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item name="timeoutMs" label={t('OCR timeout (ms)')} rules={[{ required: true }]}>
              <InputNumber min={1000} precision={0} />
            </Form.Item>
          </Space>
          <Divider />
          <Form.Item name="ocrEnabled" label={t('Enable OCR')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <OcrRouteFields
            prefix="primary"
            kind={primaryKind}
            providerOptions={providerOptions}
            form={form}
            t={t}
            label={t('Primary OCR route')}
          />
          <OcrRouteFields
            prefix="fallback"
            kind={fallbackKind}
            providerOptions={providerOptions}
            form={form}
            t={t}
            label={t('Fallback OCR route')}
          />
        </Card>
        <Card title={t('Engines & diagnostics')} style={{ marginTop: 16 }}>
          <DiagnosticRow
            title={t('PDF Inspector')}
            status={runtime.pdfInspector}
            loading={checkingEngine === 'pdf-inspector'}
            onCheck={() => checkEngine('pdf-inspector')}
            t={t}
          />
          <Divider />
          <DiagnosticRow
            title={t('MarkItDown')}
            status={runtime.markitdown}
            loading={checkingEngine === 'markitdown'}
            onCheck={() => checkEngine('markitdown')}
            t={t}
          />
          {runtime.markitdown?.command ? (
            <Text type="secondary">{`${t('Command')}: ${runtime.markitdown.command}; ${t('Timeout (ms)')}: ${
              runtime.markitdown.timeoutMs ?? '-'
            }`}</Text>
          ) : null}
        </Card>
        <Card title={t('Chat & compatibility')} style={{ marginTop: 16 }}>
          <Form.Item
            name="fallbackToProviderDefault"
            label={t('Fallback to default on error')}
            extra={t(
              'This fallback applies to AI chat only; File Search stops after configured document parsers and OCR.',
            )}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="imagePassThrough" label={t('Pass images through to default')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="useDocpixie" label={t('Index with DocPixie (when available)')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="enableMarkitdown" label={t('Enable MarkItDown Parser')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="includedExtnames"
            label={t('Included File Extensions')}
            extra={t('Only process files with these extensions. Leave empty to process all non-image file types.')}
          >
            <Select mode="tags" tokenSeparators={[',', ' ']} placeholder=".pdf, .docx, .xlsx, .pptx" />
          </Form.Item>
        </Card>
        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} style={{ marginTop: 16 }}>
          {t('Save')}
        </Button>
      </Form>
    </Card>
  );
};

type OcrRouteFieldsProps = {
  prefix: 'primary' | 'fallback';
  kind: OcrConfig['kind'] | undefined;
  providerOptions: Array<{ label: string; value: string | number }>;
  form: ReturnType<typeof Form.useForm<FormValues>>[0];
  t: (key: string) => string;
  label: string;
};

function OcrRouteFields({ prefix, kind, providerOptions, form, t, label }: OcrRouteFieldsProps) {
  const capitalized = prefix[0].toUpperCase() + prefix.slice(1);
  const kindField = `${prefix}Kind` as keyof FormValues;
  return (
    <>
      <Form.Item name={kindField} label={label}>
        <Select
          options={[
            { label: t('No OCR route'), value: 'none' },
            { label: t('External OCR provider'), value: 'external-provider' },
            { label: t('LLM Vision OCR'), value: 'llm-vision' },
          ]}
          style={{ maxWidth: 420 }}
          onChange={() => form.validateFields()}
        />
      </Form.Item>
      {kind === 'external-provider' ? (
        <Form.Item
          name={`${prefix}ProviderId` as keyof FormValues}
          label={t(`${capitalized} external OCR provider`)}
          rules={[{ required: true, message: t('Please select a provider') }]}
        >
          <Select options={providerOptions} placeholder={t('Please select a provider')} style={{ maxWidth: 420 }} />
        </Form.Item>
      ) : null}
      {kind === 'llm-vision' ? (
        <Space size="large" wrap>
          <Form.Item
            name={`${prefix}VisionServiceId` as keyof FormValues}
            label={t('Vision service ID')}
            rules={[{ required: true, message: t('Vision service ID is required') }]}
          >
            <Input style={{ width: 280 }} />
          </Form.Item>
          <Form.Item
            name={`${prefix}VisionModel` as keyof FormValues}
            label={t('Vision model')}
            rules={[{ required: true, message: t('Vision model is required') }]}
          >
            <Input style={{ width: 280 }} />
          </Form.Item>
        </Space>
      ) : null}
    </>
  );
}

function DiagnosticRow({
  title,
  status,
  loading,
  onCheck,
  t,
}: {
  title: string;
  status?: { available?: boolean; message?: string };
  loading: boolean;
  onCheck: () => void;
  t: (key: string) => string;
}) {
  return (
    <Space direction="vertical">
      <Space>
        <Text strong>{title}</Text>
        <Text type={status?.available === false ? 'danger' : 'secondary'}>
          {status?.available === undefined ? t('Not checked') : status.available ? t('Available') : t('Unavailable')}
        </Text>
        <Button size="small" loading={loading} onClick={onCheck}>
          {t('Check')}
        </Button>
      </Space>
      {status?.message ? <Text type="secondary">{status.message}</Text> : null}
    </Space>
  );
}

function toFormValues(settings: Settings): FormValues {
  const pipeline = settings.pipeline ?? DEFAULT_PIPELINE;
  return {
    pdfEnabled: pipeline.pdf.enabled,
    minTextCharacters: pipeline.pdf.textThreshold.minCharacters,
    maxFileSizeMb: Math.max(1, Math.ceil(pipeline.pdf.maxBytes / MEBIBYTE)),
    maxPages: pipeline.pdf.maxPages,
    ocrEnabled: pipeline.ocr.enabled,
    timeoutMs: pipeline.ocr.timeoutMs,
    ...toRouteValues('primary', pipeline.ocr.primary),
    ...toRouteValues('fallback', pipeline.ocr.fallback),
    fallbackToProviderDefault: pipeline.chat.fallbackToProviderDefault,
    imagePassThrough: settings.imagePassThrough,
    includedExtnames: settings.includedExtnames,
    useDocpixie: settings.useDocpixie,
    enableMarkitdown: settings.enableMarkitdown,
  };
}

function toRouteValues(prefix: 'primary' | 'fallback', config: OcrConfig): Partial<FormValues> {
  if (config.kind === 'external-provider')
    return { [`${prefix}Kind`]: config.kind, [`${prefix}ProviderId`]: config.providerId } as Partial<FormValues>;
  if (config.kind === 'llm-vision')
    return {
      [`${prefix}Kind`]: config.kind,
      [`${prefix}VisionServiceId`]: config.serviceId,
      [`${prefix}VisionModel`]: config.model,
    } as Partial<FormValues>;
  return { [`${prefix}Kind`]: 'none' } as Partial<FormValues>;
}

function toPipeline(values: FormValues): Pipeline {
  return {
    pdf: {
      enabled: values.pdfEnabled,
      textThreshold: { minCharacters: values.minTextCharacters },
      maxBytes: values.maxFileSizeMb * MEBIBYTE,
      maxPages: values.maxPages,
    },
    ocr: {
      enabled: values.ocrEnabled,
      primary: toRouteConfig('primary', values),
      fallback: toRouteConfig('fallback', values),
      timeoutMs: values.timeoutMs,
    },
    chat: { fallbackToProviderDefault: values.fallbackToProviderDefault },
  };
}

function toRouteConfig(prefix: 'primary' | 'fallback', values: FormValues): OcrConfig {
  const kind = values[`${prefix}Kind`];
  if (kind === 'external-provider') return { kind, providerId: values[`${prefix}ProviderId`] as string | number };
  if (kind === 'llm-vision')
    return { kind, serviceId: values[`${prefix}VisionServiceId`] ?? '', model: values[`${prefix}VisionModel`] ?? '' };
  return { kind: 'none' };
}

function unwrapData<T>(response: unknown, fallback: T): T {
  if (!isRecord(response) || !isRecord(response.data) || !('data' in response.data)) return fallback;
  return (response.data.data as T | undefined) ?? fallback;
}

function errorMessage(error: unknown, t: (key: string) => string): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : t('Request failed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
