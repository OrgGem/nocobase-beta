// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'sharedForms',
  filterTargetKey: 'key',
  migrationRules: ['overwrite', 'schema-only'],
  createdBy: true,
  updatedBy: true,
  fields: [
    { type: 'json', name: 'v2Config' },
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
