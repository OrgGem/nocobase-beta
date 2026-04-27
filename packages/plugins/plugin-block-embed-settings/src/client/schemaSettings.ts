import { useFieldSchema } from '@formily/react';
import { SchemaSettings, useDesignable } from '@nocobase/client';
import { useT } from './locale';
import { EmbedSettingsPluginSelect } from './EmbedSettingsPluginSelect';

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

        const currentPluginName = fieldSchema?.['x-component-props']?.pluginName || '';

        return {
          title: t('Select plugin'),
          schema: {
            type: 'object',
            properties: {
              pluginName: {
                title: t('Select plugin'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': EmbedSettingsPluginSelect,
                'x-component-props': {
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
