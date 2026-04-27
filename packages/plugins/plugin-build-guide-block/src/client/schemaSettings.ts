import { useFieldSchema } from '@formily/react';
import { SchemaSettings, useDesignable } from '@nocobase/client';
import { useT } from './locale';

export const userGuideBlockSettings = new SchemaSettings({
  name: 'userGuideBlockSettings',
  items: [
    {
      name: 'selectSpace',
      type: 'modal',
      useComponentProps() {
        const fieldSchema = useFieldSchema();
        const { dn } = useDesignable();
        const t = useT();

        const currentSpaceId = fieldSchema?.['x-component-props']?.spaceId || '';

        return {
          title: t('Select Space'),
          schema: {
            type: 'object',
            properties: {
              spaceId: {
                title: t('Space'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'RemoteSelect',
                'x-component-props': {
                  showSearch: true,
                  fieldNames: { label: 'title', value: 'id' },
                  service: {
                    resource: 'aiBuildGuideSpaces',
                    action: 'list',
                    params: {
                      filter: { status: 'completed' },
                    },
                  },
                },
                default: currentSpaceId,
                required: true,
              },
            },
          },
          onSubmit({ spaceId }: { spaceId: string }) {
            const componentProps = { ...fieldSchema['x-component-props'], spaceId };
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
