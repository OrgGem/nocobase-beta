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
  name: 'aiBuildGuidePages',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'belongsTo',
      name: 'space',
      target: 'aiBuildGuideSpaces',
      foreignKey: 'spaceId',
    },
    {
      type: 'integer',
      name: 'sort',
      defaultValue: 0,
    },
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'string',
      name: 'slug',
    },
    {
      type: 'text',
      name: 'goal',
    },
    {
      type: 'json',
      name: 'planItem',
    },
    {
      type: 'string',
      name: 'status',
      defaultValue: 'pending',
    },
    {
      type: 'string',
      name: 'runId',
    },
    {
      type: 'boolean',
      name: 'published',
      defaultValue: false,
    },
    {
      type: 'text',
      name: 'generatedHtml',
    },
    {
      type: 'text',
      name: 'generatedMarkdown',
    },
    {
      type: 'json',
      name: 'searchMetadata',
    },
    {
      type: 'text',
      name: 'searchText',
    },
    {
      type: 'text',
      name: 'buildLog',
    },
  ],
});
