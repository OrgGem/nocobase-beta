import type { Application } from '@nocobase/server';
import type { ActionHandler } from './types';

export function registerFileSearchAiTool(app: Application, searchAction: ActionHandler) {
  try {
    const toolsManager =
      (app as any).aiManager?.toolsManager ||
      (app as any).aiManager?.toolManager ||
      (app as any).pm?.get?.('ai')?.aiManager?.toolsManager ||
      (app as any).pm?.get?.('@nocobase/plugin-ai')?.aiManager?.toolsManager;
    if (!toolsManager?.registerTools) {
      app.log?.warn?.('[plugin-file-search] AI tools manager is not available; skipping file_search tool.');
      return;
    }

    toolsManager.registerToolGroup?.({
      groupName: 'fileSearch',
      title: 'File Search',
      description: 'Search accessible files.',
      sort: 500,
    });

    toolsManager.registerTools([
      {
        groupName: 'fileSearch',
        tool: {
          title: 'File search',
          description: 'Search files that the current NocoBase user is allowed to access.',
          execution: 'backend',
          name: 'file_search',
          schema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              fileCollection: { type: 'string', description: 'Optional file collection filter' },
              topK: { type: 'number', description: 'Maximum number of results' },
            },
            required: ['query'],
          },
          invoke: async (ctx: any, args: Record<string, unknown>) => {
            const settings = await ctx.db
              .getRepository('fileSearchSettings')
              .findOne({ filter: { singletonKey: 'default' } });
            if (settings && settings.get('enableAiTool') !== true) {
              return { status: 'error', content: 'File search AI tool is disabled.' };
            }
            const synthCtx = {
              ...ctx,
              app,
              db: ctx.db || (app as any).db,
              action: { params: { values: args } },
              request: { ...(ctx.request || {}), body: args },
            };
            await searchAction(synthCtx, async () => undefined);
            return { status: 'success', content: JSON.stringify(synthCtx.body?.rows || []) };
          },
        },
      },
    ]);
  } catch (error) {
    app.log?.warn?.(
      '[plugin-file-search] Failed to register file_search AI tool; plugin will continue loading.',
      error,
    );
  }
}
