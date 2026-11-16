// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'gitReviewCutover',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'key', type: 'string', unique: true, allowNull: false },
    { name: 'state', type: 'string', allowNull: false },
    { name: 'confirmedBy', type: 'string' },
    { name: 'confirmedAt', type: 'date' },
  ],
});
