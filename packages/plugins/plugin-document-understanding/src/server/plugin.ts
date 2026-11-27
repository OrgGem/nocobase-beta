// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/server';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import { resolve } from 'path';
import { DocumentUnderstandingService } from './services/DocumentUnderstandingService';
import { defineActions } from './actions';
import { createDynamicPipelineToolsProvider } from './tools/document-understanding-tool';
import { seedDugateEndpoints } from './dugate-seed';
import { createDuDisableBodyParserMiddleware, createDuGatewayRouter } from './routes/du-gateway-router';
import { DocumentUnderstandingWorkflowInstruction } from './workflow/DocumentUnderstandingInstruction';

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
    this.service = new DocumentUnderstandingService(this.app, this.db);
    const runtimeState = this.app as typeof this.app & DocumentToolRuntimeState;
    runtimeState.documentUnderstandingService = this.service;

    // 1. Mount `du-rework` compatible Public Gateway (/api/du/v1/* & /api/v1/*) before resourcer
    this.app.use(createDuDisableBodyParserMiddleware(), {
      tag: 'docUnderstandingDisableBodyParser',
      before: 'bodyParser',
    });
    this.app.use(
      createDuGatewayRouter(() => this.service),
      {
        tag: 'docUnderstandingPublicGateway',
        before: 'dataSource',
        after: 'dataWrapping',
      },
    );

    // 2. Register NocoBase Admin/Operator REST actions
    this.registerActions();

    // 3. Register NocoBase Workflow Instruction node (graceful when plugin-workflow is present)
    this.registerWorkflowInstruction();

    // 4. Register Dynamic AI tools (graceful when plugin-ai is present)
    this.registerAITools();
    this.app.on('afterStart', this.registerAIToolsAfterStart);

    // 5. ACL snippet for admin settings & operations
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['docUnderstanding:*'],
    });
  }

  private registerActions() {
    const actions = defineActions(this);

    this.app.resource({
      name: 'docUnderstanding',
      actions: {
        getConfig: actions.getConfig,
        updateConfig: actions.updateConfig,
        getHealth: actions.getHealth,
        listLlmServices: actions.listLlmServices,
        listCatalog: actions.listCatalog,
        syncCatalog: actions.syncCatalog,
        listApiKeys: actions.listApiKeys,
        issueApiKey: actions.issueApiKey,
        revokeApiKey: actions.revokeApiKey,
        listOperations: actions.listOperations,
        getOperation: actions.getOperation,
        submitOperation: actions.submitOperation,
        cancelOperation: actions.cancelOperation,
        resumeOperation: actions.resumeOperation,
        getUsageSummary: actions.getUsageSummary,
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
        cancelJob: actions.cancelJob,
        resumeJob: actions.resumeJob,
        webhookCallback: actions.webhookCallback,
      },
    });
  }

  private registerWorkflowInstruction() {
    try {
      const workflow = (this.app.pm?.get?.('workflow') || this.app.pm?.get?.('@nocobase/plugin-workflow')) as
        | WorkflowPlugin
        | undefined;
      if (workflow?.registerInstruction) {
        workflow.registerInstruction('document-understanding', new DocumentUnderstandingWorkflowInstruction(workflow));
      }
    } catch (err) {
      this.app.logger.warn('Document Understanding: skipped workflow instruction registration.', err);
    }
  }

  private registerAITools() {
    if (this.aiToolsRegistered) return;
    try {
      const aiManager =
        (this.app as typeof this.app & { aiManager?: unknown }).aiManager ||
        this.app.pm?.get?.('@nocobase/plugin-ai')?.aiManager ||
        this.app.pm?.get?.('ai')?.aiManager;
      if (!isAiManagerLike(aiManager)) {
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
    } catch (err) {
      this.app.logger.warn('Document Understanding: Failed to register AI tools, continue without it.', err);
    }
  }

  async afterStart() {
    try {
      await this.service.initialize({ recoverJobs: true });
      // Automatically migrate/seed canonical `du-rework` v1 endpoints & pipelines on startup
      await seedDugateEndpoints(this.db);
    } catch (err) {
      this.app.logger.warn('Document Understanding startup initialization / catalog sync warning:', err);
    }
  }

  async install() {
    try {
      await seedDugateEndpoints(this.db);
    } catch (err) {
      this.app.logger.warn('Document Understanding: catalog seed data could not be installed.', err);
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
