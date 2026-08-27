import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'skillMetrics',
  title: 'Skill Metrics',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'skillId', type: 'bigInt', allowNull: false },
    {
      name: 'skill',
      type: 'belongsTo',
      target: 'skillDefinitions',
      foreignKey: 'skillId',
      onDelete: 'CASCADE',
    },
    { name: 'employeeUsername', type: 'string', length: 100, defaultValue: '' },
    { name: 'period', type: 'date', allowNull: false, comment: 'Daily aggregation date (UTC midnight).' },
    { name: 'executions', type: 'integer', defaultValue: 0 },
    { name: 'successes', type: 'integer', defaultValue: 0 },
    { name: 'failures', type: 'integer', defaultValue: 0 },
    { name: 'timeouts', type: 'integer', defaultValue: 0 },
    { name: 'avgDurationMs', type: 'integer', defaultValue: 0 },
    { name: 'p95DurationMs', type: 'integer', defaultValue: 0 },
    { name: 'totalDurationMs', type: 'bigInt', defaultValue: 0 },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
  indexes: [
    {
      unique: true,
      fields: ['skillId', 'employeeUsername', 'period'],
    },
    { fields: ['period'] },
    { fields: ['skillId'] },
  ],
});
