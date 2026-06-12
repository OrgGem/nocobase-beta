import { randomUUID } from 'crypto';
import { z } from 'zod';

import type { Application } from '@nocobase/server';
import { COLLECTION_NAME, MAX_COLLECTIONS, MIN_COLLECTIONS, SETTINGS_COLLECTION_NAME } from '../../shared/constants';
import { enqueueBuild } from '../actions/build';

/**
 * The zod input schema for the `build_visualization_block` AI tool. The shape
 * mirrors the inputs accepted by the `aiVisualizationBuilds:build` action so an
 * AI chat agent can initiate a build the same way the client form does.
 */
const buildVisualizationBlockSchema = z.object({
  requirement: z.string().describe('Natural-language description of the visualization block to build.'),
  collections: z
    .array(z.string())
    .min(MIN_COLLECTIONS)
    .max(MAX_COLLECTIONS)
    .optional()
    .describe('The selected target collection names the block should be built from.'),
  dataSource: z.string().optional().describe('The data source key. Defaults to the main data source when omitted.'),
  llmService: z.string().optional().describe('The AI/LLM service to use for generation.'),
  model: z.string().optional().describe('The model to use for generation.'),
});

/** The validated argument shape derived from {@link buildVisualizationBlockSchema}. */
type BuildVisualizationBlockArgs = z.infer<typeof buildVisualizationBlockSchema>;

/**
 * A minimal structural view of the repository methods this tool relies on. The
 * full NocoBase repository type is not imported here to keep the tool decoupled
 * from server internals; only `create` is used.
 */
interface BuildRecordRepository {
  create(options: { values: Record<string, unknown> }): Promise<{ get(key: string): unknown }>;
}

interface SettingsRepository {
  findOne(): Promise<{
    defaultDataSource?: string | null;
    defaultCollections?: unknown;
    defaultLLMService?: string | null;
    defaultModel?: string | null;
    enableAITool?: boolean | null;
    get?(key: string): unknown;
  } | null>;
}

/**
 * A minimal structural view of the invocation context passed to the tool. It is
 * intentionally narrow (rather than `any`) so the tool only depends on the
 * surface it actually uses.
 */
interface BuildVisualizationToolContext {
  app: Application & {
    db: Application['db'] & {
      getRepository(name: typeof COLLECTION_NAME): BuildRecordRepository;
      getRepository(name: typeof SETTINGS_COLLECTION_NAME): SettingsRepository;
    };
    logger: {
      error(message: string, meta?: unknown): void;
    };
  };
  auth?: {
    user?: {
      id?: number | string;
    };
  };
}

function normalizeCollections(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, MAX_COLLECTIONS);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRecordValue(record: { get?(key: string): unknown } | null | undefined, key: string): unknown {
  if (!record) {
    return undefined;
  }
  if (typeof record.get === 'function') {
    return record.get(key);
  }
  return (record as Record<string, unknown>)[key];
}

/**
 * The `build_visualization_block` AI tool. Registered via
 * `aiManager.toolsManager.registerTools` (wired in `plugin.ts` by task 7.4),
 * matching the export shape used by `plugin-build-guide-block`.
 */
export default {
  groupName: 'plugin-build-visualization',
  tool: {
    name: 'build_visualization_block',
    title: 'Build Visualization Block',
    description: 'Generate a NocoBase chart/table/form block from a requirement and selected collections.',
    execution: 'backend',
    schema: buildVisualizationBlockSchema,
    invoke: async (ctx: BuildVisualizationToolContext, args: BuildVisualizationBlockArgs) => {
      try {
        const { requirement } = args;
        const { db } = ctx.app;
        const settings = await db.getRepository(SETTINGS_COLLECTION_NAME).findOne();
        if (readRecordValue(settings, 'enableAITool') === false) {
          return { status: 'error', content: 'Build Visualization Block AI tool is disabled.' };
        }

        const collections = args.collections?.length
          ? args.collections
          : normalizeCollections(readRecordValue(settings, 'defaultCollections'));
        const dataSource = args.dataSource ?? normalizeOptionalString(readRecordValue(settings, 'defaultDataSource'));
        const llmService = args.llmService ?? normalizeOptionalString(readRecordValue(settings, 'defaultLLMService'));
        const model = args.model ?? normalizeOptionalString(readRecordValue(settings, 'defaultModel'));

        if (collections.length < MIN_COLLECTIONS) {
          return { status: 'error', content: 'At least one collection is required.' };
        }
        if (!llmService || !model) {
          return { status: 'error', content: 'AI service and model are required.' };
        }

        const repo = db.getRepository(COLLECTION_NAME);
        const createdById = ctx.auth?.user?.id;
        const runId = randomUUID();

        const record = await repo.create({
          values: {
            requirement,
            collections,
            dataSource,
            primaryCollection: collections[0],
            llmService,
            model,
            status: 'building',
            buildPhase: 'queued',
            buildRunId: runId,
            buildQueuedAt: new Date(),
            ...(createdById !== undefined ? { createdById } : {}),
          },
        });

        const id = record.get('id');
        const buildId = String(id);
        await enqueueBuild(ctx.app, {
          buildId,
          runId,
          userId: createdById ?? null,
          queuedAt: new Date().toISOString(),
        });

        return {
          status: 'success',
          content: {
            id,
            collection: COLLECTION_NAME,
            status: 'building',
            buildPhase: 'queued',
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.app.logger.error(`[build_visualization_block] Error: ${message}`, err);
        return { status: 'error', content: message };
      }
    },
  },
};
