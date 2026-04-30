import { InstallOptions, Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { loadXml } from './actions/loadXml';
import { saveXml } from './actions/saveXml';
import { getConfig, setConfig } from './actions/getConfig';
import { getSystemPrompt } from './actions/getSystemPrompt';
import { displayDiagramTool, editDiagramTool, appendDiagramTool, getShapeLibraryTool } from './tools';

export class PluginAIDrawioServer extends Plugin {
  private readonly schemaCollections = ['aiDiagrams', 'aiDrawioConfig'];

  afterAdd() {}

  beforeLoad() {}

  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.app.resourceManager.define({
      name: 'aiDrawio',
      actions: {
        getConfig,
        setConfig,
        getSystemPrompt,
      },
    });

    this.app.resourceManager.registerActionHandlers({
      'aiDiagrams:loadXml': loadXml,
      'aiDiagrams:saveXml': saveXml,
    });

    this.app.acl.allow('aiDiagrams', 'loadXml', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'saveXml', 'loggedIn');
    this.app.acl.allow('aiDrawio', 'getConfig', 'loggedIn');
    this.app.acl.allow('aiDrawio', 'getSystemPrompt', 'loggedIn');

    this.app.acl.registerSnippet({
      name: 'pm.ai-drawio',
      actions: [
        'aiDiagrams:create',
        'aiDiagrams:update',
        'aiDiagrams:destroy',
        'aiDiagrams:list',
        'aiDiagrams:get',
        'aiDrawio:setConfig',
      ],
    });

    this.registerAITools();
  }

  private registerAITools() {
    const aiManager = (this.app as any).aiManager;
    const toolsManager = aiManager?.toolsManager;
    if (!toolsManager) {
      this.app.logger.warn('[plugin-ai-drawio] aiManager.toolsManager is not available; skipping tool registration');
      return;
    }

    try {
      toolsManager.registerToolGroup({
        groupName: 'drawio',
        title: '{{t("Drawio", { ns: "ai-drawio" })}}',
        description: '{{t("Tools for editing draw.io diagrams via AI", { ns: "ai-drawio" })}}',
        sort: 100,
      });
    } catch (e) {
      // Group may already be registered (idempotent on hot-reload)
    }

    toolsManager.registerTools([displayDiagramTool, editDiagramTool, appendDiagramTool, getShapeLibraryTool]);
  }

  private async ensureCollectionSchema(collectionName: string) {
    const collection = this.db.getCollection(collectionName);
    if (!collection) {
      this.app.logger.warn(`[plugin-ai-drawio] Collection "${collectionName}" is not registered`);
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
      this.app.logger.info(`[plugin-ai-drawio] Added missing column "${columnName}" to "${collectionName}"`);
    }
  }

  private async ensureSchema() {
    for (const collectionName of this.schemaCollections) {
      await this.ensureCollectionSchema(collectionName);
    }

    const repo = this.db.getRepository<any>('collections');
    if (repo && typeof repo.db2cm === 'function') {
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

export default PluginAIDrawioServer;
