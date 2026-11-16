// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'sharedFormsRoles',
  migrationRules: ['overwrite', 'schema-only'],
  fields: [
    {
      type: 'string',
      name: 'sharedFormKey',
    },
    {
      type: 'string',
      name: 'roleName',
    },
  ],
});
