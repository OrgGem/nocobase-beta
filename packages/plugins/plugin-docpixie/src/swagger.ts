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
    title: 'NocoBase API - DocPixie Plugin',
    description: 'Document AI analysis, RAG query, and configuration management',
  },
  tags: [{ name: 'docpixie', description: 'Document processing and RAG query operations' }],
  paths: {
    '/docpixie:listDocuments': {
      get: {
        tags: ['docpixie'],
        summary: 'List processed documents',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          {
            name: 'status',
            in: 'query',
            description: 'Filter by processing status',
            schema: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
          },
        ],
        responses: {
          200: {
            description: 'List of documents',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/DocpixieDocument' } },
                    meta: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        page: { type: 'integer' },
                        pageSize: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/docpixie:getDocument': {
      get: {
        tags: ['docpixie'],
        summary: 'Get document details',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'filterByTk',
            in: 'query',
            required: true,
            schema: { type: 'integer' },
            description: 'Document ID',
          },
        ],
        responses: {
          200: {
            description: 'Document details including pages',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DocpixieDocument' },
              },
            },
          },
          404: { description: 'Document not found' },
        },
      },
    },
    '/docpixie:processDocument': {
      post: {
        tags: ['docpixie'],
        summary: 'Submit a document for AI processing',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  filePath: {
                    type: 'string',
                    description: 'Path to the file (from attachments or storage)',
                  },
                  name: { type: 'string', description: 'Display name for the document' },
                },
                required: ['filePath', 'name'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Document queued for processing',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DocpixieDocument' },
              },
            },
          },
        },
      },
    },
    '/docpixie:deleteDocument': {
      delete: {
        tags: ['docpixie'],
        summary: 'Delete a document',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'filterByTk',
            in: 'query',
            required: true,
            schema: { type: 'integer' },
            description: 'Document ID',
          },
        ],
        responses: {
          200: { description: 'Document deleted' },
          404: { description: 'Document not found' },
        },
      },
    },
    '/docpixie:query': {
      post: {
        tags: ['docpixie'],
        summary: 'RAG query over processed documents',
        description:
          'Performs retrieval-augmented generation (RAG) over one or more processed documents using the configured LLM.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Natural language question' },
                  documentIds: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: 'Document IDs to query against',
                  },
                  strategy: {
                    type: 'string',
                    enum: ['semantic', 'keyword', 'hybrid'],
                    default: 'hybrid',
                    description: 'Retrieval strategy',
                  },
                  conversationHistory: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        role: { type: 'string', enum: ['user', 'assistant'] },
                        content: { type: 'string' },
                      },
                    },
                    description: 'Optional prior conversation turns for context',
                  },
                },
                required: ['query', 'documentIds'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'RAG query result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    answer: { type: 'string' },
                    sources: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          documentId: { type: 'integer' },
                          pageNumber: { type: 'integer' },
                          excerpt: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/docpixie:getConfig': {
      get: {
        tags: ['docpixie'],
        summary: 'Get DocPixie configuration',
        security: [{ BearerAuth: [] }],
        responses: {
          200: {
            description: 'Current DocPixie configuration',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DocpixieConfig' },
              },
            },
          },
        },
      },
    },
    '/docpixie:updateConfig': {
      post: {
        tags: ['docpixie'],
        summary: 'Update DocPixie configuration',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DocpixieConfig' },
            },
          },
        },
        responses: {
          200: { description: 'Configuration updated' },
        },
      },
    },
  },
  components: {
    schemas: {
      DocpixieDocument: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          originalPath: { type: 'string' },
          storagePath: { type: 'string' },
          fileType: { type: 'string', example: 'pdf' },
          pageCount: { type: 'integer' },
          summary: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'processing', 'completed', 'failed'],
          },
          extractionMethod: { type: 'string' },
          metadata: { type: 'object' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          pages: {
            type: 'array',
            items: { $ref: '#/components/schemas/DocpixiePage' },
          },
        },
      },
      DocpixiePage: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          pageNumber: { type: 'integer' },
          imagePath: { type: 'string' },
          structuredText: { type: 'string' },
          regions: { type: 'object' },
          hasTables: { type: 'boolean' },
          hasFigures: { type: 'boolean' },
          headings: { type: 'array', items: { type: 'string' } },
          extractionMethod: { type: 'string' },
          metadata: { type: 'object' },
        },
      },
      DocpixieConfig: {
        type: 'object',
        properties: {
          llmServiceName: { type: 'string', description: 'Primary LLM service for text analysis' },
          visionLlmServiceName: { type: 'string', description: 'Vision LLM service for image/figure analysis' },
          analysisStrategy: {
            type: 'string',
            enum: ['text-only', 'vision', 'hybrid'],
            description: 'Document analysis strategy',
          },
          ocrProvider: { type: 'string', enum: ['none', 'tesseract', 'custom'] },
          ocrApiEndpoint: { type: 'string' },
          ocrApiKey: { type: 'string', writeOnly: true },
          maxPagesPerTask: { type: 'integer', description: 'Max pages processed per task batch' },
          maxTasksPerPlan: { type: 'integer', description: 'Max parallel tasks per processing plan' },
        },
      },
    },
  },
};
