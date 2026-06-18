import React, { useEffect, useMemo, useRef } from 'react';
import { useForm } from '@formily/react';
import { observer } from '@formily/reactive-react';
import { Checkbox, Empty, Space, Typography } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { useT } from './locale';
import { collectEmbeddablePluginTabs } from './EmbedSettingsPluginSelect';

const { Text } = Typography;

export const EmbedSettingsTabSelect = observer((props: any) => {
  const { value, onChange, disabled, ...others } = props;
  const form = useForm();
  const app = useApp();
  const t = useT();
  const pluginName = form.values?.pluginName;
  const previousPluginNameRef = useRef(pluginName);

  const options = useMemo(() => {
    return collectEmbeddablePluginTabs(app, pluginName).map((tab) => ({
      value: tab.value,
      label: tab.label,
    }));
  }, [app, pluginName]);

  useEffect(() => {
    const clearSelectedTabs = () => {
      if (!Array.isArray(value) || value.length > 0) {
        onChange?.([]);
      }
    };

    if (!pluginName) {
      clearSelectedTabs();
      previousPluginNameRef.current = pluginName;
      return;
    }

    if (options.length === 0) {
      clearSelectedTabs();
      return;
    }

    if (previousPluginNameRef.current !== pluginName || !Array.isArray(value)) {
      onChange?.(options.map((option) => option.value));
      previousPluginNameRef.current = pluginName;
      return;
    }

    const validKeys = new Set(options.map((option) => option.value));
    const nextValue = value.filter((key: string) => validKeys.has(key));
    if (nextValue.length !== value.length) {
      onChange?.(nextValue);
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
