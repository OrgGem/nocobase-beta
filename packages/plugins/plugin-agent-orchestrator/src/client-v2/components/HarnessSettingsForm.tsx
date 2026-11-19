/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Button, Cascader, Form, InputNumber, Select, Space, Typography } from 'antd';
import { useT } from '../skill-hub/locale';
import { useRequest } from '../hooks/useApiRequest';

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function HarnessSettingsForm({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const modelsRequest = useRequest({ url: 'ai:listAllEnabledModels' });
  let parsed: JsonRecord;
  try {
    const input: unknown = JSON.parse(value || '{}');
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    parsed = input as JsonRecord;
  } catch {
    return null;
  }

  const tools = objectValue(parsed.tools);
  const effects = objectValue(tools.effects);
  const limits = objectValue(parsed.limits);
  const routing = objectValue(parsed.routing);
  const models = objectValue(routing.models);
  const primary = objectValue(models.primary);
  const fallback = Array.isArray(models.fallback) ? models.fallback.map(objectValue) : [];
  const rawServices = Array.isArray(modelsRequest.data) ? modelsRequest.data : objectValue(modelsRequest.data).data;
  const services = Array.isArray(rawServices) ? rawServices.map(objectValue) : [];
  const modelOptions = services
    .filter((service) => typeof service.llmService === 'string')
    .map((service) => ({
      value: String(service.llmService),
      label: String(service.llmServiceTitle || service.llmService),
      children: (Array.isArray(service.enabledModels) ? service.enabledModels.map(objectValue) : [])
        .filter((model) => typeof model.value === 'string')
        .map((model) => ({ value: String(model.value), label: String(model.label || model.value) })),
    }));
  const modelPair = (item: JsonRecord) =>
    typeof item.llmService === 'string' && typeof item.model === 'string' ? [item.llmService, item.model] : undefined;
  const setModels = (newValues: JsonRecord) => {
    onChange(JSON.stringify({ ...parsed, routing: { ...routing, models: { ...models, ...newValues } } }, null, 2));
  };
  const setValue = (section: string, field: string, newValue: unknown) => {
    const next = {
      ...parsed,
      [section]: { ...objectValue(parsed[section]), [field]: newValue },
    };
    onChange(JSON.stringify(next, null, 2));
  };

  return (
    <Form layout="vertical">
      <Typography.Text type="secondary">
        {t('These settings apply only where the capability matrix shows support.')}
      </Typography.Text>
      <Form.Item
        label={t('Profile model')}
        extra={t('A binding model override takes precedence. An empty profile model uses the employee model.')}
      >
        <Cascader
          allowClear
          options={modelOptions}
          loading={modelsRequest.loading}
          value={modelPair(primary)}
          onChange={(selection) => {
            const pair = Array.isArray(selection) ? selection : [];
            setModels({
              primary:
                typeof pair[0] === 'string' && typeof pair[1] === 'string'
                  ? { llmService: pair[0], model: pair[1] }
                  : null,
            });
          }}
          aria-label={t('Profile model')}
        />
      </Form.Item>
      <Form.Item
        label={t('Fallback models')}
        extra={t('Checked in order before execution when a configured model is unavailable.')}
      >
        <Cascader
          multiple
          allowClear
          options={modelOptions}
          loading={modelsRequest.loading}
          value={fallback.map(modelPair).filter((pair): pair is string[] => Boolean(pair))}
          onChange={(selection) => {
            const pairs = Array.isArray(selection) ? selection : [];
            setModels({
              fallback: pairs
                .filter(
                  (pair): pair is [string, string] =>
                    Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string',
                )
                .map(([llmService, model]) => ({ llmService, model })),
            });
          }}
          aria-label={t('Fallback models')}
        />
      </Form.Item>
      {fallback.length > 1 && (
        <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
          {fallback.map((model, index) => {
            const label = modelPair(model)?.join(' / ') || '-';
            const move = (offset: number) => {
              const reordered = [...fallback];
              const target = index + offset;
              [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
              setModels({ fallback: reordered });
            };
            return (
              <Space key={`${label}-${index}`}>
                <Typography.Text>{label}</Typography.Text>
                <Button
                  size="small"
                  disabled={index === 0}
                  aria-label={t('Move {{model}} up', { model: label })}
                  onClick={() => move(-1)}
                >
                  {t('Move up')}
                </Button>
                <Button
                  size="small"
                  disabled={index === fallback.length - 1}
                  aria-label={t('Move {{model}} down', { model: label })}
                  onClick={() => move(1)}
                >
                  {t('Move down')}
                </Button>
              </Space>
            );
          })}
        </Space>
      )}
      {modelsRequest.error && <Typography.Text type="danger">{t('Unable to load enabled models.')}</Typography.Text>}
      <Form.Item label={t('Allowed tools')}>
        <Select
          mode="tags"
          value={stringList(tools.allow)}
          onChange={(names: string[]) => setValue('tools', 'allow', names)}
          aria-label={t('Allowed tools')}
        />
      </Form.Item>
      <Form.Item
        label={t('Read-only tools')}
        extra={t('Classify a tool as read-only only after verifying its behavior and permissions.')}
      >
        <Select
          mode="tags"
          value={Object.entries(effects)
            .filter(([, effect]) => effect === 'read')
            .map(([name]) => name)}
          onChange={(names: string[]) => {
            const remaining = Object.fromEntries(Object.entries(effects).filter(([, effect]) => effect !== 'read'));
            setValue('tools', 'effects', {
              ...remaining,
              ...Object.fromEntries(names.map((name) => [name, 'read'])),
            });
          }}
          aria-label={t('Read-only tools')}
        />
      </Form.Item>
      <Form.Item label={t('Tools requiring approval')}>
        <Select
          mode="tags"
          value={stringList(tools.ask)}
          onChange={(names: string[]) => setValue('tools', 'ask', names)}
          aria-label={t('Tools requiring approval')}
        />
      </Form.Item>
      <Form.Item label={t('Denied tools')}>
        <Select
          mode="tags"
          value={stringList(tools.deny)}
          onChange={(names: string[]) => setValue('tools', 'deny', names)}
          aria-label={t('Denied tools')}
        />
      </Form.Item>
      <Form.Item
        label={t('Maximum tool calls')}
        extra={t('Hierarchical chat does not yet support this limit and rejects profiles that set it.')}
      >
        <InputNumber
          min={0}
          precision={0}
          style={{ width: '100%' }}
          value={typeof limits.maxToolCalls === 'number' ? limits.maxToolCalls : null}
          onChange={(next) => setValue('limits', 'maxToolCalls', next)}
          aria-label={t('Maximum tool calls')}
        />
      </Form.Item>
      <Form.Item label={t('Timeout (ms)')}>
        <InputNumber
          min={1}
          precision={0}
          style={{ width: '100%' }}
          value={typeof limits.timeoutMs === 'number' ? limits.timeoutMs : null}
          onChange={(next) => setValue('limits', 'timeoutMs', next)}
          aria-label={t('Timeout (ms)')}
        />
      </Form.Item>
    </Form>
  );
}
