import { InstallOptions, Plugin } from '@nocobase/server';
import { resolve } from 'path';
import {
  build,
  recoverInterruptedBuilds,
  registerBuildTemplateQueue,
  unregisterBuildTemplateQueue,
} from './actions/build';

export class PluginBuildUITemplateServer extends Plugin {
  private readonly schemaCollections = ['aiBuildUiTemplateSpaces'];

  async load() {
    // Import collection definitions
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });
    await this.ensureSchema();

    // Register resource actions
    this.app.resourceManager.registerActionHandlers({
      'aiBuildUiTemplateSpaces:build': build,
    });

    // ACL permissions
    this.app.acl.registerSnippet({
      name: 'pm.ai-build-ui-template',
      actions: ['aiBuildUiTemplateSpaces:*'],
    });

    // Initialize background queue
    registerBuildTemplateQueue(this.app);

    // Resume interrupted worker runs on startup
    this.app.on('afterStart', async () => {
      try {
        await recoverInterruptedBuilds(this.app);
      } catch (err) {
        this.app.logger.warn('[plugin-build-ui-template] Failed to recover interrupted builds', err);
      }
    });

    // Event hooks for cleanup
    this.app.on('beforeStop', () => {
      unregisterBuildTemplateQueue(this.app);
    });
    this.app.on('beforeDestroy', () => {
      unregisterBuildTemplateQueue(this.app);
    });
  }

  private async ensureCollectionSchema(collectionName: string) {
    const collection = this.db.getCollection(collectionName);
    if (!collection) {
      this.app.logger.warn(`[plugin-build-ui-template] Collection "${collectionName}" is not registered`);
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
      this.app.logger.info(`[plugin-build-ui-template] Added missing column "${columnName}" to "${collectionName}"`);
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

  async beforeDisable() {
    unregisterBuildTemplateQueue(this.app);
  }

  async afterDisable() {
    unregisterBuildTemplateQueue(this.app);
  }

  async beforeUnload() {
    unregisterBuildTemplateQueue(this.app);
  }

  async remove() {
    unregisterBuildTemplateQueue(this.app);
  }
}

export default PluginBuildUITemplateServer;
