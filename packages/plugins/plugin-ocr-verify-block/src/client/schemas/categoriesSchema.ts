import { ISchema } from '@formily/react';
import { ocrVerifyCategoriesCollection } from '../collections/ocrVerifyCategories';
import { tStr } from '../locale';

export const categoriesSchema: ISchema = {
  type: 'object',
  properties: {
    block: {
      type: 'void',
      'x-decorator': 'TableBlockProvider',
      'x-decorator-props': {
        collection: ocrVerifyCategoriesCollection,
        action: 'list',
        rowKey: 'id',
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
              title: tStr('Add new'),
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
                    title: tStr('Add new category'),
                  },
                  properties: {
                    form: {
                      type: 'void',
                      'x-component': 'FormV2',
                      'x-use-component-props': 'useCreateFormProps',
                      properties: {
                        name: {
                          title: tStr('Name (unique ID)'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          required: true,
                        },
                        title: {
                          title: tStr('Title'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          required: true,
                        },
                        description: {
                          title: tStr('Description'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input.TextArea',
                        },
                        callbackUrl: {
                          title: tStr('Callback URL'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                        },
                        callbackApiKey: {
                          title: tStr('Callback API key'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Password',
                        },
                        callbackTimeoutMs: {
                          title: tStr('Callback timeout (ms)'),
                          type: 'number',
                          'x-decorator': 'FormItem',
                          'x-component': 'InputNumber',
                          default: 15000,
                        },
                        acceptStatus: {
                          title: tStr('Accept status'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'accepted',
                        },
                        rejectStatus: {
                          title: tStr('Reject status'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'rejected',
                        },
                        itemsPath: {
                          title: tStr('Items path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'pages[].items[]',
                          required: true,
                        },
                        idPath: {
                          title: tStr('ID path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'id',
                        },
                        keyPath: {
                          title: tStr('Key path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'key',
                          required: true,
                        },
                        valuePath: {
                          title: tStr('Value path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'value',
                          required: true,
                        },
                        pagePath: {
                          title: tStr('Page path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'position.page',
                        },
                        rectPath: {
                          title: tStr('Rectangle path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'position',
                        },
                        pointsPath: {
                          title: tStr('Points path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'points',
                        },
                        confidencePath: {
                          title: tStr('Confidence path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'confidence',
                        },
                        statusPath: {
                          title: tStr('Status path'),
                          type: 'string',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                          default: 'status',
                        },
                        enabled: {
                          title: tStr('Enabled'),
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
                              title: tStr('Cancel'),
                              'x-component': 'Action',
                              'x-use-component-props': 'useCancelActionProps',
                            },
                            submit: {
                              title: tStr('Submit'),
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
              title: tStr('Actions'),
              'x-component': 'TableV2.Column',
              properties: {
                edit: {
                  type: 'void',
                  title: tStr('Edit'),
                  'x-component': 'Action.Link',
                  properties: {
                    drawer: {
                      type: 'void',
                      'x-component': 'Action.Drawer',
                      'x-component-props': {
                        title: tStr('Edit category'),
                      },
                      properties: {
                        form: {
                          type: 'void',
                          'x-component': 'FormV2',
                          'x-use-component-props': 'useEditFormProps',
                          properties: {
                            name: {
                              title: tStr('Name'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                              required: true,
                            },
                            title: {
                              title: tStr('Title'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                              required: true,
                            },
                            description: {
                              title: tStr('Description'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input.TextArea',
                            },
                            callbackUrl: {
                              title: tStr('Callback URL'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            callbackApiKey: {
                              title: tStr('Callback API key'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Password',
                            },
                            callbackTimeoutMs: {
                              title: tStr('Callback timeout (ms)'),
                              type: 'number',
                              'x-decorator': 'FormItem',
                              'x-component': 'InputNumber',
                            },
                            acceptStatus: {
                              title: tStr('Accept status'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            rejectStatus: {
                              title: tStr('Reject status'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            itemsPath: {
                              title: tStr('Items path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                              required: true,
                            },
                            idPath: {
                              title: tStr('ID path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            keyPath: {
                              title: tStr('Key path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                              required: true,
                            },
                            valuePath: {
                              title: tStr('Value path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                              required: true,
                            },
                            pagePath: {
                              title: tStr('Page path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            rectPath: {
                              title: tStr('Rectangle path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            pointsPath: {
                              title: tStr('Points path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            confidencePath: {
                              title: tStr('Confidence path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            statusPath: {
                              title: tStr('Status path'),
                              type: 'string',
                              'x-decorator': 'FormItem',
                              'x-component': 'Input',
                            },
                            enabled: {
                              title: tStr('Enabled'),
                              type: 'boolean',
                              'x-decorator': 'FormItem',
                              'x-component': 'Checkbox',
                            },
                            footer: {
                              type: 'void',
                              'x-component': 'Action.Drawer.Footer',
                              properties: {
                                cancel: {
                                  title: tStr('Cancel'),
                                  'x-component': 'Action',
                                  'x-use-component-props': 'useCancelActionProps',
                                },
                                submit: {
                                  title: tStr('Submit'),
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
                  title: tStr('Delete'),
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
