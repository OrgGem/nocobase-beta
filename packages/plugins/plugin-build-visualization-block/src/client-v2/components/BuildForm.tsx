/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { useFlowContext, type FlowModelContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Form, Input, Space, Spin, Tag, Typography } from 'antd';
import React, { useEffect, useState } from 'react';
import { MAX_COLLECTIONS, MAX_REQUIREMENT_CHARS } from '../../shared/constants';
import { loadSettings, readBuild, retryBuild, startBuild, type BuildResult, type BuildSelection } from '../buildApi';
import { useT } from '../locale';
import { ModelSelect, ServiceSelect } from './AISelectors';
import { CollectionMultiSelect, type CollectionSelection } from './CollectionMultiSelect';
import { NativePreview } from './NativePreview';

type Values = { requirement: string; collections: CollectionSelection; llmService: string; model: string };
export function BuildForm({
  value,
  onChange,
  context,
}: {
  value?: BuildSelection;
  onChange?: (value?: BuildSelection) => void;
  context?: FlowModelContext;
}) {
  const inherited = useFlowContext<FlowModelContext>();
  const ctx = context || inherited;
  const app = useApp();
  const api = app.apiClient;
  const t = useT();
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const service = Form.useWatch('llmService', form);
  const [buildId, setBuildId] = useState(value?.buildId);
  const [result, setResult] = useState<BuildResult>();
  const [polling, setPolling] = useState(!!value?.buildId);
  const aiAvailable = !!app.pm.get('ai');
  const defaults = useRequest(() => loadSettings(api), {
    onSuccess: (settings) =>
      form.setFieldsValue({
        collections: {
          dataSource: settings.defaultDataSource || 'main',
          collections: settings.defaultCollections || [],
        },
        llmService: settings.defaultLLMService,
        model: settings.defaultModel,
      }),
  });
  const {
    run: poll,
    cancel,
    error: pollError,
  } = useRequest(
    async () => {
      if (!buildId) throw new Error('Invalid build response');
      return readBuild(api, buildId);
    },
    {
      manual: true,
      pollingInterval: 2000,
      pollingWhenHidden: false,
      onSuccess: (next) => {
        setResult(next);
        if (next.buildPhase === 'completed' || next.buildPhase === 'failed') {
          setPolling(false);
          if (next.buildPhase === 'completed' && next.blockSpec) onChange?.({ buildId: next.id, spec: next.blockSpec });
        }
      },
    },
  );
  useEffect(() => {
    if (buildId && polling) poll();
    else cancel();
    return cancel;
  }, [buildId, polling, poll, cancel]);

  const build = useRequest(
    async (values: Values) => {
      const id = await startBuild(api, {
        requirement: values.requirement.trim(),
        dataSource: values.collections.dataSource || 'main',
        collections: values.collections.collections || [],
        llmService: values.llmService,
        model: values.model,
      });
      onChange?.(undefined);
      setResult(undefined);
      setBuildId(id);
      setPolling(true);
    },
    { manual: true, onError: () => message.error(t('The requirement could not be saved')) },
  );
  const retry = useRequest(
    async () => {
      if (!buildId) return;
      await retryBuild(api, buildId);
      onChange?.(undefined);
      setResult(undefined);
      setPolling(true);
    },
    { manual: true, onError: () => message.error(t('The requirement could not be saved')) },
  );

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {!aiAvailable && <Alert type="warning" showIcon message={t('The AI service is unavailable')} />}
      {defaults.error && <Alert type="warning" showIcon message={t('Failed to load the list')} />}
      {pollError && (
        <Alert
          type="error"
          showIcon
          message={t('Failed to load build status')}
          action={<Button onClick={poll}>{t('Retry')}</Button>}
        />
      )}
      {polling ? (
        <Space>
          <Spin />
          <Tag>{t(result?.buildPhase || 'queued')}</Tag>
          <Typography.Text>{t('Generating')}</Typography.Text>
        </Space>
      ) : null}
      {result?.buildPhase === 'failed' && (
        <Alert type="error" showIcon message={result.errorMessage || t('The requirement could not be saved')} />
      )}
      {result?.buildPhase === 'completed' && result.blockSpec ? (
        <>
          {result.usedFallback && (
            <Alert type="warning" showIcon message={t('Generated using fallback specification')} />
          )}
          {Array.isArray(result.adjustments) && result.adjustments.length > 0 && (
            <details>
              <summary>{t('Adjustments')}</summary>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(result.adjustments, null, 2)}</pre>
            </details>
          )}
          <NativePreview ctx={ctx} spec={result.blockSpec} />
          <Typography.Text type="secondary">
            {t('Save this configuration to insert the generated block.')}
          </Typography.Text>
        </>
      ) : null}
      {!polling && buildId && (
        <Button loading={retry.loading} onClick={() => retry.run()} disabled={!aiAvailable}>
          {t('Regenerate')}
        </Button>
      )}
      <Form
        form={form}
        layout="vertical"
        disabled={defaults.loading || build.loading || polling || retry.loading}
        onFinish={(values) => build.run(values)}
      >
        <Form.Item
          name="requirement"
          label={t('Requirement')}
          rules={[{ required: true, whitespace: true }, { max: MAX_REQUIREMENT_CHARS }]}
        >
          <Input.TextArea aria-label={t('Requirement')} rows={3} maxLength={MAX_REQUIREMENT_CHARS} showCount />
        </Form.Item>
        <Form.Item
          name="collections"
          label={t('Collections')}
          rules={[
            {
              validator: (_rule, selected?: CollectionSelection) =>
                selected?.dataSource && selected.collections?.length && selected.collections.length <= MAX_COLLECTIONS
                  ? Promise.resolve()
                  : Promise.reject(new Error(t('At least one collection is required'))),
            },
          ]}
        >
          <CollectionMultiSelect />
        </Form.Item>
        <Form.Item name="llmService" label={t('AI service')} rules={[{ required: true }]}>
          <ServiceSelect onChange={() => form.setFieldValue('model', undefined)} />
        </Form.Item>
        <Form.Item name="model" label={t('Model')} rules={[{ required: true }]}>
          <ModelSelect service={service} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={build.loading} disabled={!aiAvailable}>
          {t('Build')}
        </Button>
      </Form>
    </Space>
  );
}
