import { useApp } from '@nocobase/client-v2';
import type { APIClient } from '@nocobase/sdk';
import { Button, Card, Form, InputNumber, message, Space, Switch, Typography } from 'antd';
import React from 'react';
import { observabilityApi, type SettingsData } from '../api';
import { useVisiblePolling } from '../hooks';
import { useT } from '../locale';
import { DataState } from './shared';
export default function SettingsPage() {
  const t = useT();
  const api = useApp().apiClient;
  const load = React.useCallback(
    (client: Parameters<typeof observabilityApi.settings>[0]) => observabilityApi.settings(client),
    [],
  );
  const query = useVisiblePolling(load, 30_000);
  return (
    <main aria-labelledby="app-observability-settings">
      <Typography.Title id="app-observability-settings" level={2}>
        {t('Settings')}
      </Typography.Title>
      <DataState {...query} empty={!query.data} retry={query.refresh}>
        {query.data ? <SettingsForm api={api} initial={query.data} onSaved={query.refresh} /> : null}
      </DataState>
    </main>
  );
}
function SettingsForm({
  api,
  initial,
  onSaved,
}: {
  api: APIClient;
  initial: SettingsData;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [form] = Form.useForm<SettingsData>();
  const [saving, setSaving] = React.useState(false);
  const save = async (values: SettingsData) => {
    setSaving(true);
    try {
      await observabilityApi.updateSettings(api, values);
      message.success(t('Settings saved'));
      await onSaved();
    } catch {
      message.error(t('Unable to save settings'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <Form form={form} layout="vertical" initialValues={initial} onFinish={save}>
        <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="redisSnapshotsEnabled" label={t('Redis snapshots')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="prometheusEnabled" label={t('Prometheus export')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Space wrap align="start">
          {numberField(t, 'sampleIntervalSeconds', 'Sample interval seconds', 5, 300)}
          {numberField(t, 'bucketSeconds', 'Bucket seconds', 10, 3600)}
          {numberField(t, 'retentionDays', 'Retention days', 1, 365)}
          {numberField(t, 'activeUserWindowSeconds', 'Active-user window seconds', 30, 3600)}
        </Space>
        <Space wrap align="start">
          {numberField(t, 'capacityThresholdCpu', 'CPU threshold', 1, 100)}
          {numberField(t, 'capacityThresholdMemory', 'Memory threshold', 1, 100)}
          {numberField(t, 'capacityThresholdEventLoop', 'Event-loop threshold', 1, 100)}
          {numberField(t, 'capacityThresholdDbWait', 'DB wait threshold', 1, 100)}
        </Space>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t('Save')}
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
function numberField(t: (key: string) => string, name: keyof SettingsData, label: string, min: number, max: number) {
  return (
    <Form.Item name={name} label={t(label)} rules={[{ required: true }]}>
      <InputNumber min={min} max={max} />
    </Form.Item>
  );
}
