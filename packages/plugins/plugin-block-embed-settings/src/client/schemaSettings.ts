import { useFieldSchema } from '@formily/react';
import { SchemaSettings, useAPIClient, useApp, useDesignable, useRequest } from '@nocobase/client';
import { Outlet } from 'react-router-dom';
import { useT } from './locale';

function collectEmbeddablePlugins(app: any): { value: string; label: string }[] {
  const results: { value: string; label: string }[] = [];
  const settings = (app.pluginSettingsManager as any).settings as Record<string, any>;

  for (const [key, setting] of Object.entries(settings)) {
    if (!app.pluginSettingsManager.has(key)) continue;
    if (!setting.Component || setting.Component === Outlet) continue;
    if (key.includes(':')) continue;

    const label = typeof setting.title === 'string' ? setting.title : key;
    results.push({ value: key, label });
  }

  return results.sort((a, b) => a.label.localeCompare(b.label));
}

export const embedSettingsBlockSettings = new SchemaSettings({
  name: 'blockSettings:embedSettings',
  items: [
    {
      name: 'selectPlugin',
      type: 'modal',
      useComponentProps() {
        const fieldSchema = useFieldSchema();
        const { dn } = useDesignable();
        const t = useT();
        const app = useApp();
        const api = useAPIClient();
        const currentPluginName = fieldSchema?.['x-component-props']?.pluginName || '';

        const allPlugins = collectEmbeddablePlugins(app);

        return {
          title: t('Edit embed settings'),
          schema: {
            type: 'object',
            properties: {
              pluginName: {
                title: t('Select plugin'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'Select',
                'x-component-props': {
                  showSearch: true,
                  optionFilterProp: 'label',
                  placeholder: t('Select plugin'),
                },
                'x-reactions': (field: any) => {
                  if (field.dataSource && field.dataSource.length > 0) return;
                  field.loading = true;
                  api.resource('embedAllowedPlugins').list({
                    filter: { enabled: true },
                    pageSize: 200,
                  }).then(({ data }: any) => {
                    const allowedRecords = data?.data || [];
                    const allowedKeys = new Set(allowedRecords.map((r: any) => r.pluginName));
                    field.dataSource = allowedKeys.size > 0 ? allPlugins.filter(p => allowedKeys.has(p.value)) : [];
                    field.loading = false;
                  });
                },
                default: currentPluginName,
                required: true,
              },
            },
          },
          onSubmit({ pluginName }: { pluginName: string }) {
            const componentProps = { ...fieldSchema['x-component-props'], pluginName };
            fieldSchema['x-component-props'] = componentProps;
            dn.emit('patch', {
              schema: {
                'x-uid': fieldSchema['x-uid'],
                'x-component-props': componentProps,
              },
            });
            dn.refresh();
          },
        };
      },
    },
    {
      name: 'divider',
      type: 'divider',
    },
    {
      name: 'delete',
      type: 'remove',
      useComponentProps() {
        return {
          removeParentsIfNoChildren: true,
          breakRemoveOn: {
            'x-component': 'Grid',
          },
        };
      },
    },
  ],
});
