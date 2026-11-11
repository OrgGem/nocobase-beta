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
  name: 'agentGovernanceAuditEvents',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'action', type: 'string', length: 40, allowNull: false },
    { name: 'actorId', type: 'bigInt' },
    { name: 'userId', type: 'bigInt' },
    { name: 'departmentId', type: 'string', length: 20 },
    { name: 'employeeUsername', type: 'string', length: 100 },
    { name: 'policyId', type: 'bigInt' },
    { name: 'versionId', type: 'bigInt' },
    { name: 'createdAt', type: 'date' },
  ],
  indexes: [{ fields: ['createdAt'] }, { fields: ['policyId', 'createdAt'] }],
});
