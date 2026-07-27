import { z } from 'zod';

const TOOL_NAME = 'external_rag_search';
const MAX_CONTENT_LENGTH = 4000;
const MAX_METADATA_VALUE_LENGTH = 500;
const METADATA_FIELDS = [
  'id',
  'title',
  'filename',
  'fileName',
  'name',
  'source',
  'url',
  'fileUrl',
  'sourceUrl',
  'collection',
  'collectionName',
  'recordId',
  'rowId',
  'documentId',
  'docId',
  'fileId',
  'page',
  'pageNumber',
  'chunkIndex',
] as const;

type RecordLike = Record<string, unknown>;

type Repository = {
  findOne?: (options: RecordLike) => Promise<unknown>;
};

type ToolContext = {
  app?: {
    pm?: {
      get?: (name: string) => unknown;
    };
  };
  db?: {
    getRepository?: (name: string) => Repository | undefined;
  };
  state?: RecordLike;
  _currentAIEmployee?: unknown;
};

type ToolRuntime = {
  toolCallId?: string;
};

type ResolvedAgent = {
  username: string;
  knowledgeBaseIds: string[];
};

function truncate(value: unknown, max = MAX_CONTENT_LENGTH) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function toRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordLike) : {};
}

function readModelValue(record: unknown, key: string): unknown {
  const model = record as { get?: (name: string) => unknown; [key: string]: unknown };
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function toPlain(record: unknown): RecordLike {
  const model = record as { toJSON?: () => unknown };
  return toRecord(typeof model?.toJSON === 'function' ? model.toJSON() : record);
}

function sanitizeMetadata(value: unknown): RecordLike {
  const metadata = toRecord(value);
  return Object.fromEntries(
    METADATA_FIELDS.flatMap((key) => {
      const field = metadata[key];
      if (typeof field === 'string') {
        return [[key, truncate(field, MAX_METADATA_VALUE_LENGTH)]];
      }
      if (typeof field === 'number' || typeof field === 'boolean') {
        return [[key, field]];
      }
      return [];
    }),
  );
}

function normalizeResult(result: unknown) {
  const record = toRecord(result);
  const metadata = sanitizeMetadata(record.metadata);
  const sourceId = firstString(
    record.id,
    metadata.id,
    metadata.sourceId,
    metadata.documentId,
    metadata.docId,
    metadata.fileId,
    metadata.recordId,
  );
  const filename = firstString(metadata.filename, metadata.fileName, metadata.name, metadata.title, metadata.source);

  return {
    content: truncate(record.content),
    score: Number(record.rerankScore ?? record.score ?? record.vectorScore ?? 0),
    knowledgeBaseId: record.knowledgeBaseId,
    knowledgeBaseName: record.knowledgeBaseName,
    source: {
      id: sourceId,
      filename,
      url: firstString(metadata.url, metadata.fileUrl, metadata.sourceUrl),
      collection: firstString(metadata.collection, metadata.collectionName),
      recordId: firstString(metadata.recordId, metadata.rowId),
    },
    metadata,
  };
}

function getContextAgentUsername(ctx: ToolContext): string | undefined {
  const direct = ctx._currentAIEmployee ?? ctx.state?.currentAIEmployee;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const employee = toRecord(direct);
  return firstString(employee.username, employee.name);
}

async function resolveAgentFromToolCall(ctx: ToolContext, runtime?: ToolRuntime): Promise<string | undefined> {
  const direct = getContextAgentUsername(ctx);
  if (direct) {
    return direct;
  }

  const toolCallId = runtime?.toolCallId;
  if (!toolCallId) {
    return undefined;
  }

  const toolMessage = await ctx.db?.getRepository?.('aiToolMessages')?.findOne?.({
    filter: { toolCallId },
  });
  const sessionId = firstString(readModelValue(toolMessage, 'sessionId'));
  if (!sessionId) {
    return undefined;
  }

  const conversation = await ctx.db?.getRepository?.('aiConversations')?.findOne?.({
    filter: { sessionId },
  });
  return firstString(readModelValue(conversation, 'aiEmployeeUsername'));
}

function readKnowledgeBaseIds(employee: unknown): string[] {
  const settings = toRecord(readModelValue(employee, 'knowledgeBase'));
  // NocoBase currently persists this setting as `knowledgeBaseIds`; early
  // orchestrator configurations used `knowledgeBaseKeys`. Prefer the legacy
  // value when it is populated, but fall back to the current field so either
  // configuration can enforce the same retrieval boundary.
  const legacyIds = settings.knowledgeBaseKeys;
  const ids = Array.isArray(legacyIds) && legacyIds.length ? legacyIds : settings.knowledgeBaseIds;
  return Array.isArray(ids)
    ? Array.from(
        new Set(
          ids.filter((id): id is string | number => typeof id === 'string' || typeof id === 'number').map(String),
        ),
      )
    : [];
}

async function resolveAgent(ctx: ToolContext, runtime?: ToolRuntime): Promise<ResolvedAgent | undefined> {
  const username = await resolveAgentFromToolCall(ctx, runtime);
  if (!username) {
    return undefined;
  }

  const employee = await ctx.db?.getRepository?.('aiEmployees')?.findOne?.({
    filter: { username },
  });
  if (!employee) {
    return undefined;
  }

  return {
    username,
    knowledgeBaseIds: readKnowledgeBaseIds(employee),
  };
}

function withAgentIdentity(ctx: ToolContext, username: string): ToolContext {
  const scoped = Object.create(ctx) as ToolContext;
  const employee = { username };
  scoped._currentAIEmployee = employee;
  scoped.state = {
    ...(ctx.state ?? {}),
    currentAIEmployee: employee,
  };
  return scoped;
}

export function createExternalRagSearchTool(plugin: any) {
  return {
    scope: 'CUSTOM' as const,
    execution: 'backend' as const,
    defaultPermission: 'ALLOW' as const,

    introduction: {
      title: 'External RAG Search',
      about:
        'Search NocoBase knowledge bases through plugin-knowledge-base, including EXTERNAL_RAG services that own chunking, embedding, and retrieval.',
    },

    definition: {
      name: TOOL_NAME,
      description: `Search configured knowledge bases for relevant context. Use this before answering questions that require documents, files, or datasource-backed knowledge.

The search may be served by an external RAG service. Results include content plus source identifiers such as id, filename, collection, and recordId when the external service provides them.`,
      schema: z.object({
        query: z.string().min(1).describe('Natural-language search query.'),
        knowledgeBaseIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Optional list of NocoBase knowledge base IDs to search. If omitted, all accessible KBs are searched.',
          ),
        topK: z.number().int().min(1).max(20).optional().describe('Maximum results to return. Default 5, max 20.'),
        scoreThreshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Minimum relevance score. Default is controlled by plugin-knowledge-base.'),
      }),
    },

    invoke: async (
      ctx: ToolContext,
      args: { query?: string; knowledgeBaseIds?: string[]; topK?: number; scoreThreshold?: number },
      runtime?: ToolRuntime,
    ) => {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return { status: 'error' as const, content: 'Missing required field: query.' };
      }

      const agent = await resolveAgent(ctx, runtime);
      if (!agent) {
        return {
          status: 'error' as const,
          content: 'Unable to determine the requesting AI Employee. Knowledge base search is denied.',
        };
      }
      if (!agent.knowledgeBaseIds.length) {
        return {
          status: 'error' as const,
          content: `AI Employee "${agent.username}" has no assigned knowledge bases.`,
        };
      }

      const requestedIds = Array.isArray(args.knowledgeBaseIds) ? args.knowledgeBaseIds.map(String) : undefined;
      const unauthorizedIds = requestedIds?.filter((id) => !agent.knowledgeBaseIds.includes(id)) ?? [];
      if (unauthorizedIds.length) {
        return {
          status: 'error' as const,
          content: `Knowledge base IDs are not assigned to AI Employee "${agent.username}": ${unauthorizedIds.join(
            ', ',
          )}.`,
        };
      }

      const kbPlugin = ctx.app?.pm?.get?.('plugin-knowledge-base') as
        | {
            searchKnowledgeBases?: (
              requestContext: ToolContext,
              searchQuery: string,
              options: {
                knowledgeBaseIds: string[];
                topK?: number;
                scoreThreshold?: number;
                rerank: boolean;
              },
            ) => Promise<unknown[]>;
          }
        | undefined;
      if (!kbPlugin?.searchKnowledgeBases) {
        return {
          status: 'error' as const,
          content: 'plugin-knowledge-base is not installed or does not expose searchKnowledgeBases().',
        };
      }

      try {
        const results = await kbPlugin.searchKnowledgeBases(withAgentIdentity(ctx, agent.username), query, {
          knowledgeBaseIds: requestedIds ?? agent.knowledgeBaseIds,
          topK: args.topK,
          scoreThreshold: args.scoreThreshold,
          rerank: true,
        });

        return {
          status: 'success' as const,
          content: JSON.stringify({
            query,
            results: results.map(normalizeResult),
          }),
        };
      } catch (error: unknown) {
        plugin.app.log?.error?.('[AgentOrchestrator] external_rag_search failed', error);
        return {
          status: 'error' as const,
          content: `External RAG search failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
