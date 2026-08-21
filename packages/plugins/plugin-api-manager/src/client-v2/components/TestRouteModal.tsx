import { Alert, Button, Descriptions, Input, Modal, Space, Spin, Tag } from 'antd';
import { useApp } from '@nocobase/client-v2';
import React, { useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

interface TestRouteModalProps {
  route: { id: number; name: string; method: string; targetUrl: string } | null;
  onClose: () => void;
}

interface TestResult {
  ok: boolean;
  status?: string;
  upstreamStatus?: number;
  durationMs?: number;
  attempt?: number;
  requestEncrypted?: boolean;
  responseEncrypted?: boolean;
  errorCode?: string;
  responsePreview?: string;
  error?: string;
}

export const TestRouteModal: React.FC<TestRouteModalProps> = ({ route, onClose }) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [payload, setPayload] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = async () => {
    if (!route) return;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const res = await api.request({
        url: 'apiRoutes:test',
        method: 'post',
        params: { filterByTk: route.id },
        data: { payload: payload || undefined },
      });
      setResult((res?.data?.data ?? res?.data ?? {}) as TestResult);
    } catch (err) {
      setError(getErrorMessage(err, t('Test request failed') as string));
    } finally {
      setRunning(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setError(null);
    setPayload('');
    onClose();
  };

  return (
    <Modal
      title={`${t('Test Route') as string}: ${route?.name ?? ''}`}
      open={Boolean(route)}
      onCancel={handleClose}
      footer={
        <Space>
          <Button onClick={handleClose}>{t('Close')}</Button>
          <Button type="primary" loading={running} onClick={runTest}>
            {t('Run Test')}
          </Button>
        </Space>
      }
      width={640}
    >
      <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
        <Descriptions.Item label={t('Method') as string}>{route?.method}</Descriptions.Item>
        <Descriptions.Item label={t('Target URL') as string}>{route?.targetUrl}</Descriptions.Item>
      </Descriptions>
      {route?.method !== 'GET' && (
        <Input.TextArea
          rows={5}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder={t('Optional request body sent to the target URL') as string}
        />
      )}
      <div style={{ marginTop: 12, minHeight: 80 }}>
        {running && <Spin />}
        {error && <Alert type="error" message={error} />}
        {result && !error && (
          <>
            <Alert
              type={result.ok ? 'success' : 'error'}
              message={result.ok ? (t('Upstream reachable') as string) : (t('Upstream request failed') as string)}
              style={{ marginBottom: 8 }}
            />
            <Descriptions size="small" column={2}>
              <Descriptions.Item label={t('Status') as string}>
                <Tag color={result.ok ? 'green' : 'red'}>{result.status ?? '-'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('Upstream Status') as string}>
                {result.upstreamStatus ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Duration (ms)') as string}>{result.durationMs ?? '-'}</Descriptions.Item>
              <Descriptions.Item label={t('Attempt') as string}>{result.attempt ?? '-'}</Descriptions.Item>
              {(result.requestEncrypted || result.responseEncrypted) && (
                <Descriptions.Item label={t('Encryption') as string} span={2}>
                  <Space size={4}>
                    {result.requestEncrypted && <Tag color="blue">{t('Request encrypted') as string}</Tag>}
                    {result.responseEncrypted && <Tag color="blue">{t('Response encrypted') as string}</Tag>}
                  </Space>
                </Descriptions.Item>
              )}
            </Descriptions>
            {result.error && <Alert type="warning" message={result.error} style={{ marginTop: 8 }} />}
            {result.responsePreview && (
              <pre
                style={{
                  marginTop: 8,
                  maxHeight: 200,
                  overflow: 'auto',
                  background: '#f5f5f5',
                  padding: 8,
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                {result.responsePreview}
              </pre>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};

export default TestRouteModal;
