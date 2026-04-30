import { useFieldSchema } from '@formily/react';
import { SchemaSettings, useDesignable } from '@nocobase/client';
import { useT } from './locale';
import { DiagramSelect } from './components/DiagramSelect';

export const drawioBlockSettings = new SchemaSettings({
  name: 'drawioBlockSettings',
  items: [
    {
      name: 'selectDiagram',
      type: 'modal',
      useComponentProps() {
        const fieldSchema = useFieldSchema();
        const { dn } = useDesignable();
        const t = useT();

        const props = fieldSchema?.['x-component-props'] || {};

        return {
          title: t('Select Diagram'),
          schema: {
            type: 'object',
            properties: {
              diagramId: {
                title: t('Diagram'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': DiagramSelect,
                default: props.diagramId || '',
                required: true,
              },
              height: {
                title: 'Height (px)',
                type: 'number',
                'x-decorator': 'FormItem',
                'x-component': 'InputNumber',
                'x-component-props': { min: 320, step: 40 },
                default: props.height || 640,
              },
              ui: {
                title: 'UI mode',
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'Select',
                'x-component-props': {
                  options: [
                    { label: 'Kennedy (default)', value: 'kennedy' },
                    { label: 'Min', value: 'min' },
                    { label: 'Sketch', value: 'sketch' },
                    { label: 'Atlas', value: 'atlas' },
                  ],
                },
                default: props.ui || 'kennedy',
              },
            },
          },
          onSubmit({ diagramId, height, ui }: { diagramId: string; height?: number; ui?: string }) {
            const componentProps = { ...fieldSchema['x-component-props'], diagramId, height, ui };
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
