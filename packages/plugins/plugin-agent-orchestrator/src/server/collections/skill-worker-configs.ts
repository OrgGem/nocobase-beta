import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'skillWorkerConfigs',
  title: 'Skill Worker Configs',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'retentionHours',
      type: 'integer',
      defaultValue: 24,
    },
    {
      name: 'packageWhitelist',
      type: 'text',
      defaultValue: null,
    },
    {
      name: 'customPackages',
      type: 'text',
      defaultValue: null,
    },
    {
      name: 'npmRegistryUrl',
      type: 'string',
      length: 500,
    },
    {
      name: 'npmAuthToken',
      type: 'string',
      length: 1000,
    },
    {
      name: 'pypiIndexUrl',
      type: 'string',
      length: 500,
    },
    {
      name: 'pypiTrustedHost',
      type: 'string',
      length: 255,
    },
    {
      name: 'aptMirrorUrl',
      type: 'string',
      length: 500,
    },
    {
      name: 'aptGpgKeyUrl',
      type: 'string',
      length: 500,
    },
    {
      name: 'initStatus',
      type: 'string',
      length: 20,
      defaultValue: 'idle',
    },
    {
      name: 'lastInitLog',
      type: 'text',
    },
    {
      name: 'initProgressPercent',
      type: 'integer',
      defaultValue: 0,
    },
    {
      name: 'initProgressLog',
      type: 'text',
    },
    {
      name: 'createdAt',
      type: 'date',
    },
    {
      name: 'updatedAt',
      type: 'date',
    },
  ],
} as CollectionOptions;
