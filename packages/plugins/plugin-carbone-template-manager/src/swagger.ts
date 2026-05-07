export default {
  openapi: '3.0.2',
  info: {
    title: 'NocoBase API - Carbone Template Manager',
    version: '1.0.0',
    description: 'API documentation for Carbone Template Manager plugin.'
  },
  paths: {
    '/carboneTemplates:render': {
      post: {
        tags: ['carboneTemplates'],
        description: 'Render a template using its ID or Name.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  templateId: { type: 'number', description: 'Template ID' },
                  name: { type: 'string', description: 'Template Name (alternative to templateId)' },
                  versionId: { type: 'number', description: 'Specific version ID to render (optional)' },
                  data: { type: 'object', description: 'Data to inject into the template' },
                  format: { type: 'string', description: 'Output format (pdf, docx, etc.)' },
                  filename: { type: 'string', description: 'Output filename' },
                  inline: { type: 'boolean', description: 'Return binary file directly instead of JSON URL' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Render successful. Returns JSON if inline=false, or binary file if inline=true.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'Direct URL to download the generated file' },
                    attachmentId: { type: 'number', description: 'NocoBase Attachment ID' },
                    format: { type: 'string' },
                    cacheHit: { type: 'boolean' }
                  }
                }
              },
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary', description: 'Returned when inline=true' }
              },
              'application/pdf': {
                schema: { type: 'string', format: 'binary', description: 'Returned when format=pdf and inline=true' }
              }
            }
          }
        }
      }
    },
    '/carboneTemplates:renderById': {
      post: {
        tags: ['carboneTemplates'],
        description: 'Render a template using its ID.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  templateId: { type: 'number', description: 'Template ID' },
                  versionId: { type: 'number', description: 'Specific version ID to render (optional)' },
                  data: { type: 'object', description: 'Data to inject into the template' },
                  format: { type: 'string', description: 'Output format (pdf, docx, etc.)' },
                  filename: { type: 'string', description: 'Output filename' },
                  inline: { type: 'boolean', description: 'Return binary file directly instead of JSON URL' }
                },
                required: ['templateId']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Render successful. Returns JSON if inline=false, or binary file if inline=true.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'Direct URL to download the generated file' },
                    attachmentId: { type: 'number', description: 'NocoBase Attachment ID' },
                    format: { type: 'string' },
                    cacheHit: { type: 'boolean' }
                  }
                }
              },
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary', description: 'Returned when inline=true' }
              },
              'application/pdf': {
                schema: { type: 'string', format: 'binary', description: 'Returned when format=pdf and inline=true' }
              }
            }
          }
        }
      }
    },
    '/carboneTemplates:renderDirect': {
      post: {
        tags: ['carboneTemplates'],
        description: 'Render an ad-hoc template uploaded via file manager.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  attachmentId: { type: 'number', description: 'File Manager attachment ID' },
                  data: { type: 'object', description: 'Data to inject' },
                  format: { type: 'string', description: 'Output format' },
                  filename: { type: 'string', description: 'Output filename' }
                },
                required: ['attachmentId']
              }
            }
          }
        },
        responses: {
          '200': { description: 'Render successful' }
        }
      }
    },
    '/carboneTemplates:upload': {
      post: {
        tags: ['carboneTemplates'],
        description: 'Upload a new Carbone template or add a new version to an existing one.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  attachmentId: { type: 'number', description: 'File Manager attachment ID of the template file' },
                  name: { type: 'string', description: 'Template name (required for new templates)' },
                  description: { type: 'string' },
                  category: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  defaultOutputFormat: { type: 'string', description: 'Default output format (e.g. pdf)' },
                  changeNote: { type: 'string', description: 'Notes for the new version' },
                  templateId: { type: 'number', description: 'If provided, adds a new version to this existing template' }
                },
                required: ['attachmentId']
              }
            }
          }
        },
        responses: {
          '200': { description: 'Upload successful' }
        }
      }
    }
  }
};
