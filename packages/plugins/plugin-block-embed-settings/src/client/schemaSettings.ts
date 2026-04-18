import { useFieldSchema } from '@formily/react';
import { SchemaSettings, useApp, useDesignable } from '@nocobase/client';
import { Outlet } from 'react-router-dom';
import { useT } from './locale';

function collectEmbeddablePlugins(app: any): { value: string; label: string }[] {
  const results: { value: string; label: string }[] = [];
  const settings = (app.pluginSettingsManager as any).settings as Record<string, any>;

  for (const [key, setting] of Object.entries(settings)) {
    if (!app.pluginSettingsManager.has(key)) continue;
    if (!setting.Component || setting.Component === Outlet) continue;
    // Skip route-param patterns like ":name"
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
        const currentPluginName = fieldSchema?.['x-component-props']?.pluginName || '';

        const pluginOptions = collectEmbeddablePlugins(app);

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
                  options: pluginOptions,
                  placeholder: t('Select plugin'),
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
