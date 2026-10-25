/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Card, Form, Switch } from 'antd';
import React from 'react';
import { loadSettings, saveSettings, type BuildSettings } from '../buildApi';
import { ModelSelect, ServiceSelect } from '../components/AISelectors';
import { CollectionMultiSelect, type CollectionSelection } from '../components/CollectionMultiSelect';
import { useT } from '../locale';

type FormValues = { collections: CollectionSelection; llmService?: string; model?: string; enableAITool: boolean };
export default function SettingsPage() {
  const api = useApp().apiClient;
  const t = useT();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const service = Form.useWatch('llmService', form);
  const load = useRequest(() => loadSettings(api), {
    onSuccess: (settings) =>
      form.setFieldsValue({
        collections: { dataSource: settings.defaultDataSource, collections: settings.defaultCollections || [] },
        llmService: settings.defaultLLMService,
        model: settings.defaultModel,
        enableAITool: settings.enableAITool !== false,
      }),
  });
  const save = useRequest(
    async (values: FormValues) => {
      const settings: BuildSettings = {
        defaultDataSource: values.collections?.dataSource,
        defaultCollections: values.collections?.collections || [],
        defaultLLMService: values.llmService,
        defaultModel: values.model,
        enableAITool: values.enableAITool,
      };
      await saveSettings(api, settings);
      message.success(t('Saved successfully'));
    },
    { manual: true, onError: () => message.error(t('Failed to save settings')) },
  );
  return (
    <Card>
      {load.error && (
        <Alert
          type="error"
          showIcon
          message={t('Failed to load the list')}
          action={<Button onClick={load.refresh}>{t('Retry')}</Button>}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 720 }}
        disabled={load.loading || !!load.error || save.loading}
        onFinish={(values) => save.run(values)}
      >
        <Form.Item name="collections" label={t('Default collections')}>
          <CollectionMultiSelect />
        </Form.Item>
        <Form.Item name="llmService" label={t('Default AI service')}>
          <ServiceSelect onChange={() => form.setFieldValue('model', undefined)} />
        </Form.Item>
        <Form.Item name="model" label={t('Default model')}>
          <ModelSelect service={service} />
        </Form.Item>
        <Form.Item name="enableAITool" label={t('Enable AI tool')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={save.loading}>
          {t('Save')}
        </Button>
      </Form>
    </Card>
  );
}
