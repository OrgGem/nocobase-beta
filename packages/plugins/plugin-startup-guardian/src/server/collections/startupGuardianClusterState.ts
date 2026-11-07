/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export default {
  name: 'startupGuardianClusterState',
  hidden: true,
  autoGenId: true,
  createdAt: false,
  updatedAt: false,
  indexes: [{ unique: true, fields: ['appId', 'deploymentId'] }],
  fields: [
    { name: 'appId', type: 'string', length: 120, allowNull: false },
    { name: 'deploymentId', type: 'string', length: 120, allowNull: false },
    { name: 'revision', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'fence', type: 'bigInt', defaultValue: 0, allowNull: false },
    { name: 'drainRevision', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'decisionRevision', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'policyRevision', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'ownerToken', type: 'string', length: 200, allowNull: true },
    { name: 'ownerNodeId', type: 'string', length: 120, allowNull: true },
    { name: 'ownerLeaseExpiresAt', type: 'date', allowNull: true },
    { name: 'phase', type: 'string', length: 32, defaultValue: 'ready', allowNull: false },
    { name: 'expectedMembers', type: 'json', allowNull: false },
    { name: 'policy', type: 'json', allowNull: false },
    { name: 'campaignId', type: 'string', length: 64, allowNull: false },
    { name: 'quarantineAttempts', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'maxQuarantineAttempts', type: 'integer', defaultValue: 2, allowNull: false },
    { name: 'pendingDecision', type: 'json', allowNull: true },
    { name: 'quarantine', type: 'json', allowNull: true },
    { name: 'retryRequest', type: 'json', allowNull: true },
    { name: 'incident', type: 'json', allowNull: true },
    { name: 'detail', type: 'text', allowNull: true },
  ],
};
