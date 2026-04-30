import type { Context } from '@nocobase/actions';
import type PluginKnowledgeBaseServer from '../plugin';
import { buildAccessibleKnowledgeBaseFilter } from '../utils/access';
import { EXTERNAL_HTTP_RAG_PROVIDER, EXTERNAL_RAG_KB_TYPE } from '../providers/external-rag';
import type { RagSearchResult } from '../providers/external-rag';

export type KnowledgeSearchOptions = {
  knowledgeBaseIds?: string[];
  topK?: number;
  candidateK?: number;
  scoreThreshold?: number;
  rerank?: boolean;
};

export type KnowledgeSearchResult = RagSearchResult & {
  vectorScore: number;
  rerankScore: number;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
};

const DEFAULT_TOP_K = 5;
const DEFAULT_SCORE_THRESHOLD = 0.3;
const MAX_TOP_K = 50;
const MAX_CANDIDATE_K = 100;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function parseThreshold(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value: string): string {
  return value.toLowerCase().normalize('NFKC');
}

function tokenize(value: string): string[] {
  return (
    normalizeText(value)
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length > 1) ?? []
  );
}

function lexicalScore(query: string, content: string): number {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (!queryTokens.length) return 0;

  const contentTokens = tokenize(content);
  if (!contentTokens.length) return 0;

  const frequencies = new Map<string, number>();
  for (const token of contentTokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  let matched = 0;
  let density = 0;
  for (const token of queryTokens) {
    const count = frequencies.get(token) ?? 0;
    if (count > 0) {
      matched += 1;
      density += Math.min(count, 3) / 3;
    }
  }

  const coverage = matched / queryTokens.length;
  const densityScore = density / queryTokens.length;
  const phraseBonus = normalizeText(content).includes(normalizeText(query).trim()) ? 0.15 : 0;

  return Math.min(1, coverage * 0.75 + densityScore * 0.25 + phraseBonus);
}

function normalizeVectorScores(results: Array<{ vectorScore: number }>): number[] {
  if (!results.length) return [];

  const scores = results.map((item) => (Number.isFinite(item.vectorScore) ? item.vectorScore : 0));
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) {
    return scores.map(() => (max > 0 ? 1 : 0));
  }

  return scores.map((score) => (score - min) / (max - min));
}

function dedupeResults(results: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
  const byKey = new Map<string, KnowledgeSearchResult>();

  for (const result of results) {
    const metadata = result.metadata ?? {};
    const key =
      result.id ??
      metadata.id ??
      [metadata.knowledgeBaseOuterId, metadata.documentId, metadata.source, result.content.slice(0, 160)].join(':');
    const previous = byKey.get(key);
    if (!previous || result.rerankScore > previous.rerankScore) {
      byKey.set(key, result);
    }
  }

  return Array.from(byKey.values());
}

export class KnowledgeSearchService {
  constructor(private plugin: PluginKnowledgeBaseServer) {}

