// SPDX-License-Identifier: Apache-2.0

export default {
  info: {
    title: 'NocoBase API - Custom LLM Plugin',
    description:
      'Registers a custom OpenAI-compatible LLM provider with the AI plugin. This plugin has no direct HTTP endpoints — all API access is through the AI API plugin gateway (`/api/ai-llm/v1/*`) using models registered under the `custom-llm` service.',
  },
  tags: [{ name: 'custom-llm', description: 'Custom LLM provider (no direct endpoints)' }],
  paths: {},
};
