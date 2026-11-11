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
  name: 'agentGovernancePolicies',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'policyKey', type: 'string', length: 512, allowNull: false, unique: true },
    { name: 'scope', type: 'string', length: 20, allowNull: false },
    { name: 'scopeId', type: 'string', length: 200, allowNull: false },
    { name: 'employeeUsername', type: 'string', length: 100 },
    { name: 'modelKey', type: 'string', length: 355 },
    { name: 'currentVersionId', type: 'bigInt' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['policyKey'] }, { fields: ['scope', 'scopeId'] }],
});
