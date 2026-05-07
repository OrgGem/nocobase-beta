/**
 * Folder actions
 *
 * - list: GET /odata/Folders
 * - sync: Fetch all folders and upsert into uipathFoldersCache
 * - setDefault: Update instance's default folder
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractODataFilter } from './shared';

export function createFolderActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const query = extractODataFilter(ctx.action.params);
        const data = await client.get('/odata/Folders', { query });
        ctx.body = { data: data.value || data };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    sync: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);

        // Fetch all folders (pagination loop)
        const allFolders: any[] = [];
        let skip = 0;
        const top = 200;
        let hasMore = true;

        while (hasMore) {
          const res = await client.get('/odata/Folders', {
            query: { $top: top, $skip: skip, $orderby: 'FullyQualifiedName asc' },
          });
          const items = res.value || [];
          allFolders.push(...items);
          skip += top;
          hasMore = items.length === top;
        }

        // Upsert into cache
        const repo = plugin.db.getRepository('uipathFoldersCache');
        const instId = Number(instanceId);

        for (const f of allFolders) {
          const existing = await repo.findOne({
            filter: { instanceId: instId, folderId: f.Id },
          });

          const values = {
            instanceId: instId,
            folderId: f.Id,
            folderKey: f.Key,
            displayName: f.DisplayName,
            fullyQualifiedName: f.FullyQualifiedName,
            parentId: f.ParentId || null,
            isPersonal: f.IsPersonal || false,
            lastSyncedAt: new Date(),
          };

          if (existing) {
            await repo.update({ filter: { id: existing.get('id') }, values });
          } else {
            await repo.create({ values });
          }
        }

        // Remove folders no longer in API
        const apiIds = allFolders.map((f) => f.Id);
        if (apiIds.length > 0) {
          const cached = await repo.find({ filter: { instanceId: instId } });
          for (const c of cached) {
            if (!apiIds.includes(Number(c.get('folderId')))) {
              await repo.destroy({ filter: { id: c.get('id') } });
            }
          }
        }

        ctx.body = { success: true, count: allFolders.length };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    setDefault: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, folderId, folderKey, folderPath } = ctx.action.params;
        const repo = plugin.db.getRepository('uipathInstances');
        await repo.update({
          filter: { id: Number(instanceId) },
          values: {
            defaultFolderId: folderId ? Number(folderId) : null,
            defaultFolderKey: folderKey || null,
            defaultFolderPath: folderPath || null,
          },
        });
        ctx.body = { success: true };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
