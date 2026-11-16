// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserConfig',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    {
      type: 'string',
      name: 'key',
      unique: true,
      allowNull: false,
    },
    {
      type: 'text',
      name: 'value',
    },
  ],
});
