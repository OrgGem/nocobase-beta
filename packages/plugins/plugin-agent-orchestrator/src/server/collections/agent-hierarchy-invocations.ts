// SPDX-License-Identifier: Apache-2.0
import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentHierarchyInvocations',
  title: 'Agent Hierarchy Invocations',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'ownerId', type: 'bigInt', allowNull: false },
    { name: 'rootSessionId', type: 'string', length: 100, allowNull: false },
    { name: 'parentSessionId', type: 'string', length: 100, allowNull: false },
    { name: 'parentEmployee', type: 'string', length: 200, allowNull: false },
    { name: 'parentToolCallId', type: 'string', length: 200, allowNull: false },
    { name: 'childSessionId', type: 'string', length: 100 },
    { name: 'employeeUsername', type: 'string', length: 200, allowNull: false },
    { name: 'role', type: 'string', length: 30, allowNull: false },
    { name: 'questionHash', type: 'string', length: 64, allowNull: false },
    { name: 'snapshot', type: 'json', allowNull: false },
    { name: 'status', type: 'string', length: 30, allowNull: false, defaultValue: 'reserved' },
    { name: 'claimToken', type: 'string', length: 100 },
    { name: 'result', type: 'json' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [
    { unique: true, fields: ['parentSessionId', 'parentToolCallId'] },
    { fields: ['rootSessionId', 'ownerId'] },
    { fields: ['status', 'updatedAt'] },
  ],
});
