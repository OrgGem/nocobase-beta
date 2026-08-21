import { InstallOptions, Plugin } from '@nocobase/server';
import type { ToolsOptions } from '@nocobase/ai';
import { resolve } from 'path';
import { getConfig, setConfig } from './actions/getConfig';
import { getSystemPrompt } from './actions/getSystemPrompt';
import {
  displayModelDiagramTool,
  displayDiagramTool,
  editDiagramTool,
  appendDiagramTool,
  getShapeLibraryTool,
  inspectDiagramTool,
} from './tools';
import type { DrawioToolDefinition } from './tools/types';

export class PluginAIDrawioServer extends Plugin {
  private readonly schemaCollections = ['aiDrawioConfig'];

  async load() {
    await this.importCollections(resolve(__dirname, 'collections'));

    this.app.resourceManager.define({
      name: 'aiDrawio',
      actions: {
        getConfig,
        setConfig,
        getSystemPrompt,
      },
    });

    // All logged-in users can read the config and system prompt (needed to
    // render the draw.io iframe and for AI Employee prompt setup).
    this.app.acl.allow('aiDrawio', 'getConfig', 'loggedIn');
    this.app.acl.allow('aiDrawio', 'getSystemPrompt', 'loggedIn');

    // Admin snippet for setting the draw.io base URL.
    this.app.acl.registerSnippet({
      name: 'pm.ai-drawio',
      actions: ['aiDrawio:setConfig'],
    });

    this.registerAITools();
  }

  private registerAITools() {
    const toolsManager = this.app.aiManager?.toolsManager;
    if (!toolsManager) {
      this.app.logger.warn('[plugin-ai-drawio] aiManager.toolsManager is not available; skipping tool registration');
      return;
    }

    const autoApprovedFrontendTools = new Set(['inspect_active_diagram']);
    const tools = [
      inspectDiagramTool,
      displayModelDiagramTool,
      displayDiagramTool,
      editDiagramTool,
      appendDiagramTool,
      getShapeLibraryTool,
    ].map((item) => this.toRegisteredTool(item, autoApprovedFrontendTools));
    toolsManager.registerTools(tools);
  }

  private toRegisteredTool(item: DrawioToolDefinition, autoApprovedFrontendTools: ReadonlySet<string>): ToolsOptions {
    const name = `${item.groupName}-${item.tool.name}`;
    const isAutoApproved = item.tool.execution === 'backend' || autoApprovedFrontendTools.has(item.tool.name);
    return {
      scope: 'GENERAL',
      defaultPermission: isAutoApproved ? 'ALLOW' : 'ASK',
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
  }

  async install(options?: InstallOptions) {}

  async upgrade() {}
}

export default PluginAIDrawioServer;
