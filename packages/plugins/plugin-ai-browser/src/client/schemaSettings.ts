import { useFieldSchema } from '@formily/react';
import { SchemaSettings, useDesignable } from '@nocobase/client';
import { useT } from './locale';
import { SessionSelect } from './SessionSelect';

export const aiBrowserBlockSettings = new SchemaSettings({
  name: 'aiBrowserBlockSettings',
  items: [
    {
      name: 'configureBrowserBlock',
      type: 'modal',
      useComponentProps() {
        const fieldSchema = useFieldSchema();
        const { dn } = useDesignable();
        const t = useT();

        const props = fieldSchema?.['x-component-props'] || {};

        return {
          title: t('Configure AI Browser block'),
          schema: {
            type: 'object',
            properties: {
              liveUrl: {
                title: t('Browser Session'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': SessionSelect,
                default: props.liveUrl || '',
              },
              title: {
                title: t('Title'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'Input',
                default: props.title || '',
              },
              height: {
                title: t('Height (px)'),
                type: 'number',
                'x-decorator': 'FormItem',
                'x-component': 'InputNumber',
                'x-component-props': { min: 320, max: 5000, step: 40 },
                default: props.height || 640,
              },
            },
          },
          onSubmit({ liveUrl, title, height }: { liveUrl?: string; title?: string; height?: number }) {
            const componentProps = { ...fieldSchema['x-component-props'], liveUrl, title, height: height || 640 };
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
