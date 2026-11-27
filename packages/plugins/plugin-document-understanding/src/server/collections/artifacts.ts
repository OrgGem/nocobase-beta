/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'doc_understanding_artifacts',
  title: 'Document Understanding Artifacts',
  fields: [
    { type: 'string', name: 'artifactId', unique: true, length: 64 },
    { type: 'string', name: 'tenantId', length: 100, defaultValue: 'default' },
    { type: 'string', name: 'operationId', length: 64 },
    { type: 'string', name: 'role', length: 30, defaultValue: 'input' },
    { type: 'string', name: 'state', length: 20, defaultValue: 'UPLOADING' },
    { type: 'string', name: 'fileName', length: 500 },
    { type: 'string', name: 'mimeType', length: 150 },
    { type: 'integer', name: 'sizeBytes', defaultValue: 0 },
    { type: 'string', name: 'hashSha256', length: 64 },
    { type: 'string', name: 'storagePath', length: 1000 },
    { type: 'string', name: 'idempotencyKey', length: 200 },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
  ],
  indexes: [
    { fields: ['tenantId', 'artifactId'] },
    { fields: ['operationId'] },
    { fields: ['tenantId', 'idempotencyKey'] },
  ],
} as CollectionOptions;
