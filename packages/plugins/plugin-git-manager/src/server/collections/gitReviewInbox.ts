// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitReviewInbox',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'projectKey', type: 'string', allowNull: false, index: true },
    { name: 'repositoryId', type: 'integer', allowNull: false },
    { name: 'reviewId', type: 'integer', allowNull: false, unique: true },
    { name: 'legacyReviewId', type: 'integer', unique: true },
    { name: 'eventKey', type: 'string', unique: true },
    { name: 'queuedAt', type: 'date', allowNull: false },
    { name: 'recoveredBy', type: 'string' },
    { name: 'recoveredAt', type: 'date' },
    { name: 'state', type: 'string', allowNull: false, defaultValue: 'queued' },
    { name: 'blockedReason', type: 'string' },
    { name: 'payload', type: 'json', allowNull: false },
  ],
});
