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
  name: 'agentGovernancePolicyVersions',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'policyId', type: 'bigInt', allowNull: false },
    { name: 'version', type: 'integer', allowNull: false },
    { name: 'revision', type: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'status', type: 'string', length: 20, allowNull: false },
    { name: 'settings', type: 'json', allowNull: false, defaultValue: {} },
    { name: 'publishedById', type: 'bigInt' },
    { name: 'publishedAt', type: 'date' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [{ unique: true, fields: ['policyId', 'version'] }],
});
