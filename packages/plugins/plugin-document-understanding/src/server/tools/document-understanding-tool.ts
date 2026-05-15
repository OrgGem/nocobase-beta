import { DocumentUnderstandingService } from '../services/DocumentUnderstandingService';
import { PipelineDef, JobState } from '../types';

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Build tool name from pipeline name.
 * Convention: doc_understanding.pipeline.<sanitized_name>
 */
function buildToolName(pipelineName: string): string {
  const sanitized = pipelineName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `doc_understanding.${sanitized}`;
}

function buildSchema(pipeline: PipelineDef) {
  const baseSchema =
    pipeline.inputSchema && Object.keys(pipeline.inputSchema).length > 0
      ? cloneJson(pipeline.inputSchema)
      : {
          type: 'object',
          properties: {
            input: {
              type: 'object',
              description: 'Dữ liệu đầu vào cho pipeline (JSON)',
            },
          },
        };

  // Add file_urls to allow AI to pass uploaded files
  if (baseSchema.type === 'object' && baseSchema.properties) {
    baseSchema.properties.file_urls = {
      type: 'array',
      items: { type: 'string' },
      description: 'Danh sách các URL của file/ảnh đính kèm trong chat',
    };
  }

  return baseSchema;
}

function applySchemaDefaults(value: any, schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return value;
  }

  if (value === undefined && Object.prototype.hasOwnProperty.call(schema, 'default')) {
    return cloneJson(schema.default);
  }

  const isObjectSchema = schema.type === 'object' || schema.properties;
  if (isObjectSchema) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};

    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      const currentValue = source[key];
      const nextValue = applySchemaDefaults(currentValue, propertySchema);
      if (nextValue !== undefined) {
        source[key] = nextValue;
      }
    }
    return source;
  }

  if (Array.isArray(value) && schema.items) {
    return value.map((item) => applySchemaDefaults(item, schema.items));
  }

  return value;
}

/**
 * Create a single tool definition for one pipeline.
 */
function createToolForPipeline(service: DocumentUnderstandingService, pipeline: PipelineDef) {
  const stepNames = (pipeline.steps || [])
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((s) => s.name)
    .join(' → ');

  const description = [
    pipeline.description || `Thực thi pipeline "${pipeline.name}".`,
    stepNames ? `Steps: ${stepNames}` : '',
    'Trả về kết quả phân tích JSON hoặc Job ID nếu chạy async.',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    scope: 'CUSTOM' as const,
    execution: 'backend' as const,
    defaultPermission: 'ASK' as const,

    introduction: {
      title: `Document: ${pipeline.name}`,
      about: pipeline.description || `Xử lý tài liệu qua pipeline "${pipeline.name}".`,
    },

    definition: {
      name: buildToolName(pipeline.name),
      description,
      schema: buildSchema(pipeline),
    },

    invoke: async (ctx: any, args: any) => {
      try {
        const config = await service.getConfig();
        const pollInterval = Math.max(config.pollInterval || 2000, 1000);
        const maxWait = Math.min(config.pollTimeout || 30000, 30000);

        // Extract file URLs
        let files: any[] = [];
        if (args.file_urls && Array.isArray(args.file_urls)) {
          files = args.file_urls.map((url: string) => ({ url }));
        }

        // Clean up args if using default schema
        const hasInputSchema = pipeline.inputSchema && Object.keys(pipeline.inputSchema).length > 0;
        let input = hasInputSchema ? args : args.input || args;
        if (input === args) {
          input = { ...args };
          delete input.file_urls;
        }
        if (hasInputSchema) {
          input = applySchemaDefaults(input, pipeline.inputSchema);
        }

        const { jobId } = await service.executePipeline(pipeline.id, input, files);
        const start = Date.now();

        while (Date.now() - start < maxWait) {
          const job: JobState = await service.getJobStatus(jobId);
          if (job.status === 'completed') {
            return { status: 'completed', result: job.finalResult };
          } else if (job.status === 'failed' || job.status === 'timeout') {
            return { status: job.status, error: job.error };
          }
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        return {
          status: 'polling',
          message: `Pipeline "${pipeline.name}" đang chạy, trả về job ID để theo dõi.`,
          jobId,
        };
      } catch (err: any) {
        return { error: err.message };
      }
    },
  };
}

/**
 * Dynamic tools provider: queries all enabled pipelines and registers one tool per pipeline.
 * Called on-demand by the AI tools manager each time tools are listed.
 */
export function createDynamicPipelineToolsProvider(service: DocumentUnderstandingService) {
  return async (register: { registerTools: (options: any) => void }) => {
    try {
      if (!service.isReady()) return;

      const pipelines = await service.listPipelines();
      const enabledPipelines = pipelines.filter((p) => p.enabled);

      if (enabledPipelines.length === 0) return;

      const tools = enabledPipelines.map((pipeline) => createToolForPipeline(service, pipeline));
      register.registerTools(tools);
    } catch {
      // Silently skip — service may not be initialized yet
    }
  };
}
