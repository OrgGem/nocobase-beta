/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

// Private run snapshots and results live here, outside the native trigger row and public page API.
export default defineCollection({
  name: 'aiBuildGuideRunArtifacts',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    { type: 'uid', name: 'id', primaryKey: true },
    { type: 'string', name: 'runId', index: true },
    { type: 'string', name: 'artifactKey' },
    { type: 'json', name: 'payload' },
  ],
});
