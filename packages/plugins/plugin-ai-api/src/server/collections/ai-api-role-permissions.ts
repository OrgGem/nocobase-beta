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
