import { CheckOutlined, CloseOutlined, SaveOutlined, SyncOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Empty, Input, List, Space, Spin, Splitter, Tag } from 'antd';
import React, { useEffect, useState } from 'react';
import type { VerifyAction, VerifyPayloadInput } from '../../shared/types';
import { useT } from '../locale';
import type { OcrBlockProps, OcrItem, OcrPayload, OcrSettings, OcrStatus } from '../types';
import {
  formatOcrValue,
  getOcrStatus,
  loadVerification,
  resolveVerificationInput,
  submitVerification,
} from '../verification';
import { PdfJsViewer } from './PdfJsViewer';

function VerificationSession({ input }: { input: VerifyPayloadInput }) {
  const { api } = useFlowContext();
  const t = useT();
  const { message } = App.useApp();
  const [payload, setPayload] = useState<OcrPayload>({});
  const [settings, setSettings] = useState<OcrSettings>({});
  const [items, setItems] = useState<OcrItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState('');
  const [ocrError, setOcrError] = useState<string | null>(null);
  const selected = items.find((item) => String(item.id ?? item.key) === selectedId) || items[0];
  const {
    loading,
    run: reload,
    runAsync: refresh,
    error,
  } = useRequest(() => loadVerification(api, input), {
    onSuccess: (result) => {
      setSettings(result.settings);
      setPayload(result.payload);
      setItems(result.payload.items || []);
      setStatus(result.payload.ocrStatus || 'no-ocr');
      setOcrError(result.payload.ocrError || null);
      const first = result.payload.items?.[0];
      setSelectedId(first ? String(first.id ?? first.key) : '');
    },
  });

  const { run: runPoll, cancel: cancelPoll } = useRequest(
    (): Promise<OcrStatus> =>
      payload.attachmentId == null ? Promise.resolve({}) : getOcrStatus(api, payload.attachmentId),
    {
      manual: true,
      pollingInterval: 3000,
      pollingWhenHidden: false,
      onSuccess: (result) => {
        if (!result?.status || result.status === 'pending-ocr') return;
        setStatus(result.status);
        setOcrError(result.error || null);
        refresh().catch(() => message.error(t('Failed to load OCR verify payload')));
      },
    },
  );
  useEffect(() => {
    if (payload.attachmentId != null && status === 'pending-ocr') runPoll();
    else cancelPoll();
    return cancelPoll;
  }, [payload.attachmentId, status, runPoll, cancelPoll]);

  const retry = useRequest(
    async () => {
      await api.request({
        url: 'filePreviewAuth:runOcr',
        method: 'post',
        data: { attachmentId: payload.attachmentId },
      });
      setStatus('pending-ocr');
      setOcrError(null);
      message.success(t('OCR job enqueued successfully'));
    },
    { manual: true, onError: () => message.error(t('Failed to trigger OCR')) },
  );

  const submit = useRequest(
    async (action: VerifyAction) => {
      const result = await submitVerification(api, action, input, payload.data, items);
      setPayload((previous) => ({ ...previous, data: result.data }));
      setItems(result.items || items);
      message.success(
        action === 'saveDraft' ? t('Draft saved') : t(action === 'accept' ? 'Record accepted' : 'Record rejected'),
      );
    },
    { manual: true, onError: () => message.error(t('Failed to submit OCR verification')) },
  );

  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />;
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message={t('Failed to load OCR verify payload')}
        action={<Button onClick={reload}>{t('Refresh status')}</Button>}
      />
    );
  if (status === 'pending-ocr')
    return (
      <Alert
        showIcon
        icon={<SyncOutlined spin />}
        type="info"
        message={t('Document OCR extraction in progress')}
        description={t(
          'Tesseract is parsing and extracting bounding coordinates from your document. This page will refresh automatically when processing completes.',
        )}
      />
    );
  if (status === 'failed' || (status === 'no-ocr' && !items.length))
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert
          showIcon
          type={status === 'failed' ? 'error' : 'info'}
          message={t(status === 'failed' ? 'OCR processing failed' : 'No OCR data available')}
          description={
            ocrError || t('This document has not been processed through the OCR text extraction engine yet.')
          }
        />
        <Space>
          <Button
            icon={<SyncOutlined />}
            loading={retry.loading}
            disabled={payload.attachmentId == null}
            onClick={() => retry.run()}
          >
            {t(status === 'failed' ? 'Retry OCR extraction' : 'Run OCR extraction')}
          </Button>
          <Button onClick={reload}>{t('Refresh status')}</Button>
        </Space>
      </Space>
    );

  return (
    <div style={{ minHeight: 480 }}>
      <Splitter>
        <Splitter.Panel defaultSize="38%" min="280px">
          <div style={{ paddingRight: 12 }}>
            <Space style={{ marginBottom: 12 }}>
              <Button
                icon={<SaveOutlined />}
                loading={submit.loading}
                disabled={submit.loading}
                onClick={() => submit.run('saveDraft')}
              >
                {t('Save')}
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                disabled={submit.loading}
                onClick={() => submit.run('accept')}
              >
                {t('Accept')}
              </Button>
              <Button danger icon={<CloseOutlined />} disabled={submit.loading} onClick={() => submit.run('reject')}>
                {t('Reject')}
              </Button>
            </Space>
            <List
              dataSource={items}
              locale={{ emptyText: <Empty description={t('No OCR items')} /> }}
              renderItem={(item) => {
                const id = String(item.id ?? item.key),
                  active = id === String(selected?.id ?? selected?.key);
                return (
                  <List.Item style={{ padding: 8, background: active ? '#e6f4ff' : undefined }}>
                    <div style={{ width: '100%' }}>
                      <Button type="text" aria-pressed={active} onClick={() => setSelectedId(id)}>
                        <strong>{item.key}</strong>
                      </Button>
                      {item.page != null && <Tag>{t('Page {{number}}', { number: item.page })}</Tag>}
                      {item.confidence != null && (
                        <Tag color={item.confidence < 0.8 ? 'orange' : 'green'}>
                          {Math.round(item.confidence * 100)}%
                        </Tag>
                      )}
                      <Input
                        aria-label={item.key}
                        value={formatOcrValue(item.value)}
                        disabled={submit.loading}
                        onFocus={() => setSelectedId(id)}
                        onChange={(event) =>
                          setItems((previous) =>
                            previous.map((row) =>
                              String(row.id ?? row.key) === id ? { ...row, value: event.target.value } : row,
                            ),
                          )
                        }
                      />
                    </div>
                  </List.Item>
                );
              }}
            />
          </div>
        </Splitter.Panel>
        <Splitter.Panel>
          <PdfJsViewer
            url={payload.pdfUrl}
            selected={selected}
            pdfjsCdnUrl={settings.pdfjsCdnUrl}
            pdfjsWorkerUrl={settings.pdfjsWorkerUrl}
          />
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}

export function OcrVerifyBlock(props: OcrBlockProps) {
  const context = useFlowContext();
  const t = useT();
  const input = resolveVerificationInput(props, {
    record: context.record,
    collection: context.collection,
    inputArgs: context.view?.inputArgs,
  });
  if (!input.pdfField || !input.jsonField)
    return <Alert type="warning" message={t('Configure PDF field and OCR JSON field in OCR Verify block settings')} />;
  if (input.dataSource !== 'main')
    return <Alert type="warning" message={t('OCR verification supports the main data source only')} />;
  if (!input.collection || input.recordId == null || input.recordId === '')
    return <Alert type="warning" message={t('No current record is available for this OCR Verify block')} />;
  return <VerificationSession key={JSON.stringify(input)} input={input as VerifyPayloadInput} />;
}
