import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiBrowserCachedSteps',
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
      type: 'integer',
      name: 'order',
      defaultValue: 0,
    },
    {
      type: 'string',
      name: 'stepKey',
    },
    {
      type: 'text',
      name: 'intent',
    },
    {
      type: 'string',
      name: 'actionType',
      // goto | click | type | select | wait | extract | download
    },
    {
      type: 'string',
      name: 'targetKey',
    },
    {
      type: 'json',
      name: 'inputBinding',
    },
    {
      type: 'text',
      name: 'precondition',
    },
    {
      type: 'text',
      name: 'postcondition',
    },
    {
      type: 'integer',
      name: 'timeoutMs',
      defaultValue: 30000,
    },
    {
      type: 'json',
      name: 'retryPolicy',
      // { maxRetries: 2, backoffMs: 1000 }
    },
    {
      type: 'string',
      name: 'riskLevel',
      defaultValue: 'low',
      // low | medium | high | critical
    },
    {
      type: 'boolean',
      name: 'requiresApproval',
      defaultValue: false,
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
      type: 'text',
      name: 'lastError',
    },
  ],
});
