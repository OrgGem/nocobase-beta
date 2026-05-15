import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserWorkflowCaches',
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
      type: 'string',
      name: 'domain',
    },
    {
      type: 'text',
      name: 'urlPattern',
    },
    {
      type: 'text',
      name: 'taskIntent',
    },
    {
      type: 'string',
      name: 'taskHash',
    },
    {
      type: 'string',
      name: 'scope',
      defaultValue: 'global',
      // global | team | user | profile
    },
    {
      type: 'belongsTo',
      name: 'owner',
      target: 'users',
      foreignKey: 'ownerId',
    },
    {
      type: 'belongsTo',
      name: 'profile',
      target: 'aiBrowserProfiles',
      foreignKey: 'profileId',
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
    },
    {
      type: 'float',
      name: 'confidence',
      defaultValue: 0,
    },
    {
      type: 'integer',
      name: 'successCount',
      defaultValue: 0,
    },
    {
      type: 'integer',
      name: 'failureCount',
      defaultValue: 0,
    },
    {
      type: 'date',
      name: 'lastSuccessAt',
    },
    {
      type: 'date',
      name: 'lastFailureAt',
    },
    {
      type: 'integer',
      name: 'version',
      defaultValue: 1,
    },
    {
      type: 'json',
      name: 'metadata',
    },
    {
      type: 'hasMany',
      name: 'steps',
      target: 'aiBrowserCachedSteps',
      foreignKey: 'workflowCacheId',
    },
    {
      type: 'hasMany',
      name: 'fingerprints',
      target: 'aiBrowserElementFingerprints',
      foreignKey: 'workflowCacheId',
    },
  ],
});
