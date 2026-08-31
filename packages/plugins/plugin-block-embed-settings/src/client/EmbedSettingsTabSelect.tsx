import React, { useEffect, useMemo, useRef } from 'react';
import { useForm } from '@formily/react';
import { observer } from '@formily/reactive-react';
import { Checkbox, Empty, Space, Typography } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { useT } from './locale';
import { collectEmbeddablePluginTabs } from './EmbedSettingsPluginSelect';
import type { EmbedSettingsTabSelectProps } from './types';

const { Text } = Typography;

export const EmbedSettingsTabSelect = observer((props: EmbedSettingsTabSelectProps) => {
  const { value, onChange, disabled, ...others } = props;
  const form = useForm();
  const app = useApp();
  const t = useT();
  const pluginName = form.values?.pluginName as string | undefined;
  const previousPluginNameRef = useRef<string | undefined>(pluginName);

  const options = useMemo(() => {
    return collectEmbeddablePluginTabs(app, pluginName).map((tab) => ({
      value: tab.value,
      label: tab.label,
    }));
  }, [app, pluginName]);

  useEffect(() => {
    if (!pluginName) {
      if (Array.isArray(value) && value.length > 0) {
        onChange?.([]);
      }
      previousPluginNameRef.current = pluginName;
      return;
    }

    if (options.length === 0) {
      if (Array.isArray(value) && value.length > 0) {
        onChange?.([]);
      }
      return;
    }

    const optionKeys = new Set(options.map((option) => option.value));

    // Plugin changed: preserve existing selection if keys still exist, otherwise select all
    if (previousPluginNameRef.current !== pluginName) {
      previousPluginNameRef.current = pluginName;
      if (Array.isArray(value) && value.length > 0) {
        const preserved = value.filter((key) => optionKeys.has(key));
        if (preserved.length > 0) {
          onChange?.(preserved);
          return;
        }
      }
      onChange?.(options.map((option) => option.value));
      return;
    }

    // Same plugin: filter out invalid keys, select all if no selection yet
    if (!Array.isArray(value) || value.length === 0) {
      onChange?.(options.map((option) => option.value));
      return;
    }

    const validKeys = value.filter((key: string) => optionKeys.has(key));
    if (validKeys.length !== value.length) {
      onChange?.(validKeys);
    }
  }, [onChange, options, pluginName, value]);

  if (!pluginName) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('Please select a plugin first')} />;
  }

  if (options.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('No embeddable tabs found')} />;
  }

  return (
    <>
      <Checkbox.Group {...others} value={Array.isArray(value) ? value : []} disabled={disabled} onChange={onChange}>
        <Space direction="vertical">
          {options.map((option) => (
            <Checkbox key={option.value} value={option.value}>
              {option.label}
            </Checkbox>
          ))}
        </Space>
      </Checkbox.Group>
      <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
        {t('Only enabled tabs will be shown in the block')}
      </Text>
    </>
  );
});
