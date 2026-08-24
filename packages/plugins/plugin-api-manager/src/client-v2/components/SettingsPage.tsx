import { Alert, Button, Descriptions, Form, InputNumber, Space, Spin, Switch, Tag, message } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import React, { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_CAPACITY_MAX_CONCURRENT_REQUESTS,
  DEFAULT_CAPACITY_MAX_REQUEST_BYTES,
  DEFAULT_CAPACITY_MAX_TOTAL_BYTES,
  DEFAULT_CAPACITY_QUEUE_ENABLED,
  DEFAULT_CAPACITY_QUEUE_SIZE,
  DEFAULT_CAPACITY_QUEUE_TIMEOUT_MS,
  DEFAULT_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS,
  DEFAULT_CIRCUIT_BREAKER_ENABLED,
  DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_CIRCUIT_BREAKER_OPEN_DURATION_MS,
} from '../../constants';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

interface HealthPayload {
  ok: boolean;
  state: string;
  reason?: string;
  capacity: {
    activeRequests: number;
    activeBytes: number;
    queuedRequests: number;
  };
  circuits: Record<string, { state: string; failures: number; openedAt: number }>;
}

interface SettingsRow {
  id?: number;
  maxConcurrentRequests?: number;
  maxTotalBytes?: number;
  maxRequestBytes?: number;
  queueEnabled?: boolean;
  queueSize?: number;
  queueTimeoutMs?: number;
  circuitBreakerEnabled?: boolean;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerOpenDurationMs?: number;
  circuitBreakerCountServerErrors?: boolean;
}

interface FieldSpec {
  name: string;
  label: string;
  envVar: string;
  defaultValue: string;
  kind: 'number' | 'boolean';
  description: string;
}

const FIELD_SPECS: FieldSpec[] = [
  {
    name: 'maxConcurrentRequests',
    label: 'Max Concurrent Requests',
    envVar: 'APIM_MAX_CONCURRENT_REQUESTS',
    defaultValue: String(DEFAULT_CAPACITY_MAX_CONCURRENT_REQUESTS),
    kind: 'number',
    description: 'Maximum in-flight gateway requests. Above this, requests are queued or rejected immediately.',
  },
  {
    name: 'maxTotalBytes',
    label: 'Max Total Bytes',
    envVar: 'APIM_MAX_TOTAL_BYTES',
    defaultValue: String(DEFAULT_CAPACITY_MAX_TOTAL_BYTES),
    kind: 'number',
    description:
      'Maximum sum of in-flight request payload bytes, estimated from Content-Length. 0 disables this total budget.',
  },
  {
    name: 'maxRequestBytes',
    label: 'Max Request Bytes',
    envVar: 'APIM_MAX_REQUEST_BYTES',
    defaultValue: String(DEFAULT_CAPACITY_MAX_REQUEST_BYTES),
    kind: 'number',
    description:
      'Hard per-request size ceiling. Requests above it fail with 413. 0 disables this guard (uses per-route Max Body instead).',
  },
  {
    name: 'queueEnabled',
    label: 'Queue Enabled',
    envVar: 'APIM_QUEUE_ENABLED',
    defaultValue: String(DEFAULT_CAPACITY_QUEUE_ENABLED),
    kind: 'boolean',
    description: 'When on, excess requests wait in a FIFO queue instead of being rejected.',
  },
  {
    name: 'queueSize',
    label: 'Queue Size',
    envVar: 'APIM_QUEUE_SIZE',
    defaultValue: String(DEFAULT_CAPACITY_QUEUE_SIZE),
    kind: 'number',
    description: 'Maximum waiting requests. Beyond this, requests are rejected with 429.',
  },
  {
    name: 'queueTimeoutMs',
    label: 'Queue Timeout (ms)',
    envVar: 'APIM_QUEUE_TIMEOUT_MS',
    defaultValue: String(DEFAULT_CAPACITY_QUEUE_TIMEOUT_MS),
    kind: 'number',
    description: 'How long a queued request may wait before being rejected with 503.',
  },
  {
    name: 'circuitBreakerEnabled',
    label: 'Circuit Breaker Enabled',
    envVar: 'APIM_CIRCUIT_BREAKER_ENABLED',
    defaultValue: String(DEFAULT_CIRCUIT_BREAKER_ENABLED),
    kind: 'boolean',
    description: 'Short-circuits a target after consecutive failures to shed load.',
  },
  {
    name: 'circuitBreakerFailureThreshold',
    label: 'Circuit Breaker Failure Threshold',
    envVar: 'APIM_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
    defaultValue: String(DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD),
    kind: 'number',
    description: 'Consecutive upstream failures (network errors, HTTP 5xx, timeouts) before the target circuit opens.',
  },
  {
    name: 'circuitBreakerOpenDurationMs',
    label: 'Circuit Breaker Open Duration (ms)',
    envVar: 'APIM_CIRCUIT_BREAKER_OPEN_DURATION_MS',
    defaultValue: String(DEFAULT_CIRCUIT_BREAKER_OPEN_DURATION_MS),
    kind: 'number',
    description: 'How long an open circuit rejects requests before allowing a half-open probe.',
  },
  {
    name: 'circuitBreakerCountServerErrors',
    label: 'Circuit Breaker Count Server Errors',
    envVar: 'APIM_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS',
    defaultValue: String(DEFAULT_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS),
    kind: 'boolean',
    description: 'When on, any HTTP 5xx from the target counts as a circuit failure.',
  },
];

