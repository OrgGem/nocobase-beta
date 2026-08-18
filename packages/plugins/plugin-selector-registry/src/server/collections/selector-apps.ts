import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'selectorApps',
  title: 'Selector Apps',
  autoGenId: true,
  createdAt: true,
  updatedAt: true,
  indexes: [
    { name: 'selector_apps_name', fields: ['name'], unique: true },
    { name: 'selector_apps_status', fields: ['status'] },
  ],
  fields: [
    { type: 'string', name: 'name', length: 120, allowNull: false, unique: true },
    { type: 'string', name: 'displayName', length: 200, allowNull: true },
    { type: 'string', name: 'baseUrl', length: 1000, allowNull: true },
    { type: 'json', name: 'urlPatterns', defaultValue: [] },
    { type: 'string', name: 'environment', length: 40, defaultValue: 'production' },
    // Dry-run apps compute heals but never serve changed selectors to clients.
    { type: 'boolean', name: 'dryRun', defaultValue: false },
    { type: 'string', name: 'status', length: 20, defaultValue: 'active' },
    { type: 'text', name: 'description' },
    { type: 'belongsTo', name: 'createdBy', target: 'users', foreignKey: 'createdById' },
    { type: 'belongsTo', name: 'updatedBy', target: 'users', foreignKey: 'updatedById' },
  ],
});
