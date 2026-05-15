import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserProfiles',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'name',
    },
    {
      type: 'text',
      name: 'description',
    },
    {
      type: 'string',
      name: 'driver',
      defaultValue: 'playwright-browserless',
    },
    {
      type: 'string',
      name: 'externalProfileId',
    },
    {
      type: 'json',
      name: 'launchOptions',
      // headless, viewport, proxy, user-agent, etc.
    },
    {
      type: 'json',
      name: 'cookies',
      // Encrypted at rest in production
    },
    {
      type: 'json',
      name: 'localStorage',
    },
    {
      type: 'json',
      name: 'defaultPolicy',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
    },
    {
      type: 'belongsTo',
      name: 'owner',
      target: 'users',
      foreignKey: 'ownerId',
    },
    {
      type: 'json',
      name: 'metadata',
    },
  ],
});
