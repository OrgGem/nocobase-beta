/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState } from 'react';
import { Card, Form, Radio, Switch, Select, Button, message, Spin, Divider, Alert, Space, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useDocParserTranslation } from '../locale';
import { DEFAULT_SETTINGS } from '../../shared/defaults';

const { Text } = Typography;

type Settings = {
  id?: number;
  mode: 'default' | 'internal' | 'external' | 'smart-fallback';
  activeProviderId?: number | null;
  fallbackToDefault: boolean;
  imagePassThrough: boolean;
  includedExtnames: string[];
  useDocpixie: boolean;
  enableMarkitdown: boolean;
};

type Provider = {
  id: number;
  title: string;
  enabled: boolean;
};

export const GlobalSettings: React.FC = () => {
  const { t } = useDocParserTranslation();
  const api = useApp().apiClient;
  const [form] = Form.useForm<Settings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [mode, setMode] = useState<'default' | 'internal' | 'external' | 'smart-fallback'>('default');

  useEffect(() => {
    // eslint-disable-next-line promise/catch-or-return
    Promise.all([
      api.request({ url: 'docParserSettings:get' }),
      api.request({ url: 'docParserProviders:list', params: { pageSize: 200 } }),
    ])
      .then(([settingsRes, providersRes]) => {
        const settings: Settings = settingsRes?.data?.data ?? {
          ...DEFAULT_SETTINGS,
        };
        form.setFieldsValue(settings);
        setMode(settings.mode);

        const list: Provider[] = providersRes?.data?.data ?? [];
        setProviders(list);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await api.request({ url: 'docParserSettings:save', method: 'POST', data: values });
      message.success(t('Settings saved'));
    } catch (err: any) {
      message.error(err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />;

  const modeDescriptions: Record<string, string> = {
    default: t('mode_default_desc'),
    internal: t('mode_internal_desc'),
    external: t('mode_external_desc'),
    'smart-fallback': t('mode_smart_fallback_desc'),
  };

  return (
    <Card bordered={false}>
      <Form
        form={form}
        layout="vertical"
        onValuesChange={(changed) => {
          if (changed.mode) setMode(changed.mode);
        }}
      >
        <Form.Item name="mode" label={t('Processing Mode')}>
          <Radio.Group style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Radio value="default">
              <Space direction="vertical" size={0}>
                <Text strong>{t('Default (plugin-ai built-in)')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('mode_default_desc')}
                </Text>
              </Space>
            </Radio>
            <Radio value="internal">
              <Space direction="vertical" size={0}>
                <Text strong>{t('Internal (built-in document loaders)')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('mode_internal_desc')}
                </Text>
              </Space>
            </Radio>
            <Radio value="external">
              <Space direction="vertical" size={0}>
                <Text strong>{t('External (OCR API provider)')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('mode_external_desc')}
                </Text>
              </Space>
            </Radio>
            <Radio value="smart-fallback">
              <Space direction="vertical" size={0}>
                <Text strong>{t('Smart Fallback (Internal → External → Default)')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('mode_smart_fallback_desc')}
                </Text>
              </Space>
            </Radio>
          </Radio.Group>
        </Form.Item>

        {(mode === 'external' || mode === 'smart-fallback' || mode === 'internal') && (
          <Form.Item
            name="activeProviderId"
            label={mode === 'internal' ? t('Fallback External Provider') : t('Active Provider')}
            rules={mode === 'internal' ? [] : [{ required: true, message: t('Please select a provider') }]}
            help={mode === 'internal' ? <Text type="secondary">{t('fallback_provider_desc')}</Text> : undefined}
          >
            <Select
              placeholder={t('Please select a provider')}
              options={providers
                .filter((p) => p.enabled)
                .map((p) => ({
                  label: p.title,
                  value: p.id,
                }))}
              style={{ maxWidth: 400 }}
            />
          </Form.Item>
        )}

        <Divider />

        <Form.Item name="fallbackToDefault" valuePropName="checked" label={t('Fallback to default on error')}>
          <Switch />
        </Form.Item>

        <Form.Item name="imagePassThrough" valuePropName="checked" label={t('Pass images through to default')}>
          <Switch />
        </Form.Item>

        <Form.Item
          name="includedExtnames"
          label={t('Included File Extensions')}
          help={<Text type="secondary">{t('includedExtnames_desc')}</Text>}
        >
          <Select
            mode="tags"
            tokenSeparators={[',', ' ']}
            placeholder=".pdf, .docx, .xlsx, .pptx"
            style={{ maxWidth: 500 }}
            options={[
              { label: '.pdf', value: '.pdf' },
              { label: '.docx', value: '.docx' },
              { label: '.xlsx', value: '.xlsx' },
              { label: '.xls', value: '.xls' },
              { label: '.pptx', value: '.pptx' },
              { label: '.ppt', value: '.ppt' },
              { label: '.doc', value: '.doc' },
              { label: '.txt', value: '.txt' },
              { label: '.html', value: '.html' },
            ]}
          />
        </Form.Item>

        <Divider />

        <Form.Item
          name="enableMarkitdown"
          valuePropName="checked"
          label={t('Enable MarkItDown Parser')}
          help={<Text type="secondary">{t('Prioritize using Microsoft MarkItDown for internal parsing of documents before falling back.')}</Text>}
        >
          <Switch />
        </Form.Item>

        <Divider />

        <Form.Item
          name="useDocpixie"
          valuePropName="checked"
          label={t('Index with DocPixie (when available)')}
          help={<Text type="secondary">{t('docpixie_mode_desc')}</Text>}
        >
          <Switch />
        </Form.Item>

        <Divider />

        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>
            {t('Save')}
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
};
