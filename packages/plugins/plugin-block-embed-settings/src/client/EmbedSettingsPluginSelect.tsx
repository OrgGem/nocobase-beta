import React, { useMemo } from 'react';
import { Select } from 'antd';
import { useApp, useCompile } from '@nocobase/client';

function collectEmbeddablePlugins(app: any, compile: any): { value: string; label: string }[] {
  const results: { value: string; label: string }[] = [];
  
  const flattenSettings = (pages: any[], prefix = '') => {
    for (const page of pages) {
      if (page.children && page.children.length > 0) {
        flattenSettings(page.children, `${prefix}${compile(page.title)} / `);
      } else {
        // Only include actual settings pages
        const label = `${prefix}${compile(page.title)}`;
        results.push({ value: page.key, label });
      }
    }
  };

  const list = app.pluginSettingsManager.getList() || [];
  flattenSettings(list);

  return results.sort((a, b) => a.label.localeCompare(b.label));
}

export const EmbedSettingsPluginSelect = (props: any) => {
  const app = useApp();
  const compile = useCompile();

  const options = useMemo(() => {
    return collectEmbeddablePlugins(app, compile);
  }, [app, compile]);

  return (
    <Select
      {...props}
      options={options}
      showSearch
      optionFilterProp="label"
    />
  );
};

