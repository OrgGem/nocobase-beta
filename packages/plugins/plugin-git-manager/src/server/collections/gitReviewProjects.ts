// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitReviewProjects',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'projectKey', type: 'string', unique: true, allowNull: false },
    { name: 'activeInboxId', type: 'integer' },
    { name: 'legacyPostReviewId', type: 'integer' },
  ],
});
