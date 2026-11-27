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
  name: 'doc_understanding_jobs',
  title: 'Document Pipeline Jobs',
  fields: [
    {
      type: 'belongsTo',
      name: 'pipeline',
      target: 'doc_understanding_pipelines',
      foreignKey: 'pipelineId',
    },
    { type: 'string', name: 'status', length: 30, defaultValue: 'pending' },
    { type: 'json', name: 'input' },
    { type: 'integer', name: 'currentStep' },
    { type: 'json', name: 'stepResults' },
    { type: 'json', name: 'finalResult' },
    { type: 'text', name: 'error' },
    { type: 'json', name: 'externalTaskIds' },
    { type: 'string', name: 'operationId', length: 64 },
    { type: 'json', name: 'waitState' },
    { type: 'json', name: 'usage' },
    { type: 'date', name: 'startedAt' },
    { type: 'date', name: 'completedAt' },
    { type: 'string', name: 'ownedBy', length: 255 },
    { type: 'date', name: 'leaseExpiresAt' },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
  ],
  indexes: [
    {
      fields: ['status'],
    },
    {
      fields: ['leaseExpiresAt'],
    },
    {
      fields: ['operationId'],
    },
  ],
} as CollectionOptions;
