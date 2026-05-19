/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type PluginKnowledgeBaseServer from '../plugin';

/**
 * Shared factory for creating embeddings from plugin-ai LLM services.
 * Knowledge Base vectorization now uses only server-side embedding providers
 * configured on the selected Vector Store.
 */
export async function createEmbeddingsForVectorStore(
  plugin: PluginKnowledgeBaseServer,
  vectorStoreConfig: any,
): Promise<EmbeddingsInterface> {
  const llmServiceName = vectorStoreConfig.llmService;
  const embeddingModel = Array.isArray(vectorStoreConfig.embeddingModel)
    ? vectorStoreConfig.embeddingModel[0]
    : vectorStoreConfig.embeddingModel;

  if (!llmServiceName) {
    throw new Error(`Vector store "${vectorStoreConfig.name ?? vectorStoreConfig.id}" is missing llmService`);
  }
  if (!embeddingModel) {
    throw new Error(`Vector store "${vectorStoreConfig.name ?? vectorStoreConfig.id}" is missing embeddingModel`);
  }

  const llmServiceRecord = await plugin.db.getRepository('llmServices').findOne({
    filter: { name: llmServiceName },
  });
  if (!llmServiceRecord) {
    throw new Error(`LLM service "${llmServiceName}" not found`);
  }

  const llmService = llmServiceRecord.toJSON ? llmServiceRecord.toJSON() : llmServiceRecord;
  if (llmService.enabled === false) {
    throw new Error(`LLM service "${llmServiceName}" is disabled`);
  }

  const providerMeta = plugin.aiPlugin?.aiManager?.llmProviders?.get(llmService.provider);
  if (!providerMeta) {
    throw new Error(`LLM service provider "${llmService.provider}" is not registered`);
  }
  if (!providerMeta.embedding) {
    throw new Error(`LLM service provider "${llmService.provider}" does not support embeddings`);
  }

  const EmbeddingProvider = providerMeta.embedding;
  return new EmbeddingProvider({
    app: plugin.app,
    serviceOptions: llmService.options,
    modelOptions: { model: embeddingModel },
  }).createEmbedding();
}
