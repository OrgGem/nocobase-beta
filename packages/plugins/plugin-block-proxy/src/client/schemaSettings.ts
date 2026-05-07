import { useFieldSchema } from '@formily/react';
import { SchemaSettings, useDesignable } from '@nocobase/client';
import { useT } from './locale';
import { ProxyServiceSelect } from './ProxyServiceSelect';

export const proxyBlockSettings = new SchemaSettings({
  name: 'blockSettings:proxy',
  items: [
    {
      name: 'selectService',
      type: 'modal',
      useComponentProps() {
        const fieldSchema = useFieldSchema();
        const { dn } = useDesignable();
        const t = useT();

        const currentSlug = fieldSchema?.['x-component-props']?.slug || '';
        const currentHeight = fieldSchema?.['x-component-props']?.height || 600;
        const currentMode = fieldSchema?.['x-component-props']?.renderMode || 'iframe';

        return {
          title: t('Configure Proxy'),
          schema: {
            type: 'object',
            properties: {
              slug: {
                title: t('Proxy Service'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': ProxyServiceSelect,
                'x-component-props': {
                  placeholder: t('Select a proxy service'),
                },
                default: currentSlug,
                required: true,
              },
              renderMode: {
                title: t('Render Mode'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'Select',
                'x-component-props': {
                  options: [
                    { label: 'iframe — Full SPA support', value: 'iframe' },
                    { label: 'Embed — Shadow DOM (static/dashboard)', value: 'embed' },
                  ],
                },
                default: currentMode,
              },
              height: {
                title: t('Height (px)'),
                type: 'number',
                'x-decorator': 'FormItem',
                'x-component': 'InputNumber',
                'x-component-props': {
                  min: 200,
                  max: 5000,
                  step: 50,
                },
                default: currentHeight,
              },
            },
          },
          onSubmit({ slug, height, renderMode }: { slug: string; height: number; renderMode: string }) {
            const componentProps = {
              ...fieldSchema['x-component-props'],
              slug,
              height: height || 600,
              renderMode: renderMode || 'iframe',
            };
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
