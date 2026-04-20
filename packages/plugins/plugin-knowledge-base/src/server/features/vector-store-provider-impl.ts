/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type {
  VectorStoreProviderFeature,
  VectorStoreProvider,
  VectorStoreService,
  VectorStoreSearchOptions,
  DocumentSegmentedWithScore,
} from '@nocobase/plugin-ai/server';
import type { VectorStoreProp } from '@nocobase/plugin-ai/server';
import type PluginKnowledgeBaseServer from '../plugin';
import type PluginAIServer from '@nocobase/plugin-ai';
import { createEmbeddingsForVectorStore } from '../pipeline/embedding-factory';
import { getCurrentUserId, getCurrentUserRoles } from '../request-context';

export class VectorStoreProviderImpl implements VectorStoreProviderFeature {
  private providers = new Map<string, VectorStoreProvider>();

  constructor(
    private plugin: PluginKnowledgeBaseServer,
    private aiPlugin: PluginAIServer,
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
    let allowedRoles: string[] | undefined;

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
        const hasAccess = currentRoles.some((r: string) => allAllowedRoles.has(r)) || currentRoles.includes('root'); // root always has access
        if (!hasAccess) {
          accessLevel = 'DENIED';
        } else {
          accessLevel = 'SHARED';
          allowedRoles = currentRoles;
        }
      }
    }

    return new DefaultVectorStoreService(vectorStore, { accessLevel, ownerId, allowedRoles });
  }

}

type AccessContext = {
  accessLevel?: string;
  ownerId?: string;
  allowedRoles?: string[];
};

/**
 * Access-aware VectorStoreService.
 * - BASIC: auto-injects userId metadata filter (per-user isolation)
 * - SHARED: only allows access if user has matching role (DENIED returns empty)
 * - PUBLIC: no filtering
 */
class DefaultVectorStoreService implements VectorStoreService {
  constructor(
    private vectorStore: any,
    private accessContext: AccessContext = {},
  ) {}

  async getVectorStore() {
    return this.vectorStore;
  }

  async search(query: string, options?: VectorStoreSearchOptions): Promise<DocumentSegmentedWithScore[]> {
    const { topK = 3, score, filter } = options ?? {};

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

    const results = await this.vectorStore.similaritySearchWithScore(query, topK, mergedFilter);

    const scoreThreshold = score ? parseFloat(score) : 0;

    return results
      .filter(([, resultScore]: [any, number]) => resultScore >= scoreThreshold)
      .map(([doc, resultScore]: [any, number]) => ({
        content: doc.pageContent,
        metadata: doc.metadata || {},
        id: doc.metadata?.id,
        score: resultScore,
      }));
  }
}
