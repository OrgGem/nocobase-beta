import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiApiModelPrices',
  autoGenId: true,
  fields: [
    { name: 'llmService', type: 'string', allowNull: false, index: true },
    { name: 'provider', type: 'string', allowNull: false, index: true },
    { name: 'model', type: 'string', allowNull: false, index: true },
    { name: 'currency', type: 'string', allowNull: false, defaultValue: 'USD' },
    { name: 'inputPricePerMillionTokens', type: 'decimal', precision: 20, scale: 10, allowNull: false },
    { name: 'outputPricePerMillionTokens', type: 'decimal', precision: 20, scale: 10, allowNull: false },
    { name: 'fixedCostPerRequest', type: 'decimal', precision: 20, scale: 10, allowNull: false, defaultValue: 0 },
    { name: 'effectiveFrom', type: 'datetimeTz', allowNull: false, index: true },
    { name: 'effectiveTo', type: 'datetimeTz', allowNull: true, index: true },
    { name: 'enabled', type: 'boolean', defaultValue: true, index: true },
    { name: 'notes', type: 'text', allowNull: true },
  ],
  indexes: [
    {
      fields: ['llmService', 'model', 'effectiveFrom'],
      unique: true,
    },
  ],
});
