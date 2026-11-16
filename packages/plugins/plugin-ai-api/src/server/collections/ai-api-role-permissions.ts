// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiApiRolePermissions',
  autoGenId: true,
  fields: [
    {
      name: 'roleName',
      type: 'string',
      unique: true,
      comment: 'Role name (links to roles.name)',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: false,
      comment: 'Whether this role can use the AI API at all',
    },
    {
      name: 'allowAllEmployees',
      type: 'boolean',
      defaultValue: true,
      comment: 'If true, the role may use any AI Employee. If false, only those in allowedEmployees.',
    },
    {
      name: 'allowedEmployees',
      type: 'json',
      defaultValue: [],
      comment: 'Array of AI Employee usernames this role is allowed to use (when allowAllEmployees=false)',
    },
  ],
});
