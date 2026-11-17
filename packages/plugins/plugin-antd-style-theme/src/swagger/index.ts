/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export default {
  openapi: '3.0.2',
  info: {
    title: 'NocoBase API - Antd Style Theme plugin',
  },
  components: {
    schemas: {
      Theme: {
        type: 'object',
        properties: {
          id: {
            type: 'integer',
          },
          uid: {
            type: 'string',
          },
          config: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
              },
              algorithm: {
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
              token: {
                type: 'object',
                additionalProperties: true,
              },
              components: {
                type: 'object',
                additionalProperties: true,
              },
            },
            required: ['name'],
            additionalProperties: true,
          },
          optional: {
            type: 'boolean',
          },
          isBuiltIn: {
            type: 'boolean',
          },
          default: {
            type: 'boolean',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'config', 'optional', 'isBuiltIn'],
        additionalProperties: false,
      },
    },
  },
  tags: [],
  paths: {
    '/antdStyleThemeConfig:list': {
      get: {
        tags: ['antdStyleThemeConfig'],
        description: 'Get a list of themes',
        parameters: [],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    $ref: '#/components/schemas/Theme',
                  },
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
          },
          '404': {
            description: 'Not Found',
          },
        },
      },
    },
    '/antdStyleThemeConfig:create': {
      post: {
        tags: ['antdStyleThemeConfig'],
        description: 'Create a new theme',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  config: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      token: {
                        type: 'object',
                      },
                      components: {
                        type: 'object',
                      },
                    },
                    required: ['name'],
                    additionalProperties: true,
                  },
                  optional: { type: 'boolean' },
                  isBuiltIn: { type: 'boolean' },
                },
                required: ['config'],
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Theme',
                },
              },
            },
          },
          '400': {
            description: 'Bad Request',
          },
          '401': {
            description: 'Unauthorized',
          },
        },
      },
    },
    '/antdStyleThemeConfig:update/{id}': {
      post: {
        tags: ['antdStyleThemeConfig'],
        description: 'Update an existing theme',
        parameters: [
          {
            name: 'id',
            in: 'path',
            description: 'ID of the theme to update',
            required: true,
            schema: {
              type: 'string',
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  config: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      token: {
                        type: 'object',
                      },
                      components: {
                        type: 'object',
                      },
                    },
                    additionalProperties: true,
                  },
                  optional: { type: 'boolean' },
                  isBuiltIn: { type: 'boolean' },
                  default: { type: 'boolean' },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Theme',
                },
              },
            },
          },
          '400': {
            description: 'Bad Request',
          },
          '401': {
            description: 'Unauthorized',
          },
          '404': {
            description: 'Not Found',
          },
        },
      },
    },
    '/antdStyleThemeConfig:destroy/{id}': {
      post: {
        tags: ['antdStyleThemeConfig'],
        description: 'Delete an existing theme',
        parameters: [
          {
            name: 'id',
            in: 'path',
            description: 'ID of the theme to delete',
            required: true,
            schema: {
              type: 'string',
            },
          },
        ],
        responses: {
          '204': {
            description: 'No Content',
          },
          '401': {
            description: 'Unauthorized',
          },
          '404': {
            description: 'Not Found',
          },
        },
      },
    },
    '/users:updateAntdStyleTheme': {
      post: {
        tags: ['users'],
        description: 'Persist the current user theme selection',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  themeId: {
                    oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }],
                  },
                },
                required: ['themeId'],
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OK',
          },
          '400': {
            description: 'Invalid or non-selectable themeId',
          },
          '401': {
            description: 'Unauthorized',
          },
        },
      },
    },
  },
};
