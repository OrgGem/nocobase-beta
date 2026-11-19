// SPDX-License-Identifier: Apache-2.0
import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentRoutingGraphLocks',
  autoGenId: false,
  fields: [
    { name: 'key', type: 'string', length: 40, primaryKey: true, allowNull: false },
    { name: 'marker', type: 'integer', allowNull: false, defaultValue: 0 },
  ],
});
