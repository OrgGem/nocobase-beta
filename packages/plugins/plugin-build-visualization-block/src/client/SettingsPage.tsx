import { createForm } from '@formily/core';
import { Field, FormProvider } from '@formily/react';
import { useApp } from '@nocobase/client-v2';
import { Alert, App, Button, Card, Form, Space, Switch } from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { CollectionMultiSelect, CollectionMultiSelectValue, LLMServiceSelect, ModelSelect } from './components';
import { useT } from './locale';
import { SETTINGS_COLLECTION_NAME } from '../shared/constants';

interface SettingsValues {
  defaultDataSource?: string | null;
  defaultCollections?: string[];
  defaultLLMService?: string | null;
  defaultModel?: string | null;
  enableAITool?: boolean;
}

function normalizeSettings(value: unknown): SettingsValues {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    defaultDataSource: typeof source.defaultDataSource === 'string' ? source.defaultDataSource : undefined,
    defaultCollections: Array.isArray(source.defaultCollections)
      ? source.defaultCollections.filter((item): item is string => typeof item === 'string')
      : [],
    defaultLLMService: typeof source.defaultLLMService === 'string' ? source.defaultLLMService : undefined,
    defaultModel: typeof source.defaultModel === 'string' ? source.defaultModel : undefined,
    enableAITool: source.enableAITool !== false,
  };
}

function readStringValue(values: unknown, key: string): string | undefined {
  if (!values || typeof values !== 'object') {
    return undefined;
  }
  const value = (values as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export const SettingsPage: React.FC = () => {
  const api = useApp().apiClient;
  const { message } = App.useApp();
  const t = useT();
  const form = useMemo(() => createForm(), []);
  const [collectionValue, setCollectionValue] = useState<CollectionMultiSelectValue>({ collections: [] });
  const [enableAITool, setEnableAITool] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;

    const loadSettings = async () => {
      setLoading(true);
      setLoadFailed(false);
      try {
        const response = await api.resource(SETTINGS_COLLECTION_NAME).publicGet();
        if (!active) {
          return;
        }
        const settings = normalizeSettings((response as { data?: { data?: unknown } }).data?.data);
        setCollectionValue({
          dataSource: settings.defaultDataSource ?? undefined,
          collections: settings.defaultCollections ?? [],
        });
        form.setValues({
          llmService: settings.defaultLLMService,
          model: settings.defaultModel,
        });
        setEnableAITool(settings.enableAITool !== false);
      } catch (error) {
        if (!active) {
          return;
        }
        console.error('[plugin-build-visualization-block] Failed to load settings:', error);
        setLoadFailed(true);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    loadSettings();
    return () => {
      active = false;
    };
  }, [api, form]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await api.resource(SETTINGS_COLLECTION_NAME).update({
        filterByTk: 1,
        values: {
          defaultDataSource: collectionValue.dataSource,
          defaultCollections: collectionValue.collections ?? [],
          defaultLLMService: readStringValue(form.values, 'llmService'),
          defaultModel: readStringValue(form.values, 'model'),
          enableAITool,
        },
      });
      message.success(t('Saved successfully'));
    } finally {
      setSaving(false);
    }
  }, [api, collectionValue, enableAITool, form, message, t]);

  return (
    <Card loading={loading}>
      <Space direction="vertical" size="middle" style={{ width: '100%', maxWidth: 720 }}>
        {loadFailed ? <Alert type="error" showIcon message={t('Failed to load the list')} /> : null}
        <Form layout="vertical">
          <Form.Item label={t('Default collections')}>
            <CollectionMultiSelect value={collectionValue} onChange={setCollectionValue} />
          </Form.Item>
          <FormProvider form={form}>
            <Form.Item label={t('Default AI service')}>
              <Field name="llmService" component={[LLMServiceSelect, { style: { width: '100%' } }]} />
            </Form.Item>
            <Form.Item label={t('Default model')}>
              <Field name="model" component={[ModelSelect, { style: { width: '100%' } }]} />
            </Form.Item>
          </FormProvider>
          <Form.Item label={t('Enable AI tool')}>
            <Switch checked={enableAITool} onChange={setEnableAITool} />
          </Form.Item>
          <Button type="primary" loading={saving} onClick={handleSave}>
            {t('Save')}
          </Button>
        </Form>
      </Space>
    </Card>
  );
};

export default SettingsPage;
