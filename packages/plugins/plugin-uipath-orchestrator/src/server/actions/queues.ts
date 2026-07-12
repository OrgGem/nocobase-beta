/**
 * Queue actions
 *
 * - definitions:      GET /odata/QueueDefinitions
 * - items:            GET /odata/QueueItems
 * - getItem:          GET /odata/QueueItems({id})
 * - processingHistory: GET /odata/QueueItems({id})/UiPathODataSvc.GetItemProcessingHistory
 * - traceLogs:        Read-only correlation view for a queue item
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';
import { UiPathCorrelationService } from '../services/UiPathCorrelationService';

export function createQueueActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    definitions: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);

        const data = await client.get('/odata/QueueDefinitions', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    items: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);

        if (!query.$orderby) query.$orderby = 'CreationTime desc';

        const data = await client.get('/odata/QueueItems', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    getItem: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get(`/odata/QueueItems(${filterByTk})`, { folder });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    processingHistory: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const data = await client.get(`/odata/QueueItems(${filterByTk})/UiPathODataSvc.GetItemProcessingHistory`, {
          folder,
        });
        ctx.body = { data: data.value || data };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    traceLogs: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const service = new UiPathCorrelationService(client, plugin.app.logger);
        ctx.body = await service.fromQueueItem({ queueItemId: filterByTk, folder });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
