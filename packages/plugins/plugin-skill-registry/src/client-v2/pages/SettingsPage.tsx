import React, { useEffect } from 'react';
import { Alert, Button, Card, Form, InputNumber, Space, Switch, Tag, Typography } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSkillRegistryPermissions } from '../permissions';
import GuidePage from './GuidePage';

type Overrides = {
  publicEnabled?: boolean;
  maxSourceItems?: number;
  maxSourceFileBytes?: number;
  downloadConcurrencyPerIp?: number;
  downloadConcurrencyGlobal?: number;
  downloadResponseTimeoutMs?: number;
  stuckRunMinutes?: number;
  downloadRetentionDays?: number;
};

type EffectiveValue = { value: boolean | number; source: 'ui' | 'environment' | 'default' };
type SettingsResponse = { overrides: Overrides; effective: Partial<Record<keyof Overrides, EffectiveValue>> };

function isSettingsResponse(value: unknown): value is SettingsResponse {
  return Boolean(value && typeof value === 'object' && 'overrides' in value && 'effective' in value);
}

export function unwrapSettingsResponse(value: unknown): SettingsResponse | undefined {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (isSettingsResponse(current)) return current;
    if (!current || typeof current !== 'object' || !('data' in current)) return undefined;
    current = (current as { data?: unknown }).data;
  }
  return undefined;
}

export default function SettingsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canManage } = useSkillRegistryPermissions();
  const [form] = Form.useForm<Overrides>();
  const loadSettings = () => ctx.api.request({ url: 'skillRegistryAdmin:getSettings', method: 'get' });
  const request = useRequest(loadSettings);
  const settings = unwrapSettingsResponse(request.data);

  useEffect(() => {
    if (settings) {
      const effectiveValues = Object.fromEntries(
        Object.entries(settings.effective || {}).map(([key, item]) => [key, item.value]),
      ) as Overrides;
      form.setFieldsValue({ ...effectiveValues, ...settings.overrides });
    }
  }, [form, settings]);

  const save = async () => {
    const overrides = await form.validateFields();
    await ctx.api.request({ url: 'skillRegistryAdmin:updateSettings', method: 'post', data: { overrides } });
    ctx.message.success(t('Settings saved'));
    await request.refreshAsync();
  };

  const sourceTag = (key: keyof Overrides) => {
    const item = settings?.effective?.[key];
    return item ? (
      <Tag>{t(item.source === 'ui' ? 'UI override' : item.source === 'environment' ? 'Environment' : 'Default')}</Tag>
    ) : null;
  };

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex', maxWidth: 1100 }}>
      <Card title={t('Settings')} loading={request.loading}>
        <Alert
          type="info"
          showIcon
          message={t('UI values override environment variables and take effect without restarting the app.')}
        />
        <Form form={form} layout="vertical" style={{ marginTop: 16 }} disabled={!canManage}>
          <Form.Item
            name="publicEnabled"
            label={
              <Space>
                {t('Enable public registry API')}
                {sourceTag('publicEnabled')}
              </Space>
            }
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Typography.Title level={5}>{t('Runtime limits')}</Typography.Title>
          <Form.Item
            name="maxSourceItems"
            label={
              <Space>
                {t('Maximum source items')}
                {sourceTag('maxSourceItems')}
              </Space>
            }
          >
            <InputNumber min={1} max={10000} style={{ width: 260 }} />
          </Form.Item>
          <Form.Item
            name="maxSourceFileBytes"
            label={
              <Space>
                {t('Maximum source file bytes')}
                {sourceTag('maxSourceFileBytes')}
              </Space>
            }
          >
            <InputNumber min={1} max={268435456} style={{ width: 260 }} />
          </Form.Item>
          <Form.Item
            name="downloadConcurrencyPerIp"
            label={
              <Space>
                {t('Download concurrency per IP')}
                {sourceTag('downloadConcurrencyPerIp')}
              </Space>
            }
          >
            <InputNumber min={1} max={20} style={{ width: 260 }} />
          </Form.Item>
          <Form.Item
            name="downloadConcurrencyGlobal"
            label={
              <Space>
                {t('Global download concurrency')}
                {sourceTag('downloadConcurrencyGlobal')}
              </Space>
            }
          >
            <InputNumber min={1} max={200} style={{ width: 260 }} />
          </Form.Item>
          <Form.Item
            name="downloadResponseTimeoutMs"
            label={
              <Space>
                {t('Download response timeout (ms)')}
                {sourceTag('downloadResponseTimeoutMs')}
              </Space>
            }
          >
            <InputNumber min={1000} max={1800000} style={{ width: 260 }} />
          </Form.Item>
          <Form.Item
            name="stuckRunMinutes"
            label={
              <Space>
                {t('Stuck run timeout (minutes)')}
                {sourceTag('stuckRunMinutes')}
              </Space>
            }
          >
            <InputNumber min={1} max={1440} style={{ width: 260 }} />
          </Form.Item>
          <Form.Item
            name="downloadRetentionDays"
            label={
              <Space>
                {t('Download audit retention (days)')}
                {sourceTag('downloadRetentionDays')}
              </Space>
            }
          >
            <InputNumber min={1} max={3650} style={{ width: 260 }} />
          </Form.Item>
          {canManage ? (
            <Button type="primary" onClick={save}>
              {t('Save')}
            </Button>
          ) : null}
        </Form>
      </Card>
      <GuidePage />
    </Space>
  );
}
