import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'packageAssets',
  title: 'Package Assets',
  indexes: [
    {
      fields: ['versionId', 'filename'],
      unique: true,
    },
  ],
  fields: [
    {
      name: 'filename',
      type: 'string',
      required: true,
    },
    {
      name: 'path',
      type: 'string',
    },
    {
      name: 'size',
      type: 'bigInt',
    },
    {
      name: 'checksumSha1',
      type: 'string',
    },
    {
      name: 'checksumMd5',
      type: 'string',
    },
    {
      name: 'checksumSha256',
      type: 'string',
    },
    {
      name: 'version',
      type: 'belongsTo',
      target: 'packageVersions',
      foreignKey: 'versionId',
    },
  ],
});
