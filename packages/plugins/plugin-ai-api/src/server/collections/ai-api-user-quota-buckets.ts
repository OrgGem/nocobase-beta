import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiApiUserQuotaBuckets',
  autoGenId: true,
  fields: [
    { name: 'policyId', type: 'bigInt', allowNull: false, index: true },
    { name: 'userId', type: 'bigInt', allowNull: false, index: true },
    { name: 'periodStart', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'periodEnd', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'requestCount', type: 'bigInt', allowNull: false, defaultValue: 0 },
    { name: 'totalTokens', type: 'bigInt', allowNull: false, defaultValue: 0 },
    { name: 'cost', type: 'decimal', precision: 20, scale: 8, allowNull: false, defaultValue: 0 },
    { name: 'reservedRequests', type: 'bigInt', allowNull: false, defaultValue: 0 },
    { name: 'reservedTokens', type: 'bigInt', allowNull: false, defaultValue: 0 },
    { name: 'reservedCost', type: 'decimal', precision: 20, scale: 8, allowNull: false, defaultValue: 0 },
  ],
  indexes: [
    {
      fields: ['policyId', 'periodStart'],
      unique: true,
    },
  ],
});
