export const spacesSchema = {
  type: 'void',
  name: 'ai-build-guide-spaces',
  properties: {
    card: {
      type: 'void',
      'x-component': 'CardItem',
      'x-decorator': 'TableBlockProvider',
      'x-decorator-props': {
        collection: 'aiBuildGuideSpaces',
        action: 'list',
        rowKey: 'id',
        params: {
          appends: ['documents'],
          sort: ['-createdAt'],
        },
      },
      properties: {
        actions: {
          type: 'void',
          'x-component': 'ActionBar',
          'x-component-props': {
            style: {
              marginBottom: 16,
            },
          },
          properties: {
            create: {
              type: 'void',
              'x-component': 'Action',
              'x-component-props': {
                type: 'primary',
                title: '{{t("Create space")}}',
                icon: 'PlusOutlined',
              },
              properties: {
                drawer: {
                  type: 'void',
                  'x-component': 'Action.Drawer',
                  'x-component-props': {
                    title: '{{t("Create space")}}',
                  },
                  properties: {
                    form: {
                      type: 'void',
                      'x-component': 'FormV2',
                      'x-use-component-props': 'useCreateFormProps',
                      properties: {
                        title: {
                          type: 'string',
                          title: '{{t("Title")}}',
                          required: true,
                          'x-decorator': 'FormItem',
                          'x-component': 'Input',
                        },
                        llmService: {
                          type: 'string',
                          title: '{{t("LLM Service")}}',
                          required: true,
                          'x-decorator': 'FormItem',
                          'x-component': 'LLMServiceSelect',
                        },
                        model: {
                          type: 'string',
                          title: '{{t("Model")}}',
                          required: true,
                          'x-decorator': 'FormItem',
                          'x-component': 'ModelSelect',
                          'x-reactions': {
                            dependencies: ['llmService'],
                            fulfill: {
                              state: {
                                value: '{{$deps[0] ? $self.value : undefined}}',
                              },
                            },
                          },
                        },
                        systemPrompt: {
                          type: 'string',
                          title: '{{t("System Prompt")}}',
                          'x-decorator': 'FormItem',
                          'x-component': 'Input.TextArea',
                          'x-component-props': {
                            rows: 4,
                          },
                          default:
                            'You are an expert technical writer. Please generate a comprehensive HTML user guide based on the provided documents. Ensure the output is valid HTML and does not include Markdown syntax like ```html blocks.',
                        },
                        documents: {
                          type: 'array',
                          title: '{{t("Documents")}}',
                          'x-decorator': 'FormItem',
                          'x-component': 'Upload.Attachment',
                          'x-component-props': {
                            multiple: true,
                            action: 'attachments:create',
                            maxCount: 10,
                          },
                        },
                        footer: {
                          type: 'void',
                          'x-component': 'Action.Drawer.Footer',
                          properties: {
                            cancel: {
                              type: 'void',
                              title: '{{t("Cancel")}}',
                              'x-component': 'Action',
                              'x-use-component-props': 'useCancelActionProps',
                            },
                            submit: {
                              type: 'void',
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
          'x-component-props': {
            rowKey: 'id',
            rowSelection: {
              type: 'checkbox',
            },
          },
          properties: {
            title: {
              type: 'void',
              title: '{{t("Title")}}',
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
            status: {
              type: 'void',
              title: '{{t("Status")}}',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                status: {
                  type: 'string',
                  'x-component': 'StatusTag',
                  'x-read-pretty': true,
                },
              },
            },
            buildLog: {
              type: 'void',
              title: '{{t("Build Log")}}',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                buildLog: {
                  type: 'string',
                  'x-component': 'CollectionField',
                  'x-read-pretty': true,
                },
              },
            },
            actions: {
              type: 'void',
              title: '{{t("Actions")}}',
              'x-decorator': 'TableV2.Column.Decorator',
              'x-component': 'TableV2.Column',
              properties: {
                actions: {
                  type: 'void',
                  'x-component': 'Space',
                  'x-component-props': {
                    split: '|',
                  },
                  properties: {
                    build: {
                      type: 'void',
                      'x-component': 'BuildButton',
                    },
                    update: {
                      type: 'void',
                      title: '{{t("Edit")}}',
                      'x-component': 'Action.Link',
                      'x-component-props': {
                        type: 'primary',
                      },
                      properties: {
                        drawer: {
                          type: 'void',
                          'x-component': 'Action.Drawer',
                          'x-component-props': {
                            title: '{{t("Edit space")}}',
                          },
                          properties: {
                            form: {
                              type: 'void',
                              'x-component': 'FormV2',
                              'x-use-component-props': 'useEditFormProps',
                              properties: {
                                title: {
                                  type: 'string',
                                  title: '{{t("Title")}}',
                                  required: true,
                                  'x-decorator': 'FormItem',
                                  'x-component': 'Input',
                                },
                                llmService: {
                                  type: 'string',
                                  title: '{{t("LLM Service")}}',
                                  required: true,
                                  'x-decorator': 'FormItem',
                                  'x-component': 'LLMServiceSelect',
                                },
                                model: {
                                  type: 'string',
                                  title: '{{t("Model")}}',
                                  required: true,
                                  'x-decorator': 'FormItem',
                                  'x-component': 'ModelSelect',
                                },
                                systemPrompt: {
                                  type: 'string',
                                  title: '{{t("System Prompt")}}',
                                  'x-decorator': 'FormItem',
                                  'x-component': 'Input.TextArea',
                                  'x-component-props': {
                                    rows: 4,
                                  },
                                },
                                documents: {
                                  type: 'array',
                                  title: '{{t("Documents")}}',
                                  'x-decorator': 'FormItem',
                                  'x-component': 'Upload.Attachment',
                                  'x-component-props': {
                                    multiple: true,
                                    action: 'attachments:create',
                                    maxCount: 10,
                                  },
                                },
                                generatedHtml: {
                                  type: 'string',
                                  title: '{{t("Generated HTML")}}',
                                  'x-decorator': 'FormItem',
                                  'x-component': 'Input.TextArea',
                                  'x-component-props': {
                                    rows: 6,
                                  },
                                  'x-read-pretty': true,
                                },
                                buildLog: {
                                  type: 'string',
                                  title: '{{t("Build Log")}}',
                                  'x-decorator': 'FormItem',
                                  'x-component': 'Input.TextArea',
                                  'x-read-pretty': true,
                                },
                                footer: {
                                  type: 'void',
                                  'x-component': 'Action.Drawer.Footer',
                                  properties: {
                                    cancel: {
                                      type: 'void',
                                      title: '{{t("Cancel")}}',
                                      'x-component': 'Action',
                                      'x-use-component-props': 'useCancelActionProps',
                                    },
                                    submit: {
                                      type: 'void',
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
                      'x-component-props': {
                        confirm: {
                          title: '{{t("Delete")}}',
                          content: '{{t("Are you sure you want to delete this space?")}}',
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
  },
};
