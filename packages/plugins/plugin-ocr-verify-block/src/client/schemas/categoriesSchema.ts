import { ISchema } from '@formily/react';

export const categoriesSchema: ISchema = {
  type: 'object',
  properties: {
    block: {
      type: 'void',
      'x-decorator': 'DataBlockProvider',
      'x-decorator-props': {
        collection: 'ocrVerifyCategories',
        action: 'list',
      },
      properties: {
        actions: {
          type: 'void',
          'x-component': 'ActionBar',
          'x-component-props': {
            style: { marginBottom: '16px' },
          },
          properties: {
            create: {
              type: 'void',
              title: '{{t("Add new")}}',
              'x-component': 'Action',
              'x-component-props': {
                type: 'primary',
                icon: 'PlusOutlined',
              },
              properties: {
                drawer: {
                  type: 'void',
                  'x-component': 'Action.Drawer',
                  'x-component-props': {
                    title: '{{t("Add new category")}}',
                  },
                  properties: {
                    form: {
                      type: 'void',
                      'x-component': 'FormV2',
                      'x-use-component-props': 'useCreateFormProps',
                      properties: {
                        name: {
                          title: 'Name (Unique ID)',
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          required: true,
                        },
                        title: {
                          title: 'Title',
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          required: true,
                        },
                        callbackUrl: {
                          title: 'Callback URL',
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                        },
                        callbackApiKey: {
                          title: 'Callback API Key',
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Password',
                        },
                        acceptStatus: {
                          title: 'Accept Status',
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'accepted',
                        },
                        rejectStatus: {
                          title: 'Reject Status',
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'rejected',
                        },
                        enabled: {
                          title: 'Enabled',
                          type: 'boolean',
                          'x-decorator': 'FormItem',
                          'x-component': 'Checkbox',
                          default: true,
                        },
                        footer: {
                          type: 'void',
                          'x-component': 'Action.Drawer.Footer',
                          properties: {
                            cancel: {
                              title: '{{t("Cancel")}}',
                              'x-component': 'Action',
                              'x-use-component-props': 'useCancelActionProps',
                            },
                            submit: {
                              title: '{{t("Submit")}}',
                              'x-component': 'Action',
                              'x-use-component-props': 'useCreateActionProps',
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        table: {
          type: 'array',
          'x-component': 'TableV2',
          'x-use-component-props': 'useTableBlockProps',
          properties: {
            column1: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                title: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column2: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                name: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            column3: {
              type: 'void',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                enabled: {
                  type: 'boolean',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            actions: {
              type: 'void',
              title: '{{t("Actions")}}',
              'x-component': 'TableV2.Column',
              properties: {
                edit: {
                  type: 'void',
                  title: '{{t("Edit")}}',
                  'x-component': 'Action.Link',
                  properties: {
                    drawer: {
                      type: 'void',
                      'x-component': 'Action.Drawer',
                      'x-component-props': {
                        title: '{{t("Edit category")}}',
                      },
                      properties: {
                        form: {
                          type: 'void',
                          'x-component': 'FormV2',
                          'x-use-component-props': 'useEditFormProps',
                          properties: {
                            name: {
                              title: 'Name',
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                              required: true,
                            },
                            title: {
                              title: 'Title',
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                              required: true,
                            },
                            callbackUrl: {
                              title: 'Callback URL',
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            callbackApiKey: {
                              title: 'Callback API Key',
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Password',
                            },
                            acceptStatus: {
                              title: 'Accept Status',
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            rejectStatus: {
                              title: 'Reject Status',
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            enabled: {
                              title: 'Enabled',
                              type: 'boolean',
                              'x-decorator': 'FormItem',
                              'x-component': 'Checkbox',
                            },
                            footer: {
                              type: 'void',
                              'x-component': 'Action.Drawer.Footer',
                              properties: {
                                cancel: {
                                  title: '{{t("Cancel")}}',
                                  'x-component': 'Action',
                                  'x-use-component-props': 'useCancelActionProps',
                                },
                                submit: {
                                  title: '{{t("Submit")}}',
                                  'x-component': 'Action',
                                  'x-use-component-props': 'useUpdateActionProps',
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                delete: {
                  type: 'void',
                  title: '{{t("Delete")}}',
                  'x-component': 'Action.Link',
                  'x-use-component-props': 'useDestroyActionProps',
                },
              },
            },
          },
        },
      },
    },
  },
};
