// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiVectorDatabases',
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'name',
      length: 255,
    },
    {
      // Provider type: pgvector (extensible)
      type: 'string',
      name: 'provider',
      defaultValue: 'pgvector',
    },
    {
      // Connection parameters: { host, port, username, password, database, tableName }
      type: 'json',
      name: 'connectParams',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
    },
  ],
});
