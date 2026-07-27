/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface VectorStoreProp {
  key: string;
  value: any;
}

export interface DocumentSegmentedWithScore {
  content: string;
  metadata: any;
  id?: string;
  score: number;
}

export interface VectorStoreSearchOptions {
  topK?: number;
  score?: number | string;
  filter?: any;
}

export interface VectorStoreService {
  getVectorStore(): Promise<any>;
  search(query: string, options?: VectorStoreSearchOptions): Promise<DocumentSegmentedWithScore[]>;
}

export interface VectorStoreProvider {
  providerName: string;
  createVectorStoreService(vectorStoreProps?: VectorStoreProp[]): Promise<VectorStoreService>;
}

export interface VectorStoreProviderFeature {
  register(vsp: VectorStoreProvider): void;
  createVectorStoreService(providerName: string, vectorStoreProps?: VectorStoreProp[]): Promise<VectorStoreService>;
}
import type PluginKnowledgeBaseServer from '../plugin';
import type PluginAIServer from '@nocobase/plugin-ai';
import { createEmbeddingsForVectorStore } from '../pipeline/embedding-factory';
import { getCurrentUserId, getCurrentUserRoles } from '../request-context';

export class VectorStoreProviderImpl implements VectorStoreProviderFeature {
  private providers = new Map<string, VectorStoreProvider>();

  constructor(
    private plugin: PluginKnowledgeBaseServer,
    private aiPlugin: any,
  ) {}

  register(vsp: VectorStoreProvider): void {
    this.providers.set(vsp.providerName, vsp);
  }

  async createVectorStoreService(
    providerName: string,
    vectorStoreProps?: VectorStoreProp[],
  ): Promise<VectorStoreService> {
    // If we have a registered provider, use it directly
    const provider = this.providers.get(providerName);
    if (provider) {
      return provider.createVectorStoreService(vectorStoreProps);
    }

    // Default: create service from vector store config in database
    return this.createDefaultVectorStoreService(vectorStoreProps);
  }

  private async createDefaultVectorStoreService(vectorStoreProps?: VectorStoreProp[]): Promise<VectorStoreService> {
    const propsMap = new Map((vectorStoreProps ?? []).map((p) => [p.key, p.value]));

    const vectorStoreConfigId = propsMap.get('vectorStoreConfigId');
    if (!vectorStoreConfigId) {
      throw new Error('vectorStoreConfigId is required');
    }

    // Load vector store config
    const vectorStoreRecord = await this.plugin.db.getRepository('aiVectorStores').findOne({
      filter: { id: vectorStoreConfigId },
      appends: ['vectorDatabase'],
    });

    if (!vectorStoreRecord) {
      throw new Error(`Vector store "${vectorStoreConfigId}" not found`);
    }

    const vectorStoreConfig = vectorStoreRecord.toJSON();
    const vectorDatabase = vectorStoreConfig.vectorDatabase;

    if (!vectorDatabase) {
      throw new Error('Vector store has no associated vector database');
    }

    // Create embedding model
    const embeddings = await createEmbeddingsForVectorStore(this.plugin, vectorStoreConfig);

    // Create vector store via provider
    const vdbProviderFeature = this.aiPlugin.features.vectorDatabaseProvider;
    const vectorStore = await vdbProviderFeature.createVectorStore(
      vectorDatabase.provider,
      embeddings,
      vectorDatabase.connectParams,
    );

    // Determine access context for per-user isolation or role-based access
    let accessLevel = propsMap.get('accessLevel') as string | undefined;
    let ownerId = propsMap.get('ownerId') as string | undefined;
    let allowedRoles = Array.isArray(propsMap.get('allowedRoles'))
      ? (propsMap.get('allowedRoles') as string[]).map(String)
      : undefined;

    // If not explicitly provided, check linked KBs for access restrictions
    if (!accessLevel) {
      const knowledgeBases = await this.plugin.db.getRepository('aiKnowledgeBases').find({
        filter: { vectorStoreId: vectorStoreConfigId },
      });

      // Check for BASIC KBs (per-user isolation)
      const hasBasicKB = knowledgeBases.some((kb: any) => kb.accessLevel === 'BASIC');
      if (hasBasicKB) {
        accessLevel = 'BASIC';
        const currentUserId = getCurrentUserId();
        if (currentUserId) {
          ownerId = String(currentUserId);
        }
      }

      // Check for SHARED KBs (role-based access)
      const sharedKBs = knowledgeBases.filter((kb: any) => kb.accessLevel === 'SHARED');
      if (sharedKBs.length > 0 && !hasBasicKB) {
        const currentRoles = getCurrentUserRoles();
        // Merge all allowedRoles from SHARED KBs
        const allAllowedRoles = new Set<string>();
        for (const kb of sharedKBs) {
          for (const role of kb.allowedRoles ?? []) {
            allAllowedRoles.add(role);
          }
        }
        // Check if user has any of the allowed roles
        const hasAccess =
          currentRoles.some((r: string) => allAllowedRoles.has(r)) ||
          currentRoles.includes('root') ||
          currentRoles.includes('admin');
        if (!hasAccess) {
          accessLevel = 'DENIED';
        } else {
          accessLevel = 'SHARED';
          allowedRoles = currentRoles;
        }
      }
    }

    if (accessLevel === 'SHARED' && allowedRoles?.length) {
      const currentRoles = getCurrentUserRoles();
      const hasAccess =
        currentRoles.some((role: string) => allowedRoles.includes(role)) ||
        currentRoles.includes('root') ||
        currentRoles.includes('admin');
      if (!hasAccess) {
        accessLevel = 'DENIED';
      }
    }

    return new DefaultVectorStoreService(vectorStore, vectorDatabase.provider, { accessLevel, ownerId, allowedRoles });
  }
}

