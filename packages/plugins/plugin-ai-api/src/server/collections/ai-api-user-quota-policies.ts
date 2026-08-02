import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiApiUserQuotaPolicies',
  autoGenId: true,
  fields: [
    { name: 'userId', type: 'bigInt', allowNull: false, index: true },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      targetKey: 'id',
      foreignKey: 'userId',
      constraints: false,
    },
    { name: 'enabled', type: 'boolean', defaultValue: true, index: true },
    { name: 'periodType', type: 'string', allowNull: false, defaultValue: 'monthly' },
    { name: 'timezone', type: 'string', allowNull: false, defaultValue: 'UTC' },
    { name: 'requestLimit', type: 'bigInt', allowNull: true },
    { name: 'totalTokenLimit', type: 'bigInt', allowNull: true },
    { name: 'costLimit', type: 'decimal', precision: 20, scale: 8, allowNull: true },
    { name: 'currency', type: 'string', allowNull: false, defaultValue: 'USD' },
    { name: 'rejectUnpricedModel', type: 'boolean', defaultValue: true },
    { name: 'missingUsageBehavior', type: 'string', allowNull: false, defaultValue: 'use_reserved' },
  ],
  indexes: [
    {
      fields: ['userId'],
      unique: true,
    },
  ],
});
