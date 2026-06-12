import { InstallOptions, Plugin } from '@nocobase/server';
import { resolve } from 'path';
import type { ZodTypeAny } from 'zod';
import { COLLECTION_NAME, SETTINGS_COLLECTION_NAME } from '../shared/constants';
import {
  build,
  getResult,
  recoverInterruptedBuilds,
  registerBuildQueue,
  retry,
  startBuildQueueProcessor,
  unregisterBuildQueue,
} from './actions/build';
import aiVisualizationBuildSettings from './resource/settings';
import { buildVisualizationBlockTool } from './tools';

/**
 * Minimal shape of the `collections` repository we rely on here. The full
 * repository carries many members we do not use; declaring only `db2cm`
 * isolates the loose typing to this narrow surface instead of spreading `any`.
 */
interface CollectionsRepository {
  db2cm(collectionName: string): Promise<unknown>;
}

/**
 * The minimal shape of a registerable AI tool descriptor, mirroring the default
 * export of `./tools/*`. Typing this (rather than `any`) keeps the tool mapping
 * in {@link PluginBuildVisualizationBlockServer.registerAITools} type-safe.
 */
interface AIToolDescriptor {
  groupName: string;
  tool: {
    name: string;
    title: string;
    description: string;
    execution: string;
    schema: ZodTypeAny;
    invoke: (...args: unknown[]) => unknown;
  };
}

/**
 * The minimal surface of the (untyped) `aiManager.toolsManager` we depend on.
 * The AI subsystem is not typed against the server core, so we narrow it to the
 * single `registerTools` method we call.
 */
interface AIToolsManagerLike {
  registerTools(tools: Record<string, unknown>[]): void;
}

/**
 * Server-side plugin for `plugin-build-visualization-block`.
 *
 * Lifecycle responsibilities:
 * - `beforeLoad`: import the collection definitions so the database/model layer
 *   is available before resources are registered.
 * - `load`: register resource actions, ACL snippets, AI tools, and lifecycle
 *   handlers for the asynchronous build queue.
 * - `afterStart` / `beforeStop`: start and stop the runtime queue processor.
 * - `install` / `upgrade`: reconcile schema idempotently for fresh installs and
 *   upgrades.
 */
export class PluginBuildVisualizationBlockServer extends Plugin {
  private readonly schemaCollections = [COLLECTION_NAME, SETTINGS_COLLECTION_NAME];

  afterAdd() {}

  async beforeLoad() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });
  }

  async load() {
    // Build / retry / poll action handlers (Req 10.1, 12.3, 9.4).
    this.app.resourceManager.registerActionHandlers({
      'aiVisualizationBuilds:build': build,
      'aiVisualizationBuilds:retry': retry,
      'aiVisualizationBuilds:getResult': getResult,
    });
    this.app.resourceManager.define(aiVisualizationBuildSettings);

    // The polling read is allowed to any logged-in user; ownership/permission
    // is enforced inside the action and via the per-collection `list` check.
    this.app.acl.allow('aiVisualizationBuilds', 'getResult', 'loggedIn');
    this.app.acl.allow(SETTINGS_COLLECTION_NAME, 'publicGet', 'loggedIn');

    // ACL snippet so the resource's CRUD + build actions can be granted to a
    // role from the plugin-manager permissions UI (Req 13.1).
    this.app.acl.registerSnippet({
      name: 'pm.ai-build-visualization',
      actions: [
        'aiVisualizationBuilds:create',
        'aiVisualizationBuilds:update',
        'aiVisualizationBuilds:destroy',
        'aiVisualizationBuilds:list',
        'aiVisualizationBuilds:get',
        'aiVisualizationBuilds:build',
        'aiVisualizationBuilds:retry',
        'aiVisualizationBuilds:getResult',
      ],
    });
    this.app.acl.registerSnippet({
      name: 'pm.plugin-build-visualization-block.settings',
      actions: [`${SETTINGS_COLLECTION_NAME}:get`, `${SETTINGS_COLLECTION_NAME}:update`],
    });

    registerBuildQueue(this.app);

    // Start runtime queue services only after the app has started, then resume
    // builds that were interrupted before their worker finished.
    this.app.on('afterStart', async () => {
      startBuildQueueProcessor(this.app);
      try {
        await recoverInterruptedBuilds(this.app);
      } catch (err) {
        this.app.logger.warn('[plugin-build-visualization-block] Failed to recover interrupted builds', err);
      }
    });
    this.app.on('beforeStop', () => {
      unregisterBuildQueue(this.app);
    });
    this.app.on('beforeDestroy', () => {
      unregisterBuildQueue(this.app);
    });

    this.registerAITools();
  }

  /**
   * Register the `build_visualization_block` AI tool through the AI plugin's
   * tools manager so an AI chat agent can initiate a build. The AI subsystem is
   * untyped against the server core, so the manager is resolved through a
   * narrow cast and guarded for absence (the plugin must not hard-depend on the
   * AI plugin being installed).
   */
  private registerAITools() {
    const toolsManager = (this.app as unknown as { aiManager?: { toolsManager?: AIToolsManagerLike } }).aiManager
      ?.toolsManager;
    if (!toolsManager) {
      this.app.logger.warn(
        '[plugin-build-visualization-block] aiManager.toolsManager is not available; skipping tool registration',
      );
      return;
    }

    const tools: AIToolDescriptor[] = [buildVisualizationBlockTool];
    toolsManager.registerTools(
      tools.map((item) => {
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
      this.app.logger.warn(`[plugin-build-visualization-block] Collection "${collectionName}" is not registered`);
      return;
    }

    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();
    let columns: Record<string, unknown> | null = null;

    try {
      columns = await queryInterface.describeTable(tableName);
    } catch (error) {
      await collection.model.sync();
      columns = await queryInterface.describeTable(tableName);
    }

    const attributes = collection.model.rawAttributes;
    for (const [attributeName, attribute] of Object.entries(attributes)) {
      const columnName = attribute.field || attributeName;
      if (columns[columnName]) {
        continue;
      }

      // `rawAttributes` entries carry runtime-only members (`Model`,
      // `fieldName`) that are not valid column definitions; strip them via a
      // loose record before handing the definition to the query interface.
      const columnDefinition: Record<string, unknown> = { ...attribute };
      delete columnDefinition.Model;
      delete columnDefinition.fieldName;

      await queryInterface.addColumn(
        tableName,
        columnName,
        columnDefinition as Parameters<typeof queryInterface.addColumn>[2],
      );
      columns[columnName] = columnDefinition;
      this.app.logger.info(
        `[plugin-build-visualization-block] Added missing column "${columnName}" to "${collectionName}"`,
      );
    }
  }

  private async ensureSchema() {
    for (const collectionName of this.schemaCollections) {
      await this.ensureCollectionSchema(collectionName);
    }

    const repo = this.db.getRepository('collections') as unknown as CollectionsRepository | undefined;
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
    unregisterBuildQueue(this.app);
  }

  async afterDisable() {
    unregisterBuildQueue(this.app);
  }

  async beforeUnload() {
    unregisterBuildQueue(this.app);
  }

  async remove() {
    unregisterBuildQueue(this.app);
  }
}

export default PluginBuildVisualizationBlockServer;
