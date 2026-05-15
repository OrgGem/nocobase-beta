import type PluginKnowledgeBaseServer from '../plugin';

const EMBED_PLUGIN_NAMES = ['plugin-embed-web-client', '@nocobase/plugin-embed-web-client', 'embed-web-client'];

export function getEmbedWebClientPlugin(plugin: PluginKnowledgeBaseServer): any | null {
  for (const name of EMBED_PLUGIN_NAMES) {
    try {
      const instance = (plugin as any).pm.get(name);
      if (instance) return instance;
    } catch {
      // Try the next registered name.
    }
  }
  return null;
}

export function getServerEmbeddingPipeline(plugin: PluginKnowledgeBaseServer): any {
  const embedPlugin = getEmbedWebClientPlugin(plugin);
  const pipeline = embedPlugin?.serverEmbeddingPipeline;
  if (!pipeline?.processDocument) {
    throw new Error('Server embedding requires plugin-embed-web-client to be installed and enabled');
  }
  return pipeline;
}

export async function resolveEmbedWebClientProfile(plugin: PluginKnowledgeBaseServer, knowledgeBaseId: string): Promise<any> {
  const embedPlugin = getEmbedWebClientPlugin(plugin);
  if (!embedPlugin?.resolveEmbeddingProfile) {
    throw new Error('Web-client embedding search requires plugin-embed-web-client to be installed and enabled');
  }
  return embedPlugin.resolveEmbeddingProfile(knowledgeBaseId);
}

export function loadEmbedTexts(): any {
  const moduleNames = [
    'plugin-embed-web-client/dist/server/pipeline/server-embedding',
    '@nocobase/plugin-embed-web-client/dist/server/pipeline/server-embedding',
  ];

  for (const moduleName of moduleNames) {
    try {
      const serverEmbedding = require(moduleName);
      if (serverEmbedding?.embedTexts) return serverEmbedding.embedTexts;
    } catch {
      // Try the next package name.
    }
  }

  throw new Error('Failed to load embedTexts from plugin-embed-web-client. Ensure the plugin is built.');
}
