import { defineCollection } from '@nocobase/database';

/**
 * Stores OpenAI Responses API responses for conversation state management.
 * Enables `previous_response_id` chaining and `store=true` persistence.
 *
 * Records are automatically expired after 30 days (matching OpenAI's retention).
 */
export default defineCollection({
  name: 'aiApiResponseRecords',
  dataCategory: 'runtime',
  hidden: true,
  autoGenId: true,
  fields: [
    {
      name: 'responseId',
      type: 'string',
      unique: true,
      index: true,
      comment: 'Public response ID (resp_xxx) exposed to clients',
    },
    {
      name: 'userId',
      type: 'bigInt',
      allowNull: false,
      index: true,
      comment: 'Owner of this response chain',
    },
    {
      name: 'user',
      type: 'belongsTo',
      target: 'users',
      targetKey: 'id',
      foreignKey: 'userId',
      constraints: false,
    },
    {
      name: 'model',
      type: 'string',
      allowNull: false,
      index: true,
      comment: 'Model used for this response (service/model format)',
    },
    {
      name: 'input',
      type: 'jsonb',
      allowNull: false,
      comment: 'Original Responses API input (string or array)',
    },
    {
      name: 'output',
      type: 'jsonb',
      allowNull: false,
      comment: 'Complete ResponseObject as returned to the client',
    },
    {
      name: 'previousResponseId',
      type: 'string',
      allowNull: true,
      index: true,
      comment: 'Links to the previous response in this conversation chain',
    },
    {
      name: 'metadata',
      type: 'jsonb',
      allowNull: true,
      comment: 'Client-provided metadata from the request',
    },
    {
      name: 'expiresAt',
      type: 'datetimeTz',
      allowNull: false,
      index: true,
      comment: 'Auto-delete after 30 days (OpenAI retention policy)',
    },
  ],
});
