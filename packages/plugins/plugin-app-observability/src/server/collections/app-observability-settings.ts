import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'appObservabilitySettings',
  dataCategory: 'system',
  indexes: [{ unique: true, fields: ['key'] }],
  fields: [
    { name: 'key', type: 'string', defaultValue: 'default' },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'sampleIntervalSeconds', type: 'integer', defaultValue: 10 },
    { name: 'bucketSeconds', type: 'integer', defaultValue: 60 },
    { name: 'retentionDays', type: 'integer', defaultValue: 14 },
    { name: 'activeUserWindowSeconds', type: 'integer', defaultValue: 300 },
    { name: 'redisSnapshotsEnabled', type: 'boolean', defaultValue: false },
    { name: 'prometheusEnabled', type: 'boolean', defaultValue: false },
    { name: 'capacityThresholdCpu', type: 'integer', defaultValue: 75 },
    { name: 'capacityThresholdMemory', type: 'integer', defaultValue: 80 },
    { name: 'capacityThresholdEventLoop', type: 'integer', defaultValue: 70 },
    { name: 'capacityThresholdDbWait', type: 'integer', defaultValue: 5 },
  ],
});
