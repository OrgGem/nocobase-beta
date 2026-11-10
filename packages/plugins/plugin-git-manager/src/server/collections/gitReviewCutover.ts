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
