// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';
import { COLLECTIONS } from '../../shared/constants';

export default defineCollection({
  name: COLLECTIONS.revisions,
  title: 'HAProxy Config Revisions',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  indexes: [{ fields: ['connectionId'] }],
  fields: [
    {
      type: 'bigInt',
      name: 'connectionId',
      allowNull: false,
    },
    {
      type: 'string',
      name: 'connectionName',
      allowNull: false,
    },
    {
      type: 'integer',
      name: 'configVersion',
      allowNull: true,
    },
    {
      type: 'string',
      name: 'checksum',
      allowNull: true,
    },
    {
      type: 'text',
      name: 'rawContent',
      allowNull: false,
    },
    {
      type: 'string',
      name: 'source',
      allowNull: false,
      defaultValue: 'manual_snapshot',
    },
    {
      type: 'string',
      name: 'summary',
      allowNull: true,
    },
    {
      type: 'integer',
      name: 'lineCount',
      allowNull: false,
      defaultValue: 0,
    },
    {
      type: 'integer',
      name: 'byteSize',
      allowNull: false,
      defaultValue: 0,
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
