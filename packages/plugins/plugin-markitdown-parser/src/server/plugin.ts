import { Plugin } from '@nocobase/server';
import { MarkItDownService } from './services/markitdown-service';
import { MARKITDOWN_HANDLER_NAME, MarkItDownParserHandler } from './services/markitdown-parser-handler';
import { defineActions } from './actions';

export class PluginMarkItDownParserServer extends Plugin {
  public service = new MarkItDownService();
  private registeredRegistry: any | null = null;

  async load() {
    this.registerResource();
    this.registerParserHandler();

    this.app.on('afterStart', async () => {
      this.registerParserHandler();
    });
  }

  getDocumentParserPlugin(): any | null {
    const candidates = ['@nocobase/plugin-document-parser', 'plugin-document-parser', 'document-parser'];
    for (const name of candidates) {
      try {
        const plugin = this.pm.get(name) as any;
        if (plugin?.internalParserRegistry) return plugin;
      } catch {
        // Try the next known plugin name.
      }
    }
    return null;
  }

  async afterDisable() {
    this.unregisterParserHandler();
  }

  async remove() {
    this.unregisterParserHandler();
  }

  private registerResource() {
    this.app.resource({
      name: 'markitdown',
      actions: defineActions(this),
    });

    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['markitdown:*'],
    });
  }

  private registerParserHandler() {
    const docParserPlugin = this.getDocumentParserPlugin();
    const registry = docParserPlugin?.internalParserRegistry;
    if (!registry?.register) {
      this.log.warn('[MarkItDownParser] plugin-document-parser is not loaded; internal handler registration skipped.');
      return;
    }

    const alreadyRegistered = registry.list?.().some((handler: any) => handler?.name === MARKITDOWN_HANDLER_NAME);
    if (alreadyRegistered) {
      this.registeredRegistry = registry;
      return;
    }

    registry.register(new MarkItDownParserHandler(this.service, () => this.getDocumentParserPlugin()), {
      prepend: true,
    });
    this.registeredRegistry = registry;
    this.log.info('[MarkItDownParser] Registered MarkItDown internal parser handler.');
  }

  private unregisterParserHandler() {
    if (!this.registeredRegistry?.unregister) return;
    this.registeredRegistry.unregister(MARKITDOWN_HANDLER_NAME);
    this.registeredRegistry = null;
  }
}

export default PluginMarkItDownParserServer;
