/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export default {
  info: {
    title: 'NocoBase API - Custom LLM Plugin',
    description:
      'Registers a custom OpenAI-compatible LLM provider with the AI plugin. This plugin has no direct HTTP endpoints — all API access is through the AI API plugin gateway (`/api/ai-llm/v1/*`) using models registered under the `custom-llm` service.',
  },
  tags: [{ name: 'custom-llm', description: 'Custom LLM provider (no direct endpoints)' }],
  paths: {},
};
