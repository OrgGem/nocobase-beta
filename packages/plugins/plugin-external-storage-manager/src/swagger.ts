/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

const directoryIdParameter = {
  name: 'filterByTk',
  in: 'query',
  required: true,
  description: 'External storage directory ID',
  schema: { type: 'integer' },
};

const pathParameter = {
  name: 'path',
  in: 'query',
  required: false,
  description: 'Virtual path inside the external storage directory root',
  schema: { type: 'string', default: '/' },
};

const fileEntrySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    path: { type: 'string' },
    type: { type: 'string', enum: ['file', 'directory'] },
    size: { type: 'integer', format: 'int64' },
    modifiedAt: { type: 'integer', format: 'int64' },
    mimetype: { type: 'string' },
  },
};

const successResponse = {
  description: 'OK',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          data: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
};

export default {
  openapi: '3.0.2',
  info: {
    title: 'NocoBase API - External Storage Manager Plugin',
    description:
      'Unified API for browsing and streaming files from registered external storage providers such as SFTP and S3.',
  },
  tags: [
    {
      name: 'extStorage',
      description: 'Unified external storage browsing, file operations, and stream transfer APIs',
    },
  ],
  paths: {
    '/extStorage:directories': {
      get: {
        tags: ['extStorage'],
        summary: 'List accessible external storage directories',
        security: [{ BearerAuth: [] }],
        responses: {
          200: {
            description: 'Directory list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: { type: 'object', additionalProperties: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/extStorage:list': {
      get: {
        tags: ['extStorage'],
        summary: 'List files and directories',
        description:
          'Lists entries under a virtual path. Pagination is applied in the backend after the provider returns directory entries.',
        security: [{ BearerAuth: [] }],
        parameters: [
          directoryIdParameter,
          pathParameter,
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 1000 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['file', 'directory'] } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['name', 'size', 'modifiedAt', 'type'] } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
        ],
        responses: {
          200: {
            description: 'File entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: fileEntrySchema },
                    meta: {
                      type: 'object',
                      properties: {
                        directoryId: { type: 'integer' },
                        directoryName: { type: 'string' },
                        currentPath: { type: 'string' },
                        rootPath: { type: 'string' },
                        total: { type: 'integer' },
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                        hasMore: { type: 'boolean' },
                        nextOffset: { type: 'integer', nullable: true },
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

    '/extStorage:stat': {
      get: {
        tags: ['extStorage'],
        summary: 'Get file or directory metadata',
        security: [{ BearerAuth: [] }],
        parameters: [directoryIdParameter, pathParameter],
        responses: {
          200: {
            description: 'File entry metadata',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: fileEntrySchema },
                },
              },
            },
          },
          404: { description: 'File or directory not found' },
        },
      },
    },

    '/extStorage:download': {
      get: {
        tags: ['extStorage'],
        summary: 'Download or preview a file as a stream',
        description:
          'Streams the remote file from the provider to the HTTP response. The server does not buffer the whole file in memory.',
        security: [{ BearerAuth: [] }],
        parameters: [
          directoryIdParameter,
          { ...pathParameter, required: true },
          {
            name: 'mode',
            in: 'query',
            schema: { type: 'string', enum: ['inline', 'attachment'], default: 'attachment' },
          },
        ],
        responses: {
          200: {
            description: 'File stream',
            headers: {
              'Content-Type': { schema: { type: 'string' }, description: 'MIME type' },
              'Content-Length': { schema: { type: 'integer' }, description: 'File size when available' },
              'Content-Disposition': { schema: { type: 'string' }, description: 'inline or attachment disposition' },
            },
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          403: { description: 'Permission denied' },
          404: { description: 'File not found' },
        },
      },
    },

    '/extStorage:upload': {
      post: {
        tags: ['extStorage'],
        summary: 'Upload file data',
        description:
          'Supports raw stream upload with application/octet-stream and multipart/form-data uploads. Raw stream upload pipes the HTTP request body directly to the storage adapter.',
        security: [{ BearerAuth: [] }],
        parameters: [
          directoryIdParameter,
          {
            name: 'path',
            in: 'query',
            required: true,
            description:
              'For raw uploads, this is the target file path. For multipart uploads, this is the target directory path.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' },
            },
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  file: {
                    type: 'array',
                    items: { type: 'string', format: 'binary' },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: successResponse,
          400: { description: 'Invalid upload request' },
          403: { description: 'Permission denied' },
        },
      },
    },

    '/extStorage:mkdir': {
      post: {
        tags: ['extStorage'],
        summary: 'Create a directory',
        security: [{ BearerAuth: [] }],
        parameters: [directoryIdParameter, pathParameter],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  folderName: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: successResponse },
      },
    },

    '/extStorage:rename': {
      post: {
        tags: ['extStorage'],
        summary: 'Rename or move a file/directory',
        security: [{ BearerAuth: [] }],
        parameters: [directoryIdParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['oldPath', 'newPath'],
                properties: {
                  oldPath: { type: 'string' },
                  newPath: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: successResponse },
      },
    },

    '/extStorage:delete': {
      post: {
        tags: ['extStorage'],
        summary: 'Delete a file or directory',
        security: [{ BearerAuth: [] }],
        parameters: [directoryIdParameter, { ...pathParameter, required: true }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['file', 'directory'], default: 'file' },
                },
              },
            },
          },
        },
        responses: { 200: successResponse },
      },
    },

    '/extStorage:exists': {
      get: {
        tags: ['extStorage'],
        summary: 'Check whether a path exists',
        security: [{ BearerAuth: [] }],
        parameters: [directoryIdParameter, pathParameter],
        responses: {
          200: {
            description: 'Exists result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        path: { type: 'string' },
                        exists: { type: 'boolean' },
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
