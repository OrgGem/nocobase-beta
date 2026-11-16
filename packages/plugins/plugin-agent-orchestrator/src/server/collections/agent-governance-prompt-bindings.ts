// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentGovernancePromptBindings',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'userId', type: 'bigInt', allowNull: false },
    { name: 'employeeUsername', type: 'string', length: 100, allowNull: false },
    { name: 'originalPrompt', type: 'text' },
    { name: 'originalRowExisted', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'contentHash', type: 'string', length: 64, allowNull: false },
    { name: 'policyVersions', type: 'json', allowNull: false, defaultValue: [] },
    { name: 'departmentId', type: 'string', length: 20 },
    { name: 'appliedById', type: 'bigInt' },
    { name: 'appliedAt', type: 'date' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['userId', 'employeeUsername'] }],
});
