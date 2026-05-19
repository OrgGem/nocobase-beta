import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, List, Space, Splitter, Tag, message } from 'antd';
import { CheckOutlined, CloseOutlined, SaveOutlined } from '@ant-design/icons';
import { useAPIClient, useRecord, useCollection_deprecated } from '@nocobase/client';
import { NormalizedOcrItem } from '../../shared/types';
import { PdfJsViewer } from '../components/PdfJsViewer';

type Props = {
  sourceMode?: 'currentRecord' | 'manualRecord';
  collection?: string;
  recordId?: string | number;
  pdfField?: string;
  jsonField?: string;
  statusField?: string;
  mappingProfileName?: string;
};

export const OcrVerifyBlock = (props: Props) => {
  const api = useAPIClient();
  const record = useRecord<any>();
  const collection = useCollection_deprecated?.();
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<any>(null);
  const [items, setItems] = useState<NormalizedOcrItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [settings, setSettings] = useState<any>({});

  const collectionName = props.collection || collection?.name || record?.__collectionName;
  const recordId = props.recordId || record?.id;
  const selected = useMemo(
    () => items.find((item) => String(item.id || item.key) === selectedId) || items[0] || null,
    [items, selectedId],
  );

  const requestBase = {
    collection: collectionName,
    recordId,
    pdfField: props.pdfField,
    jsonField: props.jsonField,
    statusField: props.statusField,
    mappingProfileName: props.mappingProfileName || 'default',
  };

  async function refresh() {
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
      setSelectedId((data?.items?.[0]?.id || data?.items?.[0]?.key || '') as string);
    } catch (err: any) {
      message.error(err?.message || 'Failed to load OCR verify payload');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [collectionName, recordId, props.pdfField, props.jsonField, props.statusField, props.mappingProfileName]);

  const updateItem = (target: NormalizedOcrItem, value: string) => {
    setItems((prev) => prev.map((item) => (String(item.id || item.key) === String(target.id || target.key) ? { ...item, value } : item)));
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
      message.success(action === 'saveDraft' ? 'Draft saved' : `Record ${action === 'accept' ? 'accepted' : 'rejected'}`);
    } catch (err: any) {
      message.error(err?.message || `Failed to ${action}`);
    } finally {
      setLoading(false);
    }
  };

  if (!props.pdfField || !props.jsonField) {
    return <Alert type="warning" message="Configure pdfField and jsonField in OCR Verify block settings" />;
  }

  if (!collectionName || !recordId) {
    return <Alert type="warning" message="No current record is available for this OCR Verify block" />;
  }

  return (
    <div style={{ minHeight: 480 }}>
      <Splitter>
        <Splitter.Panel defaultSize="38%" min="280px">
          <div style={{ paddingRight: 12 }}>
            <Space style={{ marginBottom: 12 }}>
              <Button icon={<SaveOutlined />} loading={loading} onClick={() => submit('saveDraft')}>
                Save
              </Button>
              <Button type="primary" icon={<CheckOutlined />} loading={loading} onClick={() => submit('accept')}>
                Accept
              </Button>
              <Button danger icon={<CloseOutlined />} loading={loading} onClick={() => submit('reject')}>
                Reject
              </Button>
            </Space>
            <List
              loading={loading}
              dataSource={items}
              locale={{ emptyText: <Empty description="No OCR items" /> }}
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
                        {item.confidence != null && <Tag color={item.confidence < 0.8 ? 'orange' : 'green'}>{Math.round(item.confidence * 100)}%</Tag>}
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
