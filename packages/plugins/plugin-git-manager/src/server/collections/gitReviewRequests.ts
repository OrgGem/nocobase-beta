// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitReviewRequests',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'inboxId', type: 'integer', allowNull: false, unique: true },
    { name: 'reviewId', type: 'integer', allowNull: false },
    { name: 'repositoryId', type: 'integer', allowNull: false },
    { name: 'flowId', type: 'integer', allowNull: false },
    { name: 'workflowId', type: 'bigInt', allowNull: false },
    { name: 'workflowKey', type: 'string' },
    { name: 'eventType', type: 'string', allowNull: false },
    { name: 'executionId', type: 'bigInt', unique: true },
    { name: 'fenced', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'llmClaims', type: 'json' },
    { name: 'resultFingerprint', type: 'string' },
    { name: 'postClaim', type: 'string' },
    { name: 'postClaimedAt', type: 'date' },
    { name: 'postResetBy', type: 'string' },
    { name: 'postResetAt', type: 'date' },
    { name: 'aiSettled', type: 'boolean', allowNull: false, defaultValue: false },
  ],
});
