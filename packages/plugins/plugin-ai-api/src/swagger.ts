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
    title: 'NocoBase API - AI API Plugin',
    description: 'OpenAI-compatible AI gateway and configuration API',
  },
  tags: [
    { name: 'aiApiConfig', description: 'AI API configuration management' },
    { name: 'ai-llm', description: 'OpenAI-compatible LLM gateway (prefix: /api/ai-llm/v1)' },
  ],
  paths: {
    '/aiApiConfig:get': {
      get: {
        tags: ['aiApiConfig'],
        summary: 'Get AI API configuration',
        security: [{ BearerAuth: [] }],
        responses: {
          200: {
            description: 'Current AI API configuration',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AiApiConfig' },
              },
            },
          },
        },
      },
    },
    '/aiApiConfig:save': {
      post: {
        tags: ['aiApiConfig'],
        summary: 'Save AI API configuration',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AiApiConfig' },
            },
          },
        },
        responses: {
          200: { description: 'Configuration saved successfully' },
        },
      },
    },
    '/ai-llm/v1/models': {
      get: {
        tags: ['ai-llm'],
        summary: 'List available models',
        description:
          'Returns the LLM models available to the authenticated caller across registered services. Model IDs are formatted as `serviceName/modelId`.\n\n' +
          "The catalog is user-scoped: it starts from `enabledLlmServices` in the AI API configuration, then narrows to the caller's " +
          'usage group settings (`allowedLlmServices` / `allowedModels`). Group settings can only narrow the global whitelist, never ' +
          'widen it, so two users may receive different lists from the same request.',
        security: [{ BearerAuth: [] }],
        responses: {
          200: {
            description: 'List of available models',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ModelObject' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/ai-llm/v1/models/{id}': {
      get: {
        tags: ['ai-llm'],
        summary: 'Get model details',
        description:
          'User-scoped in the same way as `GET /v1/models`: a model the caller is not granted is reported as not found rather than disclosed.',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Model ID in format `serviceName/modelId`',
            schema: { type: 'string', example: 'openai/gpt-4o' },
          },
        ],
        responses: {
          200: {
            description: 'Model details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ModelObject' },
              },
            },
          },
          404: { description: 'Model not found, or not available to this user' },
        },
      },
    },
    '/ai-llm/v1/chat/completions': {
      post: {
        tags: ['ai-llm'],
        summary: 'Chat completions',
        description:
          'OpenAI-compatible chat completions endpoint. Supports streaming (`stream: true`). Use header `X-AI-Mode: llm` (default) or `X-AI-Mode: agent` to switch between direct LLM and agent mode.',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'X-AI-Mode',
            in: 'header',
            required: false,
            description: 'AI mode: `llm` (default) or `agent`',
            schema: { type: 'string', enum: ['llm', 'agent'], default: 'llm' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Chat completion response (or SSE stream when `stream: true`)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatCompletionResponse' },
              },
              'text/event-stream': {
                schema: { type: 'string', description: 'SSE stream of completion chunks' },
              },
            },
          },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
    '/ai-llm/v1/completions': {
      post: {
        tags: ['ai-llm'],
        summary: 'Text completions (legacy)',
        description: 'Legacy text completions for LiteLLM compatibility.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  model: { type: 'string' },
                  prompt: { type: 'string' },
                  max_tokens: { type: 'integer' },
                  stream: { type: 'boolean', default: true },
                },
                required: ['model', 'prompt'],
              },
            },
          },
        },
        responses: {
          200: { description: 'Completion response' },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
    '/ai-llm/v1/embeddings': {
      post: {
        tags: ['ai-llm'],
        summary: 'Generate embeddings',
        description: 'OpenAI-compatible embeddings endpoint.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  model: { type: 'string', example: 'openai/text-embedding-ada-002' },
                  input: {
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                  },
                },
                required: ['model', 'input'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Embedding vectors',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          object: { type: 'string', example: 'embedding' },
                          embedding: { type: 'array', items: { type: 'number' } },
                          index: { type: 'integer' },
                        },
                      },
                    },
                    model: { type: 'string' },
                    usage: {
                      type: 'object',
                      properties: {
                        prompt_tokens: { type: 'integer' },
                        total_tokens: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
  },
  components: {
    schemas: {
      AiApiConfig: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['llm', 'agent'],
            description: 'Default AI mode',
          },
          defaultAiEmployee: {
            type: 'string',
            description: 'Default AI employee name (agent mode only; direct LLM mode ignores it)',
          },
          defaultLlmService: { type: 'string', description: 'Default LLM service name' },
          enabledLlmServices: {
            type: 'array',
            items: { type: 'string' },
            description:
              'List of enabled LLM service names. This is the outer bound for every caller; usage group settings can only narrow it further.',
          },
          maxRequestBodyMb: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 10,
            description:
              'Max request body size in megabytes. Requests above this return 413. ' +
              'The gateway buffers each body in memory, so values above 100 are rejected.',
          },
          pdfRenderPagesAsImages: {
            type: 'boolean',
            default: false,
            description:
              'When true, PDF file/file_url blocks are rendered to per-page PNG images and sent as image_url blocks. ' +
              'Requires a registered PdfToImageRenderer. When false or no renderer is available, PDFs are forwarded as file blocks.',
          },
        },
      },
      ModelObject: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'openai/gpt-4o', description: 'Model ID (serviceName/modelId)' },
          object: { type: 'string', example: 'model' },
          created: { type: 'integer' },
          owned_by: { type: 'string' },
        },
      },
      ContentBlock: {
        type: 'object',
        description:
          'A multimodal content block. text, image_url, file and file_url blocks are forwarded; ' +
          'file and file_url blocks are first run through the configurable file processor service.',
        properties: {
          type: { type: 'string', enum: ['text', 'image_url', 'file', 'file_url'] },
          text: { type: 'string' },
          image_url: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'An https URL or a base64 data URL, e.g. data:image/png;base64,iVBORw0KGgo...',
                example: 'data:image/png;base64,iVBORw0KGgo...',
              },
              detail: { type: 'string', enum: ['auto', 'low', 'high'] },
            },
            required: ['url'],
          },
          file: {
            type: 'object',
            properties: {
              file_data: {
                type: 'string',
                description: 'A base64 data URL, e.g. data:application/pdf;base64,JVBERi0...',
                example: 'data:application/pdf;base64,JVBERi0...',
              },
              filename: { type: 'string' },
              mime_type: {
                type: 'string',
                description: 'MIME type of the file, e.g. application/pdf',
                example: 'application/pdf',
              },
            },
            required: ['file_data'],
          },
          file_url: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description:
                  'An http(s) URL pointing to a file. The gateway downloads the file and converts it to a file block.',
                example: 'https://example.com/document.pdf',
              },
            },
            required: ['url'],
          },
        },
        required: ['type'],
      },
      ChatMessage: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
          content: {
            description:
              'Plain text, or an array of content blocks for multimodal requests. ' +
              'Inline base64 images inflate the payload by about 33%; see "Max request body size" in the gateway settings.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { $ref: '#/components/schemas/ContentBlock' } }],
          },
          name: { type: 'string' },
          tool_call_id: { type: 'string' },
          tool_calls: { type: 'array', items: { $ref: '#/components/schemas/ToolCall' } },
        },
        required: ['role', 'content'],
      },
      ChatCompletionRequest: {
        type: 'object',
        properties: {
          model: { type: 'string', example: 'openai/gpt-4o' },
          messages: { type: 'array', items: { $ref: '#/components/schemas/ChatMessage' } },
          stream: { type: 'boolean', default: true },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          max_tokens: { type: 'integer' },
          top_p: { type: 'number' },
          frequency_penalty: { type: 'number' },
          presence_penalty: { type: 'number' },
          tools: { type: 'array', items: { $ref: '#/components/schemas/ToolDefinition' } },
          tool_choice: {
            description: 'OpenAI-compatible tool choice: auto, none, required, or a named function choice.',
            oneOf: [{ type: 'string', enum: ['auto', 'none', 'required'] }, { type: 'object' }],
          },
        },
        required: ['model', 'messages'],
      },
      ChatCompletionResponse: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          object: { type: 'string', example: 'chat.completion' },
          created: { type: 'integer' },
          model: { type: 'string' },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                message: { $ref: '#/components/schemas/ChatMessage' },
                finish_reason: { type: 'string', enum: ['stop', 'length', 'tool_calls'] },
              },
            },
          },
          usage: {
            type: 'object',
            properties: {
              prompt_tokens: { type: 'integer' },
              completion_tokens: { type: 'integer' },
              total_tokens: { type: 'integer' },
              prompt_tokens_details: {
                type: 'object',
                properties: {
                  cached_tokens: { type: 'integer' },
                },
              },
            },
          },
        },
      },
      ToolDefinition: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['function'] },
          function: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              parameters: { type: 'object' },
            },
            required: ['name', 'parameters'],
          },
        },
        required: ['type', 'function'],
      },
      ToolCall: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['function'] },
          function: {
            type: 'object',
            properties: { name: { type: 'string' }, arguments: { type: 'string' } },
          },
        },
      },
    },
  },
};
