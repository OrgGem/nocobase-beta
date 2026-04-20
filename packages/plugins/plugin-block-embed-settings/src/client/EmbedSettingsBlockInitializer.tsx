import React from 'react';
import { useSchemaInitializer, useApp, useRequest } from '@nocobase/client';
import { Outlet } from 'react-router-dom';

function collectEmbeddablePlugins(app: any): { value: string; label: string }[] {
  const results: { value: string; label: string }[] = [];
  const settings = (app.pluginSettingsManager as any).settings as Record<string, any>;

  for (const [key, setting] of Object.entries(settings)) {
    if (!app.pluginSettingsManager.has(key)) continue;
    if (key.includes(':')) continue;
    if (!setting.Component || setting.Component === Outlet) continue;

    const label = typeof setting.title === 'string' ? setting.title : key;
    results.push({ value: key, label });
  }

  return results.sort((a, b) => a.label.localeCompare(b.label));
}

export const useEmbedSettingsPlugins = () => {
  const { insert } = useSchemaInitializer();
  const app = useApp();

  const { data, loading } = useRequest<any>({
    resource: 'embedAllowedPlugins',
    action: 'list',
    params: { filter: { enabled: true }, pageSize: 200 }
  });

  if (loading) {
    return [{ 
      name: 'loading',
      type: 'item', 
      title: 'Loading...', 
      disabled: true, 
      Component: 'SchemaInitializerItem' 
    }];
  }

  const allowedKeys = new Set((data?.data || []).map((r: any) => r.pluginName));
  const allPlugins = collectEmbeddablePlugins(app);

  const pluginOptions = allowedKeys.size > 0
    ? allPlugins.filter((p) => allowedKeys.has(p.value))
    : [];

  if (pluginOptions.length === 0) {
    return [{ 
      name: 'empty',
      type: 'item', 
      title: 'No allowed plugins enabled', 
      disabled: true, 
      Component: 'SchemaInitializerItem' 
    }];
  }

  return pluginOptions.map(p => ({
    name: p.value,
    type: 'item',
    title: p.label,
    Component: 'SchemaInitializerItem',
    useComponentProps: () => {
      return {
        title: p.label,
        onClick: () => {
          insert({
            type: 'void',
            'x-settings': 'blockSettings:embedSettings',
            'x-decorator': 'CardItem',
            'x-decorator-props': {
              name: 'embed-settings',
            },
            'x-component': 'EmbedSettingsBlock',
            'x-component-props': {
              pluginName: p.value,
            },
          });
        }
      }
    }
  }));
};
