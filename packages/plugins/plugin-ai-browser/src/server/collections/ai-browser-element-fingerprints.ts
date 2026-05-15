import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserElementFingerprints',
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
      type: 'belongsTo',
      name: 'workflowCache',
      target: 'aiBrowserWorkflowCaches',
      foreignKey: 'workflowCacheId',
    },
    {
      type: 'string',
      name: 'targetKey',
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
      type: 'string',
      name: 'role',
    },
    {
      type: 'string',
      name: 'accessibleName',
    },
    {
      type: 'text',
      name: 'visibleText',
    },
    {
      type: 'string',
      name: 'placeholder',
    },
    {
      type: 'string',
      name: 'labelText',
    },
    {
      type: 'text',
      name: 'cssSelector',
    },
    {
      type: 'text',
      name: 'xpath',
    },
    {
      type: 'string',
      name: 'testId',
    },
    {
      type: 'string',
      name: 'ariaSelector',
    },
    {
      type: 'text',
      name: 'textSelector',
    },
    {
      type: 'json',
      name: 'relativeHints',
    },
    {
      type: 'string',
      name: 'domPathHash',
    },
    {
      type: 'json',
      name: 'boundingBoxHint',
    },
    {
      type: 'integer',
      name: 'priority',
      defaultValue: 50,
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
      name: 'lastSeenAt',
    },
  ],
});
