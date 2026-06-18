import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Select, Space, Switch, Tag, message } from 'antd';
import {
  PlayCircleOutlined,
  ThunderboltOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { saveAs } from 'file-saver';
import { useApp } from '@nocobase/client-v2';
import { useCarboneTranslation } from '../locale';
import { COLLECTION, SUPPORTED_OUTPUT_FORMATS } from '../../shared/constants';
import { PlaceholderTree, PlaceholderSchemaView } from './PlaceholderTree';
import { buildSampleData } from './sample-data';

interface TemplateOption {
  id: number;
  name: string;
  defaultOutputFormat?: string;
  enabled?: boolean;
  currentVersion?: { placeholderSchema?: PlaceholderSchemaView };
}

interface RenderResult {
  blob: Blob;
  format: string;
  cache: 'HIT' | 'MISS' | 'BYPASS';
  durationMs: number;
  filename: string;
}

const PREVIEWABLE_INLINE = new Set(['pdf', 'html', 'svg', 'txt', 'csv']);
const PREVIEWABLE_IMAGE = new Set(['png', 'jpg']);

/**
 * Test playground — pick a template, generate or hand-craft input JSON, render
 * via `carboneTemplates:test` (cache bypassed by default to always exercise
 * Carbone). Result is fetched as a blob so we can preview inline (PDF/HTML/img)
 * without a round-trip via attachments.
 */
export const TestPlaygroundTab: React.FC = () => {
  const api = useApp().apiClient;
  const { t } = useCarboneTranslation();

  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [format, setFormat] = useState<string>('pdf');
  const [bypassCache, setBypassCache] = useState(true);
  const [dataText, setDataText] = useState('{\n  \n}');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const previousUrl = useRef<string | null>(null);

  const selectedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === templateId) ?? null,
    [templates, templateId],
  );

  useEffect(() => {
    api
      .resource(COLLECTION.templates)
      .list({ pageSize: 200, sort: ['name'], appends: ['currentVersion'] })
      .then((r: any) => setTemplates(r?.data?.data || []))
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (selectedTemplate?.defaultOutputFormat) setFormat(selectedTemplate.defaultOutputFormat);
  }, [selectedTemplate]);

  // Cleanup blob URL on unmount or when a new render replaces it.
  useEffect(() => {
    return () => {
      if (previousUrl.current) URL.revokeObjectURL(previousUrl.current);
    };
  }, []);

  const onGenerateSample = () => {
    const schema = selectedTemplate?.currentVersion?.placeholderSchema;
    const sample = buildSampleData(schema);
    setDataText(JSON.stringify(sample, null, 2));
  };

  const onRun = async () => {
    if (!templateId) {
      message.warning(t('Select a template first'));
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(dataText || '{}');
    } catch (err: any) {
      message.error(`${t('Invalid JSON')}: ${err?.message ?? ''}`);
      return;
    }
    setRunning(true);
    try {
      const action = bypassCache ? 'test' : 'renderById';
      const res: any = await api.request({
        url: `${COLLECTION.templates}:${action}/${templateId}`,
        method: 'post',
        data: { data: parsed, format, inline: true },
        responseType: 'blob',
      });
      const blob: Blob = res.data;
      const cacheHeader = (res.headers?.['x-carbone-cache'] || 'MISS').toUpperCase();
      const durationMs = Number(res.headers?.['x-carbone-render-ms'] || 0);
      const filename =
        filenameFromHeader(res.headers?.['content-disposition']) || `${selectedTemplate?.name ?? 'render'}.${format}`;

      if (previousUrl.current) URL.revokeObjectURL(previousUrl.current);
      const url = URL.createObjectURL(blob);
      previousUrl.current = url;

      setResult({ blob, format, cache: cacheHeader as any, durationMs, filename });
      setPreviewUrl(url);
    } catch (err: any) {
      const text = await err?.response?.data?.text?.().catch(() => null);
      const msg = (text && safeJsonMessage(text)) || err?.message || t('Render failed');
      message.error(msg);
    } finally {
      setRunning(false);
    }
  };

  const onReset = () => {
    setTemplateId(null);
    setFormat('pdf');
    setBypassCache(true);
    setDataText('{\n  \n}');
    setResult(null);
    if (previousUrl.current) URL.revokeObjectURL(previousUrl.current);
    previousUrl.current = null;
    setPreviewUrl(null);
  };

  const onDownload = () => {
    if (!result) return;
    saveAs(result.blob, result.filename);
  };

  return (
    <Row gutter={16}>
      <Col xs={24} md={12}>
        <Card size="small" title={t('Render template')}>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <div style={{ marginBottom: 4 }}>{t('Templates')}</div>
              <Select
                style={{ width: '100%' }}
                showSearch
                optionFilterProp="label"
                placeholder={t('Search by name')}
                value={templateId ?? undefined}
                onChange={setTemplateId}
                options={templates.map((tpl) => ({
                  label: tpl.enabled === false ? `${tpl.name} (${t('disabled')})` : tpl.name,
                  value: tpl.id,
                  disabled: tpl.enabled === false,
                }))}
              />
            </div>

            <Space wrap>
              <div>
                <div style={{ marginBottom: 4 }}>{t('Output format')}</div>
                <Select
                  style={{ width: 140 }}
                  value={format}
                  onChange={setFormat}
                  options={SUPPORTED_OUTPUT_FORMATS.map((f) => ({ label: f.toUpperCase(), value: f }))}
                />
              </div>
              <div>
                <div style={{ marginBottom: 4 }}>{t('Bypass cache')}</div>
                <Switch checked={bypassCache} onChange={setBypassCache} />
              </div>
              <div>
                <div style={{ marginBottom: 4 }}>&nbsp;</div>
                <Button icon={<ThunderboltOutlined />} onClick={onGenerateSample} disabled={!selectedTemplate}>
                  {t('Generate sample data')}
                </Button>
              </div>
            </Space>

            <div>
              <div style={{ marginBottom: 4 }}>{t('Render input data (JSON)')}</div>
              <textarea
                value={dataText}
                onChange={(e) => setDataText(e.target.value)}
                spellCheck={false}
                style={{
                  width: '100%',
                  minHeight: 280,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 12,
                  padding: 8,
                  border: '1px solid #d9d9d9',
                  borderRadius: 4,
                  resize: 'vertical',
                }}
              />
            </div>

            <Space>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={running}
                onClick={onRun}
                disabled={!templateId}
              >
                {t('Run')}
              </Button>
              <Button icon={<ReloadOutlined />} onClick={onReset} disabled={running}>
                {t('Reset')}
              </Button>
            </Space>

            {selectedTemplate?.currentVersion?.placeholderSchema && (
              <Card size="small" type="inner" title={t('Detected placeholders')}>
                <PlaceholderTree schema={selectedTemplate.currentVersion.placeholderSchema} />
              </Card>
            )}
          </Space>
        </Card>
      </Col>

      <Col xs={24} md={12}>
        <Card
          size="small"
          title={t('Result')}
          extra={
            result && (
              <Button size="small" icon={<DownloadOutlined />} onClick={onDownload}>
                {t('Download')}
              </Button>
            )
          }
        >
          {!result ? (
            <Empty description={t('Run a render to see the result')} />
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space wrap>
                <Tag color={cacheTagColor(result.cache)}>{t(cacheLabel(result.cache))}</Tag>
                <Tag>{result.format.toUpperCase()}</Tag>
                <Tag color="blue">
                  {t('Render duration (ms)')}: {result.durationMs}
                </Tag>
                <Tag>{(result.blob.size / 1024).toFixed(1)} KB</Tag>
              </Space>
              <ResultPreview format={result.format} url={previewUrl} />
            </Space>
          )}
        </Card>

      </Col>
    </Row>
  );
};

