import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'uipathAlertRules',
  title: 'UiPath Alert Rules',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'name', type: 'string', length: 200 },
    { name: 'instanceId', type: 'bigInt' },
    { name: 'instance', type: 'belongsTo', target: 'uipathInstances', foreignKey: 'instanceId' },
    // Scope: jobs | queues | logs | robots | sessions | licenses
    { name: 'scope', type: 'string', length: 30, defaultValue: 'jobs' },
    // Metric: failedJobsCount | pendingJobsAge | queueBacklog | queueSlaBreached |
    //         robotDisconnected | errorLogSpike | licenseUsage
    { name: 'metric', type: 'string', length: 50 },
    { name: 'operator', type: 'string', length: 5 },
    { name: 'threshold', type: 'float' },
    { name: 'windowMinutes', type: 'integer', defaultValue: 60 },
    { name: 'severity', type: 'string', length: 20, defaultValue: 'warning' },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'notifyChannel', type: 'string', length: 20, defaultValue: 'log' },
    { name: 'webhookUrl', type: 'string', length: 500 },
    { name: 'lastTriggeredAt', type: 'date' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
