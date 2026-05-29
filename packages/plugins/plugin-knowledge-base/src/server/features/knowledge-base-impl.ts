/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface KnowledgeBase {
  knowledgeBaseType: string;
  knowledgeBaseOuterId: string;
  key?: string;
  name: string;
  description: string;
  vectorStoreProvider: string;
  vectorStoreConfigId: string;
  vectorStoreProps: { key: string; value: any }[];
  enabled: boolean;
}

export interface KnowledgeBaseGroup {
  vectorStoreConfig: {
    vectorStoreProvider: string;
    vectorStoreConfigId: string;
  };
  knowledgeBaseType: string;
  knowledgeBaseList: KnowledgeBase[];
}

export interface KnowledgeBaseFeature {
  getKnowledgeBase(knowledgeBaseIds: string[]): Promise<KnowledgeBase[]>;
  getKnowledgeBaseGroup(knowledgeBaseIds: string[]): Promise<KnowledgeBaseGroup[]>;
}
import type PluginKnowledgeBaseServer from '../plugin';

/**
 * Fix #1: Matches interface signature exactly — getKnowledgeBaseGroup(knowledgeBaseIds: string[])
 * Permission filtering is NOT done here because plugin-ai calls this method
 * without user context during RAG retrieval (ai-employee.ts:767).
 *
 * Permission enforcement happens at:
 * 1. Resource level (aiKnowledgeBase:list filters by accessLevel)
 * 2. Vector metadata level (DefaultVectorStoreService auto-injects userId filter for BASIC KBs)
 */
export class KnowledgeBaseFeatureImpl implements KnowledgeBaseFeature {
  constructor(private plugin: PluginKnowledgeBaseServer) {}

  async getKnowledgeBase(knowledgeBaseIds: string[]): Promise<KnowledgeBase[]> {
    if (!knowledgeBaseIds || knowledgeBaseIds.length === 0) {
      return [];
    }

    const repo = this.plugin.db.getRepository('aiKnowledgeBases');

    const knowledgeBases = await repo.find({
      filter: {
        id: { $in: knowledgeBaseIds },
        enabled: true,
      },
      appends: ['vectorStore', 'vectorStore.vectorDatabase'],
    });

    const results: KnowledgeBase[] = [];

    for (const kb of knowledgeBases) {
      const kbData = kb.toJSON();
      const vectorStore = kbData.vectorStore;
      const vectorStoreConfigId = vectorStore?.id ?? '';
      const vectorStoreProvider = vectorStore?.vectorDatabase?.provider ?? 'pgvector';

      results.push({
        knowledgeBaseType: kbData.type ?? 'LOCAL',
        knowledgeBaseOuterId: kbData.id,
        key: String(kbData.id),
        name: kbData.name,
        description: kbData.description ?? '',
        vectorStoreProvider,
        vectorStoreConfigId,
        vectorStoreProps: [
          ...(kbData.options?.vectorStoreProps ?? []),
          { key: 'vectorStoreConfigId', value: vectorStoreConfigId },
          { key: 'accessLevel', value: kbData.accessLevel ?? 'PUBLIC' },
          ...(kbData.accessLevel === 'BASIC' && kbData.ownerId
            ? [{ key: 'ownerId', value: String(kbData.ownerId) }]
            : []),
          ...(kbData.accessLevel === 'SHARED'
            ? [{ key: 'allowedRoles', value: Array.isArray(kbData.allowedRoles) ? kbData.allowedRoles : [] }]
            : []),
        ],
        enabled: kbData.enabled,
      });
    }

    return results;
  }

  async getKnowledgeBaseGroup(knowledgeBaseIds: string[]): Promise<KnowledgeBaseGroup[]> {
    if (!knowledgeBaseIds || knowledgeBaseIds.length === 0) {
      return [];
    }

    const repo = this.plugin.db.getRepository('aiKnowledgeBases');

    const knowledgeBases = await repo.find({
      filter: {
        id: { $in: knowledgeBaseIds },
        enabled: true,
      },
      appends: ['vectorStore', 'vectorStore.vectorDatabase'],
    });

    // Group knowledge bases by vector store config
    const groups = new Map<string, KnowledgeBaseGroup>();

    for (const kb of knowledgeBases) {
      const kbData = kb.toJSON();
      const vectorStore = kbData.vectorStore;
      if (!vectorStore) {
        // EXTERNAL_RAG KBs don't have vector stores — they use registered RAG strategies
        // and are handled separately in plugin.ts work context handler (step 5b).
        continue;
      }

      const vectorStoreConfigId = vectorStore.id;
      const vectorStoreProvider = vectorStore.vectorDatabase?.provider ?? 'pgvector';

      const groupKey = `${vectorStoreProvider}:${vectorStoreConfigId}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          vectorStoreConfig: {
            vectorStoreProvider,
            vectorStoreConfigId,
          },
          knowledgeBaseType: kbData.type ?? 'LOCAL',
          knowledgeBaseList: [],
        });
      }

      const group = groups.get(groupKey)!;
      const kbEntry: KnowledgeBase = {
        knowledgeBaseType: kbData.type ?? 'LOCAL',
        knowledgeBaseOuterId: kbData.id,
        key: String(kbData.id),
        name: kbData.name,
        description: kbData.description ?? '',
        vectorStoreProvider,
        vectorStoreConfigId,
        vectorStoreProps: [
          ...(kbData.options?.vectorStoreProps ?? []),
          // CRITICAL: vectorStoreConfigId must be in props — plugin-ai passes only
          // kb.vectorStoreProps to createVectorStoreService, not the top-level field
          { key: 'vectorStoreConfigId', value: vectorStoreConfigId },
          // Pass accessLevel for downstream vector filtering (Fix #2)
          { key: 'accessLevel', value: kbData.accessLevel ?? 'PUBLIC' },
          // Pass ownerId for BASIC KB per-user vector filtering
          ...(kbData.accessLevel === 'BASIC' && kbData.ownerId
            ? [{ key: 'ownerId', value: String(kbData.ownerId) }]
            : []),
          ...(kbData.accessLevel === 'SHARED'
            ? [{ key: 'allowedRoles', value: Array.isArray(kbData.allowedRoles) ? kbData.allowedRoles : [] }]
            : []),
        ],
        enabled: kbData.enabled,
      };

      group.knowledgeBaseList.push(kbEntry);
    }

    return Array.from(groups.values());
  }
}
