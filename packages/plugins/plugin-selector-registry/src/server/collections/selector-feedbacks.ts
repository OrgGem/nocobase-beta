import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'selectorFeedbacks',
  title: 'Selector Feedbacks',
  autoGenId: true,
  createdAt: true,
  updatedAt: false,
  indexes: [
    { name: 'selector_feedbacks_key_created', fields: ['elementKey', 'createdAt'] },
    { name: 'selector_feedbacks_app_outcome', fields: ['appId', 'outcome'] },
  ],
  fields: [
    {
      type: 'belongsTo',
      name: 'entry',
      target: 'selectorEntries',
      foreignKey: 'entryId',
      onDelete: 'SET NULL',
    },
    { type: 'bigInt', name: 'appId', allowNull: true },
    { type: 'string', name: 'elementKey', length: 64, allowNull: false },
    { type: 'text', name: 'selectorUsed', allowNull: true },
    { type: 'string', name: 'outcome', length: 20, allowNull: false },
    { type: 'string', name: 'failureType', length: 30, allowNull: true },
    { type: 'boolean', name: 'signatureMatch', allowNull: true },
    { type: 'string', name: 'pageUrl', length: 1000, allowNull: true },
    { type: 'json', name: 'pageHealth', allowNull: true },
    { type: 'text', name: 'errorMessage', allowNull: true },
    { type: 'string', name: 'agentId', length: 200, allowNull: true },
    { type: 'string', name: 'runId', length: 200, allowNull: true },
  ],
});
