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
  name: 'sharedForms',
  filterTargetKey: 'key',
  migrationRules: ['overwrite', 'schema-only'],
  createdBy: true,
  updatedBy: true,
  fields: [
    {
      type: 'uid',
      name: 'key',
      unique: true,
    },
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'string',
      name: 'type',
    },
    {
      type: 'string',
      name: 'collection',
    },
    {
      type: 'string',
      name: 'description',
    },
    {
      type: 'boolean',
      name: 'enabled',
    },
    {
      type: 'belongsToMany',
      name: 'allowedRoles',
      target: 'roles',
      sourceKey: 'key',
      foreignKey: 'sharedFormKey',
      targetKey: 'name',
      otherKey: 'roleName',
      through: 'sharedFormsRoles',
      onDelete: 'CASCADE',
    },
  ],
});
