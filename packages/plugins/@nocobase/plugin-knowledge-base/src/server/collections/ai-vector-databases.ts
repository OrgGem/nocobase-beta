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
