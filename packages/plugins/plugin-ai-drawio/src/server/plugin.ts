import { InstallOptions, Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { loadXml } from './actions/loadXml';
import { saveXml } from './actions/saveXml';
import { getConfig, setConfig } from './actions/getConfig';
import { getSystemPrompt } from './actions/getSystemPrompt';
import { displayDiagramTool, editDiagramTool, appendDiagramTool, getShapeLibraryTool } from './tools';

export class PluginAIDrawioServer extends Plugin {
  private readonly schemaCollections = ['aiDiagrams', 'aiDrawioConfig'];

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

    this.app.resourceManager.registerActionHandlers({
      'aiDiagrams:loadXml': loadXml,
      'aiDiagrams:saveXml': saveXml,
      'aiDiagrams:getMeta': async (ctx: any, next: any) => {
        const { filterByTk } = ctx.action.params;
        const repository = ctx.db.getRepository('aiDiagrams');
        const model = await repository.findById(filterByTk);
        if (!model) ctx.throw(404, 'Diagram not found');
        const { assertDiagramAccess } = await import('./actions/access');
        assertDiagramAccess(ctx, model);
        ctx.body = { id: model.get('id'), title: model.get('title') };
        await next();
      },
    });

    this.app.acl.allow('aiDiagrams', 'loadXml', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'saveXml', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'getMeta', 'loggedIn');
    this.app.acl.allow('aiDrawio', 'getConfig', 'loggedIn');
    this.app.acl.allow('aiDrawio', 'getSystemPrompt', 'loggedIn');

    this.app.acl.registerSnippet({
      name: 'pm.ai-drawio',
      actions: [
        'aiDiagrams:create',
        'aiDiagrams:update',
        'aiDiagrams:destroy',
        'aiDiagrams:list',
        'aiDrawio:setConfig',
      ],
    });

    this.registerAITools();
  }

  private registerAITools() {
    const pluginAI = this.app.pm.get('@nocobase/plugin-ai') as any;
    const toolsManager = pluginAI?.aiManager?.toolsManager;
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
      this.app.logger.debug('[plugin-ai-drawio] Tool group drawio already registered or failed: ' + e);
    }

    toolsManager.registerTools([displayDiagramTool, editDiagramTool, appendDiagramTool, getShapeLibraryTool]);
  }

  async install(options?: InstallOptions) {
  }

  async upgrade() {
  }
}

export default PluginAIDrawioServer;
