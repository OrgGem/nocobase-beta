const EMBED_WEB_CLIENT_PLUGIN_NAMES = [
  'plugin-embed-web-client',
  '@nocobase/plugin-embed-web-client',
  'embed-web-client',
];

export function getEmbedWebClientPlugin(app: any): any | undefined {
  for (const name of EMBED_WEB_CLIENT_PLUGIN_NAMES) {
    try {
      const plugin = app?.pm?.get?.(name);
      if (plugin) {
        return plugin;
      }
    } catch {
      // Plugin manager may throw for unknown aliases in some runtimes.
    }
  }
}

export function isEmbedWebClientPluginEnabled(app: any): boolean {
  return Boolean(getEmbedWebClientPlugin(app) || app?.components?.WebClientDocumentUploader);
}
