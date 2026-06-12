import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, List, Space, Splitter, Tag, message, Typography, Spin } from 'antd';
import { CheckOutlined, CloseOutlined, SaveOutlined, SyncOutlined } from '@ant-design/icons';
import { useAPIClient, useRecord, useCollection_deprecated } from '@nocobase/client';
import { NormalizedOcrItem } from '../../shared/types';
import { PdfJsViewer } from '../components/PdfJsViewer';
import { useT } from '../locale';

const { Text, Title } = Typography;

type Props = {
  children?: React.ReactNode;
  sourceMode?: 'currentRecord' | 'manualRecord';
  collection?: string;
  recordId?: string | number;
  pdfField?: string;
  jsonField?: string;
  statusField?: string;
  categoryId?: string | number;
  categoryName?: string;
  mappingProfileName?: string;
};

export const OcrVerifyBlock = (props: Props) => {
  const api = useAPIClient();
  const t = useT();
  const record = useRecord<any>();
  const collection = useCollection_deprecated?.();
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<any>(null);
  const [items, setItems] = useState<NormalizedOcrItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [settings, setSettings] = useState<any>({});

  const [ocrStatus, setOcrStatus] = useState<string>('no-ocr');
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [pollingLoading, setPollingLoading] = useState(false);

  const collectionName = props.collection || collection?.name || record?.__collectionName;
  const recordId = props.recordId || record?.id;
  const selected = useMemo(
    () => items.find((item) => String(item.id || item.key) === selectedId) || items[0] || null,
    [items, selectedId],
  );

  const requestBase = useMemo(
    () => ({
      collection: collectionName,
      recordId,
      pdfField: props.pdfField,
      jsonField: props.jsonField,
      statusField: props.statusField,
      categoryId: props.categoryId,
      categoryName: props.categoryName,
      mappingProfileName: props.mappingProfileName || 'default',
    }),
    [
      collectionName,
      props.categoryId,
      props.categoryName,
      props.jsonField,
      props.mappingProfileName,
      props.pdfField,
      props.statusField,
      recordId,
    ],
  );

  const refresh = useCallback(async () => {
    if (!collectionName || !recordId || !props.pdfField || !props.jsonField) return;
    setLoading(true);
    try {
      const [settingsRes, payloadRes] = await Promise.all([
        api.resource('ocrVerifySettings').get(),
        api.resource('ocrVerify').getPayload({ values: requestBase }),
      ]);
      setSettings(settingsRes?.data?.data || settingsRes?.data || {});
      const data = payloadRes?.data?.data || payloadRes?.data;
      setPayload(data);
      setItems(data?.items || []);
      setOcrStatus(data?.ocrStatus || 'no-ocr');
      setOcrError(data?.ocrError || null);
      setSelectedId((data?.items?.[0]?.id || data?.items?.[0]?.key || '') as string);
    } catch (err: any) {
      message.error(err?.message || t('Failed to load OCR verify payload'));
    } finally {
      setLoading(false);
    }
  }, [api, collectionName, props.jsonField, props.pdfField, recordId, requestBase, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const attachmentId = payload?.attachmentId;

  useEffect(() => {
    if (!attachmentId || ocrStatus !== 'pending-ocr') {
      setIsPolling(false);
      return;
    }

    setIsPolling(true);

    const poll = async () => {
      try {
        const res = await api.resource('filePreviewAuth').getOcrStatus({
          params: { attachmentId },
        });
        const status = res?.data?.data?.status || 'no-ocr';
        const error = res?.data?.data?.error || null;
        if (status !== 'pending-ocr') {
          setIsPolling(false);
          setOcrStatus(status);
          setOcrError(error);
          message.success(t('OCR extraction complete. Reloading...'));
          refresh();
        }
      } catch (err: any) {
        // Keep polling resilient while the OCR worker is restarting or busy.
      }
    };

    const timer = setInterval(poll, 3000);

    return () => {
      clearInterval(timer);
    };
  }, [api, attachmentId, ocrStatus, refresh, t]);

  const handleRetryOcr = async () => {
    if (!attachmentId) return;
    setPollingLoading(true);
    try {
      await api.resource('filePreviewAuth').runOcr({
        values: { attachmentId },
      });
      message.success(t('OCR job enqueued successfully'));
      setOcrStatus('pending-ocr');
      setOcrError(null);
    } catch (err: any) {
      message.error(err?.message || t('Failed to trigger OCR'));
    } finally {
      setPollingLoading(false);
    }
  };

  const updateItem = (target: NormalizedOcrItem, value: string) => {
    setItems((prev) =>
      prev.map((item) => (String(item.id || item.key) === String(target.id || target.key) ? { ...item, value } : item)),
    );
  };

  const submit = async (action: 'saveDraft' | 'accept' | 'reject') => {
    setLoading(true);
    try {
      const body = {
        ...requestBase,
        data: payload?.data,
        items,
      };
      const res = await api.resource('ocrVerify')[action]({ values: body });
      const data = res?.data?.data || res?.data;
      setPayload((prev) => ({ ...prev, data: data?.data }));
      setItems(data?.items || items);
      message.success(
        action === 'saveDraft' ? t('Draft saved') : t(action === 'accept' ? 'Record accepted' : 'Record rejected'),
      );
    } catch (err: any) {
      message.error(err?.message || t('Failed to submit OCR verification'));
    } finally {
      setLoading(false);
    }
  };

  if (!props.pdfField || !props.jsonField) {
    return <Alert type="warning" message={t('Configure PDF field and OCR JSON field in OCR Verify block settings')} />;
  }

  if (!collectionName || !recordId) {
    return <Alert type="warning" message={t('No current record is available for this OCR Verify block')} />;
  }

  if (isPolling) {
    return (
      <div
        style={{
          padding: '64px 32px',
          textAlign: 'center',
          background: '#fff',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
          border: '1px solid #f0f0f0',
        }}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Spin indicator={<SyncOutlined spin style={{ fontSize: 48, color: '#1890ff' }} />} />
          <Title level={4} style={{ margin: '16px 0 8px' }}>
            {t('Document OCR extraction in progress')}
          </Title>
          <Text type="secondary" style={{ maxWidth: '500px', display: 'inline-block' }}>
            {t(
              'Tesseract is parsing and extracting bounding coordinates from your document. This page will refresh automatically when processing completes.',
            )}
          </Text>
        </Space>
      </div>
    );
  }

  if (ocrStatus === 'failed') {
    return (
      <div
        style={{
          padding: '32px',
          background: '#fff',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
          border: '1px solid #f0f0f0',
        }}
      >
        <Alert
          type="error"
          showIcon
          message={t('OCR processing failed')}
          description={ocrError || t('An unexpected error occurred during OCR text extraction.')}
          style={{ marginBottom: 24 }}
        />
        <Space>
          <Button type="primary" icon={<SyncOutlined />} loading={pollingLoading} onClick={handleRetryOcr}>
            {t('Retry OCR extraction')}
          </Button>
          <Button onClick={refresh}>{t('Refresh status')}</Button>
        </Space>
      </div>
    );
  }

  if (ocrStatus === 'no-ocr' && !items.length) {
    return (
      <div
        style={{
          padding: '32px',
          background: '#fff',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
          border: '1px solid #f0f0f0',
        }}
      >
        <Alert
          type="info"
          showIcon
          message={t('No OCR data available')}
          description={t('This document has not been processed through the OCR text extraction engine yet.')}
          style={{ marginBottom: 24 }}
        />
        <Space>
          <Button type="primary" icon={<SyncOutlined />} loading={pollingLoading} onClick={handleRetryOcr}>
            {t('Run OCR extraction')}
          </Button>
          <Button onClick={refresh}>{t('Refresh status')}</Button>
        </Space>
      </div>
    );
  }

  return (
    <div style={{ minHeight: 480 }}>
      <Splitter>
        <Splitter.Panel defaultSize="38%" min="280px">
          <div style={{ paddingRight: 12 }}>
            <Space style={{ marginBottom: 12 }}>
              <Button icon={<SaveOutlined />} loading={loading} onClick={() => submit('saveDraft')}>
                {t('Save')}
              </Button>
              <Button type="primary" icon={<CheckOutlined />} loading={loading} onClick={() => submit('accept')}>
                {t('Accept')}
              </Button>
              <Button danger icon={<CloseOutlined />} loading={loading} onClick={() => submit('reject')}>
                {t('Reject')}
              </Button>
            </Space>
            <List
              loading={loading}
              dataSource={items}
              locale={{ emptyText: <Empty description={t('No OCR items')} /> }}
              renderItem={(item) => {
                const id = String(item.id || item.key);
                const active = id === String(selected?.id || selected?.key);
                return (
                  <List.Item
                    style={{
                      cursor: 'pointer',
                      padding: 8,
                      background: active ? '#e6f4ff' : undefined,
                      borderRadius: 6,
                    }}
                    onClick={() => setSelectedId(id)}
                  >
                    <div style={{ width: '100%' }}>
                      <Space style={{ marginBottom: 6 }}>
                        <strong>{item.key}</strong>
                        {item.page && <Tag>p.{item.page}</Tag>}
                        {item.confidence != null && (
                          <Tag color={item.confidence < 0.8 ? 'orange' : 'green'}>
                            {Math.round(item.confidence * 100)}%
                          </Tag>
                        )}
                      </Space>
                      <Input value={item.value} onChange={(event) => updateItem(item, event.target.value)} />
                    </div>
                  </List.Item>
                );
              }}
            />
          </div>
        </Splitter.Panel>
        <Splitter.Panel>
          <PdfJsViewer
            url={payload?.pdfUrl}
            selected={selected}
            pdfjsCdnUrl={settings.pdfjsCdnUrl}
            pdfjsWorkerUrl={settings.pdfjsWorkerUrl}
          />
        </Splitter.Panel>
      </Splitter>
    </div>
  );
};
