import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistryDownloads',
  title: 'Skill Registry Downloads',
  autoGenId: true,
  createdAt: true,
  indexes: [
    { name: 'skill_registry_downloads_version_created', fields: ['versionId', 'createdAt'] },
    { name: 'skill_registry_downloads_package_created', fields: ['packageId', 'createdAt'] },
    { name: 'skill_registry_downloads_ip_created', fields: ['clientIpHash', 'createdAt'] },
  ],
  fields: [
    {
      type: 'belongsTo',
      name: 'package',
      target: 'skillRegistryPackages',
      foreignKey: 'packageId',
      onDelete: 'RESTRICT',
    },
    {
      type: 'belongsTo',
      name: 'version',
      target: 'skillRegistryVersions',
      foreignKey: 'versionId',
      onDelete: 'RESTRICT',
    },
    { type: 'string', name: 'requestId', length: 100, allowNull: false },
    { type: 'string', name: 'clientIpHash', length: 100, allowNull: false },
    { type: 'string', name: 'userAgentHash', length: 100, allowNull: true },
    { type: 'string', name: 'outcome', length: 24, allowNull: false },
    { type: 'bigInt', name: 'bytesServed', allowNull: true },
  ],
});
