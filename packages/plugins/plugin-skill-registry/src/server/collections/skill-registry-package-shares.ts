import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillRegistryPackageShares',
  title: 'Skill Registry Package Shares',
  autoGenId: true,
  createdAt: true,
  indexes: [
    { name: 'skill_registry_shares_package_user', fields: ['packageId', 'userId'], unique: true },
    { name: 'skill_registry_shares_user', fields: ['userId'] },
  ],
  fields: [
    {
      type: 'belongsTo',
      name: 'package',
      target: 'skillRegistryPackages',
      foreignKey: 'packageId',
      onDelete: 'CASCADE',
      allowNull: false,
    },
    {
      type: 'belongsTo',
      name: 'user',
      target: 'users',
      foreignKey: 'userId',
      onDelete: 'CASCADE',
      allowNull: false,
    },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById' },
  ],
});
