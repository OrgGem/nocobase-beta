/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBuildGuideRunSteps',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    { type: 'uid', name: 'id', primaryKey: true },
    { type: 'string', name: 'runId', index: true },
    { type: 'string', name: 'stepKey' },
    { type: 'string', name: 'executionId' },
    { type: 'string', name: 'jobId' },
    { type: 'integer', name: 'attempt', defaultValue: 1 },
    { type: 'string', name: 'ownerToken' },
    { type: 'string', name: 'status', defaultValue: 'pending' },
    { type: 'string', name: 'artifactKey' },
    { type: 'string', name: 'errorCode' },
    { type: 'date', name: 'leaseExpiresAt' },
    { type: 'date', name: 'startedAt' },
    { type: 'date', name: 'finishedAt' },
  ],
});
