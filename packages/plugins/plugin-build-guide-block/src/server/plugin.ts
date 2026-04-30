import { InstallOptions, Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { build } from './actions/build';
import { getHtml } from './actions/getHtml';
import { getMarkdown } from './actions/getMarkdown';

export class PluginBuildGuideBlockServer extends Plugin {
  private readonly schemaCollections = ['aiBuildGuideSpaces', 'aiBuildGuidePages'];

  afterAdd() {}

  beforeLoad() {}

  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.app.resourceManager.registerActionHandlers({
      'aiBuildGuideSpaces:build': build,
      'aiBuildGuideSpaces:getHtml': getHtml,
      'aiBuildGuideSpaces:getMarkdown': getMarkdown,
    });

    this.app.acl.allow('aiBuildGuideSpaces', 'getHtml', 'loggedIn');
    this.app.acl.allow('aiBuildGuideSpaces', 'getMarkdown', 'loggedIn');
    this.app.acl.registerSnippet({
      name: 'pm.ai-build-guide',
      actions: [
        'aiBuildGuideSpaces:create',
        'aiBuildGuideSpaces:update',
        'aiBuildGuideSpaces:destroy',
        'aiBuildGuideSpaces:list',
        'aiBuildGuideSpaces:get',
        'aiBuildGuideSpaces:build',
        'aiBuildGuidePages:list',
        'aiBuildGuidePages:get',
      ],
    });

    // Recover stale "building" status after server restart
    this.app.on('afterStart', async () => {
      try {
        const repo = this.db.getRepository('aiBuildGuideSpaces');
        await repo.update({
          filter: { status: 'building' },
          values: {
            status: 'error',
            buildPhase: 'error',
            buildLog: 'Build interrupted by server restart',
          },
        });
        const pageRepo = this.db.getRepository('aiBuildGuidePages');
        await pageRepo.update({
          filter: { status: 'building' },
          values: {
            status: 'error',
            buildLog: 'Build interrupted by server restart',
          },
        });
      } catch (err) {
        this.app.logger.warn('[plugin-build-guide-block] Failed to recover stale builds', err);
      }
    });
  }

  private async ensureCollectionSchema(collectionName: string) {
    const collection = this.db.getCollection(collectionName);
    if (!collection) {
      this.app.logger.warn(`[plugin-build-guide-block] Collection "${collectionName}" is not registered`);
      return;
    }

    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    let columns: Record<string, any> | null = null;

    try {
      columns = await queryInterface.describeTable(tableName);
    } catch (error) {
      await collection.model.sync();
      columns = await queryInterface.describeTable(tableName);
    }

    const attributes = collection.model.rawAttributes as Record<string, any>;
    for (const [attributeName, attribute] of Object.entries(attributes)) {
      const columnName = attribute.field || attributeName;
      if (columns[columnName]) {
        continue;
      }

      const columnDefinition = { ...attribute };
      delete columnDefinition.Model;
      delete columnDefinition.fieldName;

      await queryInterface.addColumn(tableName, columnName, columnDefinition);
      columns[columnName] = columnDefinition;
      this.app.logger.info(`[plugin-build-guide-block] Added missing column "${columnName}" to "${collectionName}"`);
    }
  }

  private async ensureSchema() {
    for (const collectionName of this.schemaCollections) {
      await this.ensureCollectionSchema(collectionName);
    }

    const repo = this.db.getRepository<any>('collections');
    if (repo) {
      for (const collectionName of this.schemaCollections) {
        await repo.db2cm(collectionName);
      }
    }
  }

  async install(options?: InstallOptions) {
    await this.ensureSchema();
  }

  async upgrade() {
    await this.ensureSchema();
  }

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginBuildGuideBlockServer;
