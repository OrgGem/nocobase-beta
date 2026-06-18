import { InstallOptions, Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { loadXml } from './actions/loadXml';
import { saveXml } from './actions/saveXml';
import { getConfig, setConfig } from './actions/getConfig';
import { getSystemPrompt } from './actions/getSystemPrompt';
import { assertDiagramRead, resolveAccessContext } from './actions/access';
import aiDiagramsResource from './resources/ai-diagrams';
import {
  displayModelDiagramTool,
  displayDiagramTool,
  editDiagramTool,
  appendDiagramTool,
  getShapeLibraryTool,
} from './tools';

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

    // ACL-enforcing CRUD for aiDiagrams (BASIC/SHARED/PUBLIC + agent access).
    this.app.resourceManager.define(aiDiagramsResource);

    this.app.resourceManager.registerActionHandlers({
      'aiDiagrams:loadXml': loadXml,
      'aiDiagrams:saveXml': saveXml,
      'aiDiagrams:getMeta': async (ctx: any, next: any) => {
        const { filterByTk } = ctx.action.params;
        const repository = ctx.db.getRepository('aiDiagrams');
        const model = await repository.findById(filterByTk);
        if (!model) ctx.throw(404, 'Diagram not found');
        const access = await resolveAccessContext(ctx, ctx.db);
        assertDiagramRead(ctx, access, model.toJSON ? model.toJSON() : model);
        ctx.body = { id: model.get('id'), title: model.get('title'), mode: model.get('mode') || 'editable' };
        await next();
      },
    });

    // Open the ACL gate for logged-in users; the resource handlers above enforce
    // the row-level policy (BASIC owner, SHARED roles, PUBLIC, and agent access).
    this.app.acl.allow('aiDiagrams', 'list', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'get', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'create', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'update', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'destroy', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'loadXml', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'saveXml', 'loggedIn');
    this.app.acl.allow('aiDiagrams', 'getMeta', 'loggedIn');
    this.app.acl.allow('aiDrawio', 'getConfig', 'loggedIn');
    this.app.acl.allow('aiDrawio', 'getSystemPrompt', 'loggedIn');

    // Admin snippet: full management bypass + plugin configuration.
    this.app.acl.registerSnippet({
      name: 'pm.ai-drawio',
      actions: ['aiDiagrams:*', 'aiDrawio:setConfig'],
    });

    this.registerAITools();
  }

  private registerAITools() {
    const toolsManager = this.app.aiManager?.toolsManager;
    if (!toolsManager) {
      this.app.logger.warn('[plugin-ai-drawio] aiManager.toolsManager is not available; skipping tool registration');
      return;
    }

    toolsManager.registerTools(
      [displayModelDiagramTool, displayDiagramTool, editDiagramTool, appendDiagramTool, getShapeLibraryTool].map(
        (item: any) => {
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
        },
      ),
    );
  }

  async install(options?: InstallOptions) {}

  async upgrade() {}
}

export default PluginAIDrawioServer;
