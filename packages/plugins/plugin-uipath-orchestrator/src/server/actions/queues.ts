/**
 * Queue actions
 *
 * - definitions:      GET /odata/QueueDefinitions
 * - items:            GET /odata/QueueItems
 * - getItem:          GET /odata/QueueItems({id})
 * - addItem:          POST /odata/Queues/UiPathODataSvc.AddQueueItem
 * - setTransactionResult: POST /odata/QueueItems({id})/UiPathODataSvc.SetTransactionResult
 * - processingHistory: GET /odata/QueueItems({id})/UiPathODataSvc.GetItemProcessingHistory
 * - retry:            PUT /odata/QueueItems({id}) with ReviewStatus=Retry
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

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

    addItem: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        const itemData: any = {
          Name: values.queueName,
          Priority: values.priority || 'Normal',
          SpecificContent: values.specificContent || {},
          Reference: values.reference,
          DeferDate: values.deferDate,
          DueDate: values.dueDate,
        };

        // Clean undefined
        Object.keys(itemData).forEach((k) => {
          if (itemData[k] === undefined) delete itemData[k];
        });

        const result = await client.post('/odata/Queues/UiPathODataSvc.AddQueueItem', { itemData }, { folder });

        await plugin.auditLog(ctx, {
          action: 'add_queue_item',
          resourceType: 'queueItem',
          resourceId: values.queueName,
          instanceId: Number(instanceId),
          folder,
          details: { reference: values.reference },
        });

        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    setTransactionResult: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        const result = await client.post(
          `/odata/QueueItems(${values.itemId})/UiPathODataSvc.SetTransactionResult`,
          {
            transactionResult: {
              IsSuccessful: values.isSuccessful,
              ProcessingException: values.processingException,
              Output: values.output,
            },
          },
          { folder },
        );

        await plugin.auditLog(ctx, {
          action: 'set_transaction_result',
          resourceType: 'queueItem',
          resourceId: String(values.itemId),
          instanceId: Number(instanceId),
          folder,
        });

        ctx.body = result;
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

    retry: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        // Set ReviewStatus to "Retry" triggers a re-process
        const result = await client.put(`/odata/QueueItems(${filterByTk})`, { ReviewStatus: 'Retry' }, { folder });

        await plugin.auditLog(ctx, {
          action: 'retry_queue_item',
          resourceType: 'queueItem',
          resourceId: String(filterByTk),
          instanceId: Number(instanceId),
          folder,
        });

        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
