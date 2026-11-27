// SPDX-License-Identifier: Apache-2.0

import { DocumentUnderstandingService } from '../services/DocumentUnderstandingService';
import { PipelineDef, JobState } from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildToolName(pipelineName: string): string {
  const sanitized = pipelineName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `doc_understanding.${sanitized}`;
}

function buildSchema(pipeline: PipelineDef): Record<string, unknown> {
  const baseSchema: Record<string, unknown> =
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

  if (baseSchema.type === 'object' && isRecord(baseSchema.properties)) {
    baseSchema.properties.file_urls = {
      type: 'array',
      items: { type: 'string' },
      description: 'Danh sách đường dẫn tệp/ảnh đính kèm trong NocoBase uploads',
    };
    if (!baseSchema.properties.pages) {
      baseSchema.properties.pages = {
        type: 'string',
        description: 'Dải trang chọn lọc cần xử lý (ví dụ: "1-3, 5")',
      };
    }
  }

  return baseSchema;
}

function applySchemaDefaults(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) {
    return value;
  }

  if (value === undefined && Object.prototype.hasOwnProperty.call(schema, 'default')) {
    return cloneJson(schema.default);
  }

  const isObjectSchema = schema.type === 'object' || isRecord(schema.properties);
  if (isObjectSchema) {
    const source: Record<string, unknown> = isRecord(value) ? { ...value } : {};
    const props = isRecord(schema.properties) ? schema.properties : {};

    for (const [key, propertySchema] of Object.entries(props)) {
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

function createToolForPipeline(service: DocumentUnderstandingService, pipeline: PipelineDef) {
  const stepNames = (pipeline.steps || [])
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((s) => s.name)
    .join(' → ');

  const description = [
    pipeline.description || `Thực thi pipeline "${pipeline.name}".`,
    stepNames ? `Steps: ${stepNames}` : '',
    'Trả về kết quả phân tích JSON, trạng thái chờ phê duyệt (WAITING_INPUT), hoặc Job ID.',
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

    invoke: async (_ctx: unknown, rawArgs: Record<string, unknown>) => {
      try {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const config = await service.getConfig();
        const pollInterval = Math.max(config.pollInterval || 2000, 500);
        const maxWait = Math.min(config.pollTimeout || 30000, 30000);

        const files = Array.isArray(args.file_urls)
          ? args.file_urls
              .filter((u): u is string => typeof u === 'string' && Boolean(u.trim()))
              .map((url) => ({
                url,
                fieldName: 'file',
                buffer: undefined as unknown as Buffer,
                filename: '',
                mimeType: '',
              }))
          : [];

        const hasInputSchema = Boolean(pipeline.inputSchema && Object.keys(pipeline.inputSchema).length > 0);
        let inputValue: unknown = hasInputSchema ? args : isRecord(args.input) ? args.input : args;
        if (inputValue === args) {
          const copy = { ...args };
          delete copy.file_urls;
          inputValue = copy;
        }
        if (hasInputSchema) {
          inputValue = applySchemaDefaults(inputValue, pipeline.inputSchema);
        }

        const { jobId } = await service.executePipeline(pipeline.id, isRecord(inputValue) ? inputValue : {}, files);
        const start = Date.now();

        while (Date.now() - start < maxWait) {
          const job: JobState = await service.getJobStatus(jobId);
          if (job.status === 'completed') {
            return { status: 'completed', result: job.finalResult, usage: job.usage ?? undefined };
          }
          if (job.status === 'waiting_input') {
            return {
              status: 'waiting_input',
              jobId,
              operationId: job.operationId,
              wait: job.waitState,
              message: `Tác vụ đang tạm dừng chờ người phê duyệt (WAITING_INPUT).`,
            };
          }
          if (job.status === 'failed' || job.status === 'timeout' || job.status === 'cancelled') {
            return { status: job.status, error: job.error };
          }
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        return {
          status: 'polling',
          message: `Pipeline "${pipeline.name}" đang chạy bất đồng bộ, dùng jobId để theo dõi.`,
          jobId,
        };
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function createDynamicPipelineToolsProvider(service: DocumentUnderstandingService) {
  return async (register: { registerTools: (options: unknown) => void }) => {
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
