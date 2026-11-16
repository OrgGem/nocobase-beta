// SPDX-License-Identifier: Apache-2.0

export const editActionSchema = {
  type: 'void',
  title: "{{t('Edit')}}",
  'x-component': 'Action.Link',
  'x-component-props': {
    openMode: 'drawer',
  },
  properties: {
    drawer: {
      type: 'void',
      title: 'Edit',
      'x-component': 'Action.Drawer',
      'x-decorator': 'FormV2',
      'x-use-decorator-props': 'useEditFormProps',
      properties: {
        form: {
          type: 'void',
          properties: {
            title: {
              type: 'string',
              'x-decorator': 'FormItem',
              'x-component': 'CollectionField',
            },
            collection: {
              type: 'string',
              'x-decorator': 'FormItem',
              'x-component': 'CollectionField',
              'x-component-props': {
                disabled: true,
              },
            },
            type: {
              type: 'string',
              'x-decorator': 'FormItem',
              title: `{{t("Type",{ns:"shared-forms"})}}`,
              'x-component': 'Radio.Group',
              default: 'form',
              enum: '{{ formTypes }}',
            },
            description: {
              type: 'string',
              'x-decorator': 'FormItem',
              'x-component': 'CollectionField',
            },
            enabled: {
              type: 'string',
              'x-decorator': 'FormItem',
              'x-component': 'CollectionField',
              default: true,
            },
          },
        },
        footer: {
          type: 'void',
          'x-component': 'Action.Drawer.Footer',
          properties: {
            submit: {
              title: 'Submit',
              'x-component': 'Action',
              'x-use-component-props': 'useSubmitActionProps',
            },
          },
        },
      },
    },
  },
};
