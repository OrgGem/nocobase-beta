import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'skillWorkerConfigs',
  title: 'Skill Worker Configs',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },

    // Registry config
    { name: 'npmRegistryUrl', type: 'string', length: 500, allowNull: true },
    { name: 'npmAuthToken', type: 'string', length: 500, allowNull: true },
    { name: 'pypiIndexUrl', type: 'string', length: 500, allowNull: true },
    { name: 'pypiTrustedHost', type: 'string', length: 200, allowNull: true },
    { name: 'aptMirrorUrl', type: 'string', length: 500, allowNull: true },
    { name: 'aptGpgKeyUrl', type: 'string', length: 500, allowNull: true },

    // Init status: 'pending' | 'running' | 'succeeded' | 'failed'
    { name: 'initStatus', type: 'string', length: 20, defaultValue: 'pending' },
    { name: 'lastInitAt', type: 'date', allowNull: true },
    { name: 'lastInitLog', type: 'text', allowNull: true },
    
    // Live progress
    { name: 'initProgressPercent', type: 'integer', defaultValue: 0 },
    { name: 'initProgressLog', type: 'text', allowNull: true },

    // Auto-generated whitelist after successful init
    // { python: ['python-docx', ...], node: ['xlsx', ...], apt: ['python3', ...] }
    { name: 'packageWhitelist', type: 'json', defaultValue: { python: [], node: [], apt: [] } },

    // User-provided custom libraries mapping
    { name: 'customPackages', type: 'json', defaultValue: { python: [], node: [] } },

    // Retention policy for execution history and storage
    { name: 'retentionHours', type: 'integer', defaultValue: 24, allowNull: false },

    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;
