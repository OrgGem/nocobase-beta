import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { DocumentUnderstandingService } from './services/DocumentUnderstandingService';
import { defineActions } from './actions';
import { createDynamicPipelineToolsProvider } from './tools/document-understanding-tool';

type DynamicToolsProvider = ReturnType<typeof createDynamicPipelineToolsProvider>;

interface AiPluginLike {
  ai?: {
    toolsManager?: {
      registerDynamicTools: (provider: DynamicToolsProvider) => void;
    };
  };
}

const isAiPluginLike = (plugin: unknown): plugin is AiPluginLike => {
  const candidate = plugin as AiPluginLike;
  return typeof candidate?.ai?.toolsManager?.registerDynamicTools === 'function';
};

export class PluginDocumentUnderstandingServer extends Plugin {
  public service!: DocumentUnderstandingService;

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 1. Import collections
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    // 2. Create service
    this.service = new DocumentUnderstandingService(this.app, this.db);

    // Defer initialization to after app has loaded database so config exists
    this.app.on('afterStart', async () => {
      try {
        await this.service.initialize({ recoverJobs: true });
      } catch (err) {
        this.app.logger.warn('Document Understanding plugin not configured yet, skip init.', err);
      }
    });

    // 3. Register REST actions
    this.registerActions();

    // 4. Register AI tool (graceful)
    this.registerAITools();

    // 5. ACL
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['docUnderstanding:*'],
    });
  }

  private registerActions() {
    const actions = defineActions(this);

    const resourceName = 'docUnderstanding';
    this.app.resource({
      name: resourceName,
      actions: {
        getConfig: actions.getConfig,
        updateConfig: actions.updateConfig,
        listEndpoints: actions.listEndpoints,
        createEndpoint: actions.createEndpoint,
        updateEndpoint: actions.updateEndpoint,
        deleteEndpoint: actions.deleteEndpoint,
        listPipelines: actions.listPipelines,
        createPipeline: actions.createPipeline,
        updatePipeline: actions.updatePipeline,
        deletePipeline: actions.deletePipeline,
        executePipeline: actions.executePipeline,
        getJobStatus: actions.getJobStatus,
        listJobs: actions.listJobs,
        webhookCallback: actions.webhookCallback,
      },
    });
  }

  private registerAITools() {
    try {
      const aiPlugin = this.app.pm.get('@nocobase/plugin-ai');
      if (!isAiPluginLike(aiPlugin)) {
        this.app.logger.warn('Document Understanding: plugin-ai not available, skip AI tool registration.');
        return;
      }
      aiPlugin.ai.toolsManager.registerDynamicTools(createDynamicPipelineToolsProvider(this.service));
      this.app.logger.info('Document Understanding: Dynamic pipeline tools provider registered.');
    } catch (err) {
      this.app.logger.warn('Document Understanding: Failed to register AI tools, continue without it.', err);
    }
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginDocumentUnderstandingServer;
