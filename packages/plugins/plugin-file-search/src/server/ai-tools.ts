/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import type { ToolsManager } from '@nocobase/ai';
import type { Application } from '@nocobase/server';
import { z } from 'zod';
import { getOrCreateSettings } from './services/settings';
import type { ActionHandler } from './types';

const schema = z.object({
  query: z.string().trim().min(1).describe('Search query'),
  fileCollection: z.string().optional().describe('Optional file collection filter'),
  topK: z.number().int().min(1).max(50).optional().describe('Maximum number of results'),
});

export function registerFileSearchAiTool(app: Application, searchAction: ActionHandler) {
  try {
    const toolsManager = (app as Application & { aiManager?: { toolsManager?: ToolsManager } }).aiManager?.toolsManager;
    if (!toolsManager) {
      app.log?.warn?.('[plugin-file-search] AI tools manager is not available; skipping file_search tool.');
      return;
    }
    toolsManager.registerTools({
      scope: 'CUSTOM',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: { title: 'File search', about: 'Search accessible files.' },
      definition: {
        name: 'file_search',
        description: 'Search files that the current NocoBase user is allowed to access.',
        schema,
      },
      invoke: async (ctx: Context, args: unknown) => {
        const t = (key: string) => ctx.t(key, { ns: 'plugin-file-search' });
        if (!ctx.state?.currentUser?.id && !ctx.auth?.user?.id) ctx.throw(401, t('Authentication required.'));
        const parsed = schema.safeParse(args);
        if (!parsed.success) return { status: 'error', content: t('Invalid file search input.') };
        const settings = await getOrCreateSettings(app.db);
        if (!settings.enableAiTool) return { status: 'error', content: t('File search AI tool is disabled.') };

        // Preserve Koa/auth prototype methods and user state while isolating the action parameters and response.
        const searchCtx: Context = Object.create(ctx);
        Object.defineProperties(searchCtx, {
          app: { value: app },
          db: { value: app.db },
          database: { value: app.db },
          dataSource: { value: app.dataSourceManager.get('main') },
          action: { value: { resourceName: 'fileSearch', actionName: 'search', params: { values: parsed.data } } },
          body: { value: undefined, writable: true },
        });
        await searchAction(searchCtx, async () => undefined);
        const result = searchCtx.body as { rows?: unknown } | undefined;
        return { status: 'success', content: JSON.stringify(Array.isArray(result?.rows) ? result.rows : []) };
      },
    });
  } catch (error) {
    app.log?.warn?.(
      '[plugin-file-search] Failed to register file_search AI tool; plugin will continue loading.',
      error,
    );
  }
}
