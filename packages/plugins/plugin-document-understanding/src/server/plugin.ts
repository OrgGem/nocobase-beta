import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { DocumentUnderstandingService } from './services/DocumentUnderstandingService';
import { defineActions } from './actions';
import { createDynamicPipelineToolsProvider } from './tools/document-understanding-tool';

type DynamicToolsProvider = ReturnType<typeof createDynamicPipelineToolsProvider>;

interface AiManagerLike {
  toolsManager?: {
    registerDynamicTools: (provider: DynamicToolsProvider) => void;
  };
}

interface DocumentToolRuntimeState {
  documentUnderstandingToolProviderRegistered?: boolean;
  documentUnderstandingService?: DocumentUnderstandingService;
}

const isAiManagerLike = (manager: unknown): manager is AiManagerLike => {
  const candidate = manager as AiManagerLike;
  return typeof candidate?.toolsManager?.registerDynamicTools === 'function';
};

export class PluginDocumentUnderstandingServer extends Plugin {
  public service!: DocumentUnderstandingService;
  private aiToolsRegistered = false;
  private readonly registerAIToolsAfterStart = () => this.registerAITools();

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
    this.app.on('afterStart', this.registerAIToolsAfterStart);

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
    if (this.aiToolsRegistered) return;
    try {
      const aiManager = (this.app as typeof this.app & { aiManager?: unknown }).aiManager;
      if (!isAiManagerLike(aiManager)) {
        this.app.logger.warn('Document Understanding: plugin-ai not available, skip AI tool registration.');
        return;
      }
      const runtimeState = this.app as typeof this.app & DocumentToolRuntimeState;
      runtimeState.documentUnderstandingService = this.service;
      if (!runtimeState.documentUnderstandingToolProviderRegistered) {
        aiManager.toolsManager.registerDynamicTools(async (register) => {
          const currentService = runtimeState.documentUnderstandingService;
          if (!currentService) return;
          await createDynamicPipelineToolsProvider(currentService)(register);
        });
        runtimeState.documentUnderstandingToolProviderRegistered = true;
      }
      this.aiToolsRegistered = true;
      this.app.logger.info('Document Understanding: Dynamic pipeline tools provider registered.');
    } catch (err) {
      this.app.logger.warn('Document Understanding: Failed to register AI tools, continue without it.', err);
    }
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}

  async beforeStop() {
    this.app.off?.('afterStart', this.registerAIToolsAfterStart);
    this.app.removeListener?.('afterStart', this.registerAIToolsAfterStart);
    const runtimeState = this.app as typeof this.app & DocumentToolRuntimeState;
    if (runtimeState.documentUnderstandingService === this.service) {
      runtimeState.documentUnderstandingService = undefined;
    }
  }
}

export default PluginDocumentUnderstandingServer;
