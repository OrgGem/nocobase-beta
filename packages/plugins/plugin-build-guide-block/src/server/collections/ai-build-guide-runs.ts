/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

// Collection-trigger context serializes every Run field. Keep this collection metadata-only.
export default defineCollection({
  name: 'aiBuildGuideRuns',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    { type: 'uid', name: 'id', primaryKey: true },
    { type: 'string', name: 'spaceId', index: true },
    { type: 'string', name: 'engine' },
    { type: 'string', name: 'requesterId' },
    { type: 'string', name: 'workflowKey' },
    { type: 'string', name: 'workflowRevisionId' },
    { type: 'string', name: 'executionId' },
    { type: 'string', name: 'retryOfRunId' },
    { type: 'string', name: 'status', defaultValue: 'queued' },
    { type: 'string', name: 'stage', defaultValue: 'queued' },
    { type: 'string', name: 'errorCode' },
    { type: 'integer', name: 'expectedCount', defaultValue: 0 },
    { type: 'integer', name: 'completedCount', defaultValue: 0 },
    { type: 'boolean', name: 'nativeResumePending', defaultValue: false },
    { type: 'date', name: 'startedAt' },
    { type: 'date', name: 'finishedAt' },
  ],
});
