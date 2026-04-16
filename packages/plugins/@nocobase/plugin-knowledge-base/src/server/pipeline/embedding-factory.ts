/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Shared factory for creating embeddings instances based on vector store config.
 * Used by both VectorStoreProviderImpl and VectorizationPipeline to avoid duplication.
 */

import type PluginKnowledgeBaseServer from '../plugin';
import { SimpleHTTPEmbeddings } from './simple-embeddings';
import { LocalOnnxEmbeddings } from './local-onnx-embeddings';

export async function createEmbeddingsForVectorStore(
  plugin: PluginKnowledgeBaseServer,
  vectorStoreConfig: any,
): Promise<SimpleHTTPEmbeddings | LocalOnnxEmbeddings> {
  const provider = vectorStoreConfig.embeddingProvider || 'llmService';

  if (provider === 'localEmbed') {
    return createLocalEmbeddings(plugin, vectorStoreConfig);
  }

  return createLlmServiceEmbeddings(plugin, vectorStoreConfig);
}

async function createLlmServiceEmbeddings(
  plugin: PluginKnowledgeBaseServer,
  vectorStoreConfig: any,
): Promise<SimpleHTTPEmbeddings> {
  const llmServiceRecord = await plugin.db.getRepository('llmServices').findOne({
    filter: { name: vectorStoreConfig.llmService },
  });

  if (!llmServiceRecord) {
    throw new Error(`LLM service "${vectorStoreConfig.llmService}" not found`);
  }

  const llmService = llmServiceRecord.toJSON();
  const serviceOpts = plugin.app.environment.renderJsonTemplate(llmService.options || {});

  return new SimpleHTTPEmbeddings({
    baseURL: serviceOpts.baseURL || serviceOpts.baseUrl || '',
    apiKey: serviceOpts.apiKey || '',
    model: vectorStoreConfig.embeddingModel,
  });
}

function createLocalEmbeddings(
  plugin: PluginKnowledgeBaseServer,
  vectorStoreConfig: any,
): LocalOnnxEmbeddings {
  const embedPlugin = plugin.pm.get('@nocobase/plugin-embed-web-client') as any;
  if (!embedPlugin) {
    throw new Error('Local embedding requires plugin-embed-web-client to be installed and enabled');
  }

  // Dynamic require to avoid hard build-time dependency
  let embedTexts: any;
  try {
    const serverEmbedding = require('@nocobase/plugin-embed-web-client/dist/server/pipeline/server-embedding');
    embedTexts = serverEmbedding.embedTexts;
  } catch {
    throw new Error('Failed to load embedTexts from plugin-embed-web-client. Ensure the plugin is built.');
  }

  const modelId = vectorStoreConfig.localEmbedModelId || 'Xenova/all-MiniLM-L6-v2';
  const dtype = vectorStoreConfig.localEmbedDtype || 'q8';

  return new LocalOnnxEmbeddings(embedTexts, modelId, dtype);
}