function renderEnvGuide(spec: FieldSpec) {
  return (
    <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>
      <code>{spec.envVar}</code> — {spec.description} Default: <code>{spec.defaultValue}</code>.
    </div>
  );
}

export const SettingsPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [form] = Form.useForm<SettingsRow>();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'apiManagerSettings:get', method: 'get' });
      const data = (res?.data?.data ?? res?.data ?? null) as SettingsRow | null;
      const fallback: SettingsRow = {
        maxConcurrentRequests: DEFAULT_CAPACITY_MAX_CONCURRENT_REQUESTS,
        maxTotalBytes: DEFAULT_CAPACITY_MAX_TOTAL_BYTES,
        maxRequestBytes: DEFAULT_CAPACITY_MAX_REQUEST_BYTES,
        queueEnabled: DEFAULT_CAPACITY_QUEUE_ENABLED,
        queueSize: DEFAULT_CAPACITY_QUEUE_SIZE,
        queueTimeoutMs: DEFAULT_CAPACITY_QUEUE_TIMEOUT_MS,
        circuitBreakerEnabled: DEFAULT_CIRCUIT_BREAKER_ENABLED,
        circuitBreakerFailureThreshold: DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        circuitBreakerOpenDurationMs: DEFAULT_CIRCUIT_BREAKER_OPEN_DURATION_MS,
        circuitBreakerCountServerErrors: DEFAULT_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS,
      };
      form.setFieldsValue({ ...fallback, ...(data ?? {}) });
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load settings') as string));
    } finally {
      setLoading(false);
    }
  }, [api, form, t]);

  useEffect(() => {
    load();
  }, [load]);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await api.request({ url: 'apiManager:health', method: 'post' });
      const payload = (res?.data?.data ?? res?.data ?? null) as HealthPayload | null;
      setHealth(payload);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load health') as string));
    } finally {
      setHealthLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await api.request({ url: 'apiManagerSettings:save', method: 'post', data: values });
      message.success(t('Settings saved') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to save settings') as string));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 760, padding: 16 }}>
      <Alert
        type="info"
        showIcon
        message={t('Environment variables override these settings when set') as string}
        description={
          t(
            'Fields below are the runtime settings for capacity guard and circuit breaker. A deployment can pin any field through the env variable shown under it.',
          ) as string
        }
        style={{ marginBottom: 16 }}
      />
      <Spin spinning={loading}>
        {health && (
          <Descriptions
            size="small"
            bordered
            column={1}
            title={
              <Space>
                <span>{t('Live runtime state') as string}</span>
                <Button size="small" icon={<ReloadOutlined />} loading={healthLoading} onClick={loadHealth} />
                <Tag color={health.state === 'ok' ? 'green' : 'orange'}>
                  {health.state === 'ok' ? t('OK') : t('Degraded')}
                </Tag>
              </Space>
            }
            style={{ marginBottom: 16 }}
          >
            <Descriptions.Item label={t('Active Requests') as string}>
              {health.capacity.activeRequests}
            </Descriptions.Item>
            <Descriptions.Item label={t('Active Bytes') as string}>{health.capacity.activeBytes}</Descriptions.Item>
            <Descriptions.Item label={t('Queued Requests') as string}>
              {health.capacity.queuedRequests}
            </Descriptions.Item>
          </Descriptions>
        )}
        <Form form={form} layout="vertical">
          {FIELD_SPECS.map((spec) => (
            <Form.Item
              key={spec.name}
              name={spec.name}
              label={
                <span>
                  {t(spec.label) as string} <code style={{ fontWeight: 400, fontSize: 12 }}>{spec.envVar}</code>
                </span>
              }
              extra={renderEnvGuide(spec)}
              valuePropName={spec.kind === 'boolean' ? 'checked' : 'value'}
            >
              {spec.kind === 'boolean' ? <Switch /> : <InputNumber style={{ width: '100%' }} />}
            </Form.Item>
          ))}
          <Space>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
              {t('Save') as string}
            </Button>
          </Space>
        </Form>
      </Spin>
    </div>
  );
};

export default SettingsPage;