type AccessContext = {
  accessLevel?: string;
  ownerId?: string;
  allowedRoles?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * LangChain forwards Qdrant filters directly to Qdrant. Our internal search
 * filter is metadata-oriented, so translate it to Qdrant's `must` DSL before
 * sending the query. Other vector providers keep the existing filter shape.
 */
export function toQdrantMetadataFilter(filter: Record<string, unknown> | undefined) {
  if (!filter) {
    return undefined;
  }
  if (['must', 'must_not', 'should', 'min_should'].some((key) => key in filter)) {
    return filter;
  }

  const must = Object.entries(filter).flatMap(([key, value]) => {
    const metadataKey = key.startsWith('metadata.') ? key : `metadata.${key}`;
    if (isRecord(value) && Array.isArray(value.in)) {
      return value.in.length ? [{ key: metadataKey, match: { any: value.in } }] : [];
    }
    return [{ key: metadataKey, match: { value } }];
  });

  return must.length ? { must } : undefined;
}

/**
 * Access-aware VectorStoreService.
 * - BASIC: auto-injects userId metadata filter (per-user isolation)
 * - SHARED: only allows access if user has matching role (DENIED returns empty)
 * - PUBLIC: no filtering
 */
class DefaultVectorStoreService implements VectorStoreService {
  constructor(
    private vectorStore: any,
    private vectorDatabaseProvider: string,
    private accessContext: AccessContext = {},
  ) {}

  async getVectorStore() {
    return this.vectorStore;
  }

  async search(query: string, options?: VectorStoreSearchOptions): Promise<DocumentSegmentedWithScore[]> {
    const { topK = 3, score, filter } = options ?? {};
    const effectiveTopK = Math.min(Math.max(Number(topK) || 3, 1), 100);

    const level = this.accessContext.accessLevel;

    // DENIED: user doesn't have access to SHARED KB — return empty
    if (level === 'DENIED') {
      return [];
    }

    // Auto-inject userId filter for per-user isolated KBs (BASIC)
    let mergedFilter = filter;
    if (level === 'BASIC' && this.accessContext.ownerId) {
      mergedFilter = {
        ...filter,
        userId: this.accessContext.ownerId,
      };
    }

    const providerFilter =
      this.vectorDatabaseProvider === 'qdrant'
        ? toQdrantMetadataFilter(mergedFilter as Record<string, unknown> | undefined)
        : mergedFilter;
    const results = await this.vectorStore.similaritySearchWithScore(query, effectiveTopK, providerFilter);

    const parsedThreshold = score == null ? 0 : Number(score);
    const scoreThreshold = Number.isFinite(parsedThreshold) ? parsedThreshold : 0;

    return results
      .filter(([, resultScore]: [any, number]) => resultScore >= scoreThreshold)
      .map(([doc, resultScore]: [any, number]) => ({
        content: doc.pageContent ?? '',
        metadata: doc.metadata || {},
        id: doc.metadata?.id,
        score: Number(resultScore) || 0,
      }))
      .filter((doc: DocumentSegmentedWithScore) => doc.content.trim().length > 0);
  }
}
