/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

/**
 * Per-model metadata overrides surfaced through the OpenAI-compatible GET /v1/models
 * endpoint. Lets an admin correct or supply values that the upstream provider either
 * reports incorrectly (e.g. an inflated context window) or omits entirely.
 *
 * A row is keyed by (llmService, model). All override fields are nullable — a null
 * value means "do not override this attribute", so an admin can override just the
 * context window without touching anything else.
 */
export default defineCollection({
  name: 'aiApiModelMetadata',
  autoGenId: true,
  fields: [
    { name: 'llmService', type: 'string', allowNull: false, index: true },
    { name: 'model', type: 'string', allowNull: false, index: true },
    {
      name: 'contextWindow',
      type: 'integer',
      allowNull: true,
      comment:
        'Override for the model context window (input+output token capacity). Returned as context_window / context_length.',
    },
    {
      name: 'maxCompletionTokens',
      type: 'integer',
      allowNull: true,
      comment: 'Override for the maximum output tokens. Returned as max_completion_tokens.',
    },
    {
      name: 'ownedByOverride',
      type: 'string',
      allowNull: true,
      comment: 'Override for the owned_by field in the OpenAI model object.',
    },
    {
      name: 'displayName',
      type: 'string',
      allowNull: true,
      comment: 'Friendly display name returned as display_name / name in the model object.',
    },
    {
      name: 'description',
      type: 'text',
      allowNull: true,
      comment: 'Human-readable description returned as description in the model object.',
    },
    {
      name: 'systemPrompt',
      type: 'text',
      allowNull: true,
      comment:
        'Initial system prompt prepended as the first system message of every request for this model. Never replaces the client system prompt.',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
      index: true,
      comment: 'When false, the model is hidden from /v1/models and reported as active:false.',
    },
  ],
  indexes: [
    {
      fields: ['llmService', 'model'],
      unique: true,
    },
  ],
});
