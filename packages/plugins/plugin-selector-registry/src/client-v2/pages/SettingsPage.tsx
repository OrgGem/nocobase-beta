import React, { useEffect, useState } from 'react';
import { Button, Card, Form, Input, InputNumber, Space, Switch, Typography } from 'antd';
import { useRequest } from 'ahooks';
import { useFlowContext } from '@nocobase/flow-engine';

import { useT } from '../locale';
import { useSelectorRegistryPermissions } from '../permissions';
import { type NocoBaseResponse, unwrapData } from './api';

type SelectorRegistrySettings = {
  enabled: boolean;
  llmService: string | null;
  llmModel: string | null;
  confidenceThreshold: number;
  quarantineThreshold: number;
  probationSuccessTarget: number;
  failStreakLimit: number;
  rollbackFailLimit: number;
  circuitBreakerMaxHeals: number;
  circuitBreakerWindowMs: number;
  circuitBreakerCooldownMs: number;
  entryTtlMs: number;
  domSnippetMaxChars: number;
  logRetentionDays: number;
  ewmaAlpha: number;
};

type SettingsFormValues = Omit<SelectorRegistrySettings, 'llmService' | 'llmModel'> & {
  llmService: string;
  llmModel: string;
};

type PruneResult = {
  removedResolveLogs: number;
  removedFeedbacks: number;
};

export default function SettingsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const { canManage } = useSelectorRegistryPermissions();
  const [form] = Form.useForm<SettingsFormValues>();
  const [saving, setSaving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const request = useRequest(() =>
    ctx.api.request<NocoBaseResponse<SelectorRegistrySettings>>({
      url: 'selectorRegistryAdmin:getSettings',
      method: 'get',
    }),
  );
  const settings = unwrapData<SelectorRegistrySettings>(request.data);

  useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        ...settings,
        llmService: settings.llmService ?? '',
        llmModel: settings.llmModel ?? '',
      });
    }
  }, [form, settings]);

  const save = async () => {
    if (!canManage || saving) {
      return;
    }
    setSaving(true);
    try {
      const values = await form.validateFields();
      await ctx.api.request<NocoBaseResponse<SelectorRegistrySettings>>({
        url: 'selectorRegistryAdmin:updateSettings',
        method: 'post',
        data: {
          ...values,
          llmService: values.llmService.trim() || null,
          llmModel: values.llmModel.trim() || null,
        },
      });
      ctx.message.success(t('Settings saved'));
      await request.refreshAsync();
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setSaving(false);
    }
  };

  const pruneLogs = async () => {
    if (!canManage || pruning) {
      return;
    }
    setPruning(true);
    try {
      const response = await ctx.api.request<NocoBaseResponse<PruneResult>>({
        url: 'selectorRegistryAdmin:pruneLogs',
        method: 'post',
      });
      const result = unwrapData<PruneResult>(response);
      ctx.message.success(
        t('Prune completed ({{removedResolveLogs}} resolve logs, {{removedFeedbacks}} feedbacks)', {
          removedResolveLogs: result?.removedResolveLogs ?? 0,
          removedFeedbacks: result?.removedFeedbacks ?? 0,
        }),
      );
    } catch {
      ctx.message.error(t('Action failed'));
    } finally {
      setPruning(false);
    }
  };

  return (
    <Card title={t('Settings')} loading={request.loading}>
      <Form form={form} layout="vertical" disabled={!canManage} style={{ maxWidth: 720 }}>
        <Typography.Title level={5}>{t('General')}</Typography.Title>
        <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="llmService" label={t('LLM Service')}>
          <Input />
        </Form.Item>
        <Form.Item name="llmModel" label={t('LLM Model')}>
          <Input />
        </Form.Item>

        <Typography.Title level={5}>{t('Healing')}</Typography.Title>
        <Form.Item name="confidenceThreshold" label={t('Confidence Threshold')}>
          <InputNumber min={0} max={1} step={0.05} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="quarantineThreshold" label={t('Quarantine Threshold')}>
          <InputNumber min={0} max={1} step={0.05} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="probationSuccessTarget" label={t('Probation Success Target')}>
          <InputNumber min={0} step={1} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="ewmaAlpha" label={t('EWMA Alpha')}>
          <InputNumber min={0} max={1} step={0.05} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="failStreakLimit" label={t('Fail Streak Limit')}>
          <InputNumber min={0} step={1} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="rollbackFailLimit" label={t('Rollback Fail Limit')}>
          <InputNumber min={0} step={1} style={{ width: 260 }} />
        </Form.Item>

        <Typography.Title level={5}>{t('Circuit Breaker')}</Typography.Title>
        <Form.Item name="circuitBreakerMaxHeals" label={t('Circuit Breaker Max Heals')}>
          <InputNumber min={0} step={1} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="circuitBreakerWindowMs" label={t('Circuit Breaker Window (ms)')}>
          <InputNumber min={0} step={1000} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="circuitBreakerCooldownMs" label={t('Circuit Breaker Cooldown (ms)')}>
          <InputNumber min={0} step={1000} style={{ width: 260 }} />
        </Form.Item>

        <Typography.Title level={5}>{t('Retention')}</Typography.Title>
        <Form.Item name="entryTtlMs" label={t('Entry TTL (ms)')}>
          <InputNumber min={0} step={60000} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="domSnippetMaxChars" label={t('DOM Snippet Max Chars')}>
          <InputNumber min={0} step={1000} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="logRetentionDays" label={t('Log Retention (days)')}>
          <InputNumber min={0} step={1} style={{ width: 260 }} />
        </Form.Item>

        {canManage ? (
          <Space>
            <Button type="primary" onClick={save} loading={saving}>
              {t('Save')}
            </Button>
            <Button danger onClick={pruneLogs} loading={pruning}>
              {t('Prune logs now')}
            </Button>
          </Space>
        ) : null}
      </Form>
    </Card>
  );
}
