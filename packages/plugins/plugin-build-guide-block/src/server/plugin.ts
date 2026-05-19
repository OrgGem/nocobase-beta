import { InstallOptions, Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { build, recoverInterruptedBuilds, registerBuildGuideQueue, unregisterBuildGuideQueue } from './actions/build';
import { getHtml } from './actions/getHtml';
import { getMarkdown } from './actions/getMarkdown';
import { searchBuildGuidesTool } from './tools';

export class PluginBuildGuideBlockServer extends Plugin {
  private readonly schemaCollections = ['aiBuildGuideSpaces', 'aiBuildGuidePages'];

  afterAdd() {}

  beforeLoad() {}

  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });
    await this.ensureSchema();

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

    registerBuildGuideQueue(this.app);

    // Resume builds that were interrupted before their worker finished.
    this.app.on('afterStart', async () => {
      try {
        await recoverInterruptedBuilds(this.app);
      } catch (err) {
        this.app.logger.warn('[plugin-build-guide-block] Failed to recover interrupted builds', err);
      }
    });
    this.app.on('beforeStop', () => {
      unregisterBuildGuideQueue(this.app);
    });
    this.app.on('beforeDestroy', () => {
      unregisterBuildGuideQueue(this.app);
    });

    this.registerAITools();
  }

  private registerAITools() {
    const toolsManager = (this.app as any).aiManager?.toolsManager;
    if (!toolsManager) {
      this.app.logger.warn(
        '[plugin-build-guide-block] aiManager.toolsManager is not available; skipping tool registration',
      );
      return;
    }

    const tools = [searchBuildGuidesTool];
    toolsManager.registerTools(
      tools.map((item: any) => {
        const name = `${item.groupName}-${item.tool.name}`;
        return {
          scope: 'CUSTOM',
          defaultPermission: item.tool.execution === 'backend' ? 'ALLOW' : 'ASK',
          execution: item.tool.execution,
          introduction: {
            title: item.tool.title,
            about: item.tool.description,
          },
          definition: {
            name,
            description: item.tool.description,
            schema: item.tool.schema,
          },
          invoke: item.tool.invoke,
        };
      }),
    );
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

  async beforeDisable() {
    unregisterBuildGuideQueue(this.app);
  }

  async afterDisable() {
    unregisterBuildGuideQueue(this.app);
  }

  async beforeUnload() {
    unregisterBuildGuideQueue(this.app);
  }

  async remove() {
    unregisterBuildGuideQueue(this.app);
  }
}

export default PluginBuildGuideBlockServer;
