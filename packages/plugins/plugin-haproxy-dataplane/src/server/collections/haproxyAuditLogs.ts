// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';
import { COLLECTIONS } from '../../shared/constants';

export default defineCollection({
  name: COLLECTIONS.auditLogs,
  title: 'HAProxy Audit Logs',
  autoGenId: true,
  createdAt: true,
  updatedAt: false,
  indexes: [{ fields: ['connectionId'] }, { fields: ['category'] }],
  fields: [
    {
      type: 'bigInt',
      name: 'connectionId',
      allowNull: true,
    },
    {
      type: 'string',
      name: 'connectionName',
      allowNull: true,
    },
    {
      type: 'string',
      name: 'category',
      allowNull: false,
    },
    {
      type: 'string',
      name: 'action',
      allowNull: false,
    },
    {
      type: 'string',
      name: 'target',
      allowNull: true,
    },
    {
      type: 'string',
      name: 'status',
      allowNull: false,
      defaultValue: 'success',
    },
    {
      type: 'text',
      name: 'detail',
      allowNull: true,
    },
    {
      type: 'bigInt',
      name: 'actorUserId',
      allowNull: true,
    },
    {
      type: 'string',
      name: 'actorName',
      allowNull: true,
    },
  ],
});
