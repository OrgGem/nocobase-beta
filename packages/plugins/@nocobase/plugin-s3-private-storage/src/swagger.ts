/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export default {
  info: {
    title: 'NocoBase API - S3 Private Storage Plugin',
    description:
      'Provides private S3 bucket storage with authenticated file streaming. Extends the `attachments` resource with a `stream` action for serving private files.',
  },
  tags: [{ name: 's3-private-storage', description: 'Private S3 file streaming' }],
  paths: {
    '/attachments:stream': {
      get: {
        tags: ['s3-private-storage'],
        summary: 'Stream a private attachment file',
        description:
          'Streams a file from a private S3 bucket. Access is granted only if the authenticated user has read permission on the parent record that owns the attachment. The plugin resolves ownership via `belongsToMany` relationships to the `attachments` collection.',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'filterByTk',
            in: 'query',
            required: true,
            description: 'Attachment record ID',
            schema: { type: 'integer' },
          },
        ],
        responses: {
          200: {
            description: 'File stream',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
            headers: {
              'Content-Type': {
                schema: { type: 'string' },
                description: 'MIME type of the file',
              },
              'Content-Disposition': {
                schema: { type: 'string' },
                description: 'Attachment disposition with filename',
              },
            },
          },
          401: { description: 'Unauthorized — authentication required' },
          403: { description: 'Forbidden — no access to the parent record' },
          404: { description: 'Attachment not found or not stored in private S3' },
        },
      },
    },
  },
};
