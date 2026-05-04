import { defineCollection } from '@nocobase/database';
import { COLLECTION, DEFAULTS } from '../../shared/constants';

/**
 * Singleton settings record for the Carbone Template Manager plugin.
 * Always exactly one row.
 */
export default defineCollection({
  name: COLLECTION.settings,
  title: 'Carbone Settings',
  fields: [
    { name: 'endpoint', type: 'string', defaultValue: DEFAULTS.endpoint },
    { name: 'apiToken', type: 'text', allowNull: true },
    { name: 'carboneVersion', type: 'string', defaultValue: DEFAULTS.carboneVersion },
    { name: 'timeoutMs', type: 'integer', defaultValue: DEFAULTS.timeoutMs },
    { name: 'maxRetries', type: 'integer', defaultValue: DEFAULTS.maxRetries },
    { name: 'defaultOutputFormat', type: 'string', defaultValue: DEFAULTS.defaultOutputFormat },

    { name: 'enableCache', type: 'boolean', defaultValue: DEFAULTS.enableCache },
    { name: 'cacheTTL', type: 'integer', defaultValue: DEFAULTS.cacheTTL },
    { name: 'cacheMaxSize', type: 'bigInt', defaultValue: DEFAULTS.cacheMaxSize },

    { name: 'enableMonitoring', type: 'boolean', defaultValue: DEFAULTS.enableMonitoring },
    {
      name: 'monitoringRetentionDays',
      type: 'integer',
      defaultValue: DEFAULTS.monitoringRetentionDays,
    },
    { name: 'rateLimitPerMinute', type: 'integer', defaultValue: DEFAULTS.rateLimitPerMinute },
    { name: 'keepRawInDatabase', type: 'boolean', defaultValue: DEFAULTS.keepRawInDatabase },

    // FK → file-manager `storages.id` (no formal association — file-manager owns it)
    { name: 'outputStorageId', type: 'bigInt', allowNull: true },
    { name: 'cacheStorageId', type: 'bigInt', allowNull: true },
    { name: 'backupStorageId', type: 'bigInt', allowNull: true },
  ],
});
