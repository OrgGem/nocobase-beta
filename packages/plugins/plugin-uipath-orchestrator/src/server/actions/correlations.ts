import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { UiPathCorrelationService } from '../services/UiPathCorrelationService';
import { handleError, extractFolderContext } from './shared';

export function createCorrelationActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    fromLog: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, logId, jobKey, timeStamp, queueItemId, queueItemKey, queueReference, bufferSeconds } =
          ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const service = new UiPathCorrelationService(client, plugin.app.logger);

        ctx.body = await service.fromLog({
          logId,
          jobKey,
          timeStamp,
          queueItemId,
          queueItemKey,
          queueReference,
          bufferSeconds: Number(bufferSeconds) || undefined,
          folder,
        });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    fromQueueItem: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, queueItemId, filterByTk, bufferSeconds } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const service = new UiPathCorrelationService(client, plugin.app.logger);

        ctx.body = await service.fromQueueItem({
          queueItemId: queueItemId || filterByTk,
          bufferSeconds: Number(bufferSeconds) || undefined,
          folder,
        });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    fromJob: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, jobId, jobKey, filterByTk, bufferSeconds } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const service = new UiPathCorrelationService(client, plugin.app.logger);

        ctx.body = await service.fromJob({
          jobId: jobId || filterByTk,
          jobKey,
          bufferSeconds: Number(bufferSeconds) || undefined,
          folder,
        });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