const ResultPreview: React.FC<{ format: string; url: string | null }> = ({ format, url }) => {
  const { t } = useCarboneTranslation();

  if (!url) return null;
  if (PREVIEWABLE_INLINE.has(format)) {
    return (
      <iframe
        title="carbone-render-preview"
        src={url}
        style={{ width: '100%', height: 540, border: '1px solid #f0f0f0', borderRadius: 4 }}
      />
    );
  }
  if (PREVIEWABLE_IMAGE.has(format)) {
    return (
      <img
        alt="carbone-render-preview"
        src={url}
        style={{ maxWidth: '100%', maxHeight: 540, border: '1px solid #f0f0f0', borderRadius: 4 }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert
        type="info"
        showIcon
        message={t('This format cannot be previewed inline. Please use the Download button to view the file.')}
      />
    </div>
  );
};

function cacheLabel(c: 'HIT' | 'MISS' | 'BYPASS'): string {
  if (c === 'HIT') return 'Cache hit';
  if (c === 'BYPASS') return 'Cache bypass';
  return 'Cache miss';
}
function cacheTagColor(c: 'HIT' | 'MISS' | 'BYPASS'): string {
  if (c === 'HIT') return 'green';
  if (c === 'BYPASS') return 'orange';
  return 'gold';
}

function filenameFromHeader(cd?: string): string | null {
  if (!cd) return null;
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function safeJsonMessage(text: string): string | null {
  try {
    const j = JSON.parse(text);
    return j?.errors?.[0]?.message || j?.message || null;
  } catch {
    return null;
  }
}

export default TestPlaygroundTab;
