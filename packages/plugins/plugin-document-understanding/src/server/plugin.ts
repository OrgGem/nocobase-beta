import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { DocumentUnderstandingService } from './services/DocumentUnderstandingService';
import { defineActions } from './actions';
import { createDynamicPipelineToolsProvider } from './tools/document-understanding-tool';
import { seedDugateEndpoints } from './dugate-seed';

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

  async beforeLoad() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });
  }

  async load() {
    // Collections are imported in beforeLoad so database metadata exists before
    // resources and runtime services are registered.
    this.service = new DocumentUnderstandingService(this.app, this.db);

    // Register REST actions
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

  async afterStart() {
    try {
      await this.service.initialize({ recoverJobs: true });
    } catch (err) {
      this.app.logger.warn('Document Understanding plugin not configured yet, skip init.', err);
    }
  }

  async install() {
    // Seed the DUGate-compatible endpoint/pipeline catalog on first install.
    // Subpaths stay relative so they follow the base URL in Service Config.
    try {
      await seedDugateEndpoints(this.db);
    } catch (err) {
      this.app.logger.warn('Document Understanding: DUGate seed data could not be installed.', err);
    }
  }

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}

  async beforeStop() {
    this.app.off?.('afterStart', this.registerAIToolsAfterStart);
    this.app.removeListener?.('afterStart', this.registerAIToolsAfterStart);
    this.service?.destroy();
    const runtimeState = this.app as typeof this.app & DocumentToolRuntimeState;
    if (runtimeState.documentUnderstandingService === this.service) {
      runtimeState.documentUnderstandingService = undefined;
    }
  }
}

export default PluginDocumentUnderstandingServer;
