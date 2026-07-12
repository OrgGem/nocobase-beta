import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { createActions } from './actions';
import { registerFileSearchAiTool } from './ai-tools';
import { startFileSearchQueue, stopFileSearchQueue } from './queue';

export class PluginFileSearchServer extends Plugin {
  declare app: any;
  declare db: any;

  async afterAdd() {}

  async beforeLoad() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });
  }

  async load() {
    const actions = createActions(this);

    this.app.resourceManager.registerActionHandlers({
      'fileSearchSettings:get': actions.settings.get,
      'fileSearchSettings:save': actions.settings.save,
      'fileSearchSettings:healthCheck': actions.settings.healthCheck,
      'fileSearch:indexFile': actions.fileSearch.indexFile,
      'fileSearch:scanSources': actions.fileSearch.scanSources,
      'fileSearch:reindexDocument': actions.fileSearch.reindexDocument,
      'fileSearch:retryJob': actions.fileSearch.retryJob,
      'fileSearch:cancelJob': actions.fileSearch.cancelJob,
      'fileSearch:search': actions.fileSearch.search,
      'fileSearch:overview': actions.fileSearch.overview,
    });

    this.app.acl.registerSnippet({
      name: `pm.${this.name}.manage`,
      actions: [
        'fileSearchSettings:*',
        'fileSearchDocuments:*',
        'fileSearchReferences:*',
        'fileSearchJobs:*',
        'fileSearch:indexFile',
        'fileSearch:scanSources',
        'fileSearch:reindexDocument',
        'fileSearch:retryJob',
        'fileSearch:cancelJob',
        'fileSearch:overview',
      ],
    });

    this.app.acl.registerSnippet({
      name: `pm.${this.name}.search`,
      actions: ['fileSearch:search'],
    });

    this.app.acl.allow('fileSearch', 'search', 'loggedIn');
    this.app.acl.allow('fileSearchSettings', ['get', 'healthCheck'], 'loggedIn');

    registerFileSearchAiTool(this.app, actions.fileSearch.search);

    this.app.on('afterStart', () => startFileSearchQueue(this.app));
    this.app.on('beforeStop', () => stopFileSearchQueue());
    this.app.on('beforeDestroy', () => stopFileSearchQueue());
  }

  async install() {
    await this.ensureSchema();
  }

  async upgrade() {
    await this.ensureSchema();
  }

  async afterEnable() {}

  async beforeDisable() {
    stopFileSearchQueue();
  }

  async afterDisable() {
    stopFileSearchQueue();
  }

  async remove() {
    stopFileSearchQueue();
  }

  private async ensureSchema() {
    for (const name of ['fileSearchSettings', 'fileSearchDocuments', 'fileSearchReferences', 'fileSearchJobs']) {
      const collection = this.db.getCollection(name);
      if (collection) {
        await collection.model.sync();
      }
    }
  }
}

export default PluginFileSearchServer;
