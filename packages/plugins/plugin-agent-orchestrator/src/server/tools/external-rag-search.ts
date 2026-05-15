import { z } from 'zod';

const TOOL_NAME = 'external_rag_search';
const MAX_CONTENT_LENGTH = 4000;

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

function normalizeResult(result: any) {
  const metadata = result?.metadata ?? {};
  const sourceId = firstString(
    result?.id,
    metadata.id,
    metadata.sourceId,
    metadata.documentId,
    metadata.docId,
    metadata.fileId,
    metadata.recordId,
  );
  const filename = firstString(metadata.filename, metadata.fileName, metadata.name, metadata.title, metadata.source);

  return {
    content: truncate(result?.content),
    score: Number(result?.rerankScore ?? result?.score ?? result?.vectorScore ?? 0),
    knowledgeBaseId: result?.knowledgeBaseId,
    knowledgeBaseName: result?.knowledgeBaseName,
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
      ctx: any,
      args: { query?: string; knowledgeBaseIds?: string[]; topK?: number; scoreThreshold?: number },
    ) => {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return { status: 'error' as const, content: 'Missing required field: query.' };
      }

      const kbPlugin = ctx?.app?.pm?.get?.('plugin-knowledge-base');
      if (!kbPlugin?.searchKnowledgeBases) {
        return {
          status: 'error' as const,
          content: 'plugin-knowledge-base is not installed or does not expose searchKnowledgeBases().',
        };
      }

      try {
        const results = await kbPlugin.searchKnowledgeBases(ctx, query, {
          knowledgeBaseIds: Array.isArray(args.knowledgeBaseIds) ? args.knowledgeBaseIds.map(String) : undefined,
          topK: args.topK,
          scoreThreshold: args.scoreThreshold,
          rerank: true,
        });

        return {
          status: 'success' as const,
          content: JSON.stringify({
            query,
            results: (results ?? []).map(normalizeResult),
          }),
        };
      } catch (error: any) {
        plugin.app.log?.error?.('[AgentOrchestrator] external_rag_search failed', error);
        return {
          status: 'error' as const,
          content: `External RAG search failed: ${error?.message || String(error)}`,
        };
      }
    },
  };
}