  async search(ctx: Context, query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchResult[]> {
    const trimmedQuery = query?.trim();
    if (!trimmedQuery) return [];

    const topK = clampInt(options.topK, DEFAULT_TOP_K, 1, MAX_TOP_K);
    const candidateK = clampInt(options.candidateK, Math.max(topK * 4, topK), topK, MAX_CANDIDATE_K);
    const scoreThreshold = parseThreshold(options.scoreThreshold, DEFAULT_SCORE_THRESHOLD);
    const rerank = options.rerank !== false;
    const kbIds = options.knowledgeBaseIds?.filter(Boolean).map(String);

    const kbRepo = this.plugin.db.getRepository('aiKnowledgeBases');
    const kbRecords = await kbRepo.find({
      filter: buildAccessibleKnowledgeBaseFilter(ctx, kbIds),
      fields: ['id', 'name', 'type', 'options'],
    });
    const accessibleKbs = kbRecords.map((record: any) => (record.toJSON ? record.toJSON() : record));
    const accessibleIds = accessibleKbs.map((kb: any) => String(kb.id));
    if (!accessibleIds.length) return [];

    const externalKbs = accessibleKbs.filter((kb: any) => kb.type === EXTERNAL_RAG_KB_TYPE);
    const externalIds = new Set(externalKbs.map((kb: any) => String(kb.id)));
    const standardIds = accessibleIds.filter((id) => !externalIds.has(id));
    const results: KnowledgeSearchResult[] = [];

    if (standardIds.length) {
      const groups = await this.plugin.knowledgeBaseFeature.getKnowledgeBaseGroup(standardIds);
      await Promise.all(
        groups.map(async (entry: any) => {
          const { vectorStoreConfig, knowledgeBaseType, knowledgeBaseList } = entry;
          if (!knowledgeBaseList?.length) return;

          try {
            if (knowledgeBaseType === 'LOCAL') {
              const firstKB = knowledgeBaseList[0];
              const service = await this.plugin.vectorStoreProvider.createVectorStoreService(
                vectorStoreConfig.vectorStoreProvider,
                firstKB.vectorStoreProps,
              );
              const knowledgeBaseOuterIds = knowledgeBaseList.map((kb: any) => kb.knowledgeBaseOuterId);
              const found = await service.search(trimmedQuery, {
                topK: candidateK,
                score: String(scoreThreshold),
                filter: { knowledgeBaseOuterId: { in: knowledgeBaseOuterIds } },
              });
              results.push(...this.toSearchResults(found, knowledgeBaseList));
              return;
            }

            await Promise.all(
              knowledgeBaseList.map(async (kb: any) => {
                const service = await this.plugin.vectorStoreProvider.createVectorStoreService(
                  vectorStoreConfig.vectorStoreProvider,
                  kb.vectorStoreProps,
                );
                const found = await service.search(trimmedQuery, {
                  topK: candidateK,
                  score: String(scoreThreshold),
                });
                results.push(...this.toSearchResults(found, [kb]));
              }),
            );
          } catch (err) {
            this.plugin.app.logger.error(`[KB Search] Vector search failed for type=${knowledgeBaseType}:`, err);
          }
        }),
      );
    }

    await Promise.all(
      externalKbs.map(async (kb: any) => {
        const providerName = kb.options?.ragProvider ?? EXTERNAL_HTTP_RAG_PROVIDER;
        const strategy = this.plugin.getRagSearchStrategy(providerName);
        if (!strategy) {
          this.plugin.app.logger.warn(
            `[KB Search] No RAG strategy registered for provider "${providerName}" (KB: ${kb.name ?? kb.id})`,
          );
          return;
        }

        try {
          const found = await strategy(trimmedQuery, kb, {
            topK: candidateK,
            scoreThreshold,
          });
          results.push(
            ...found.map((item) => ({
              ...item,
              score: Number(item.score) || 0,
              vectorScore: Number(item.score) || 0,
              rerankScore: Number(item.score) || 0,
              knowledgeBaseId: String(kb.id),
              knowledgeBaseName: kb.name,
            })),
          );
        } catch (err) {
          this.plugin.app.logger.error(
            `[KB Search] External RAG search failed (${kb.name}, provider=${providerName}):`,
            err,
          );
        }
      }),
    );

    if (!results.length) return [];

    const ranked = rerank ? this.rerank(trimmedQuery, results) : results;
    return dedupeResults(ranked)
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topK);
  }

  private toSearchResults(items: any[], knowledgeBases: any[]): KnowledgeSearchResult[] {
    const kbById = new Map(knowledgeBases.map((kb: any) => [String(kb.knowledgeBaseOuterId), kb]));

    return items.map((item: any) => {
      const metadata = item.metadata ?? {};
      const knowledgeBaseId = metadata.knowledgeBaseOuterId ? String(metadata.knowledgeBaseOuterId) : undefined;
      const kb = knowledgeBaseId ? kbById.get(knowledgeBaseId) : knowledgeBases[0];
      const score = Number(item.score) || 0;

      return {
        content: item.content,
        metadata,
        id: item.id,
        score,
        vectorScore: score,
        rerankScore: score,
        knowledgeBaseId: knowledgeBaseId ?? (kb?.knowledgeBaseOuterId ? String(kb.knowledgeBaseOuterId) : undefined),
        knowledgeBaseName: kb?.name,
      };
    });
  }

  private rerank(query: string, results: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
    const normalizedVectorScores = normalizeVectorScores(results);

    return results.map((result, index) => {
      const lexical = lexicalScore(query, result.content);
      const vector = normalizedVectorScores[index] ?? 0;
      const rerankScore = vector * 0.65 + lexical * 0.35;

      return {
        ...result,
        rerankScore,
        metadata: {
          ...(result.metadata ?? {}),
          rerank: {
            lexicalScore: lexical,
            vectorScore: result.vectorScore,
          },
        },
      };
    });
  }
}
