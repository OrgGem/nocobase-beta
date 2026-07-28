import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'skillRegistryInstallations',
  title: 'Skill Registry Installations',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'registryPackageId', type: 'bigInt', allowNull: false },
    { name: 'registryVersionId', type: 'bigInt', allowNull: false, unique: true },
    { name: 'packageIdentity', type: 'string', length: 220, allowNull: false },
    { name: 'version', type: 'string', length: 64, allowNull: false },
    { name: 'channel', type: 'string', length: 20, defaultValue: 'stable' },
    { name: 'artifactDigest', type: 'string', length: 71, allowNull: false },
    { name: 'sourceSignature', type: 'text', allowNull: true },
    { name: 'updatePolicy', type: 'string', length: 20, defaultValue: 'pinned' },
    { name: 'status', type: 'string', length: 24, defaultValue: 'verifying' },
    {
      name: 'skillDefinition',
      type: 'belongsTo',
      target: 'skillDefinitions',
      foreignKey: 'skillDefinitionId',
      onDelete: 'RESTRICT',
    },
    {
      name: 'previousInstallation',
      type: 'belongsTo',
      target: 'skillRegistryInstallations',
      foreignKey: 'previousInstallationId',
      onDelete: 'SET NULL',
    },
    { name: 'lastError', type: 'text', allowNull: true },
    { name: 'installedAt', type: 'date', allowNull: true },
    { name: 'installedBy', type: 'belongsTo', target: 'users', foreignKey: 'installedById' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [
    { name: 'skill_registry_installations_package_status', fields: ['registryPackageId', 'status'] },
    { name: 'skill_registry_installations_skill_definition', fields: ['skillDefinitionId'] },
  ],
} as CollectionOptions;
