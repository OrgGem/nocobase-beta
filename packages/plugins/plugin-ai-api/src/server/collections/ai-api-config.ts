/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiApiConfig',
  autoGenId: true,
  fields: [
    {
      name: 'mode',
      type: 'string',
      defaultValue: 'llm',
      comment: "API mode: 'llm' = direct LLM proxy, 'agent' = full AI Employee agent with tools/RAG",
    },
    {
      name: 'defaultAiEmployee',
      type: 'string',
      comment: 'Username of the default AI Employee for system prompt injection',
    },
    {
      name: 'defaultLlmService',
      type: 'string',
      comment: 'Name (UID) of the default LLM service. Clients can send just modelId without service prefix.',
    },
    {
      name: 'enabledLlmServices',
      type: 'json',
      defaultValue: [],
      comment: 'Array of llmService names to expose. Empty = expose all enabled services',
    },
    {
      name: 'rateLimitPerMinute',
      type: 'integer',
      defaultValue: 60,
      comment: 'Max requests per user per minute',
    },
    {
      name: 'quotaEnabled',
      type: 'boolean',
      defaultValue: false,
      comment: 'Enable per-user request, token, and cost quotas for direct LLM mode',
    },
    {
      name: 'defaultReservationOutputTokens',
      type: 'integer',
      defaultValue: 4096,
      comment: 'Output tokens reserved when a request does not specify a maximum',
    },
    {
      name: 'options',
      type: 'jsonb',
      defaultValue: {},
      comment: 'Reserved for future extensibility',
    },
  ],
});
