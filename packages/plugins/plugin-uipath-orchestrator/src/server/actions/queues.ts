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

    traceLogs: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        const queueItem = await client.get(`/odata/QueueItems(${filterByTk})`, {
          query: { $expand: 'Robot' },
          folder,
        });

        if (!queueItem) {
          throw new Error('Queue item not found');
        }

        const startProcessing = queueItem.StartProcessing;
        const endProcessing = queueItem.EndProcessing || new Date().toISOString();
        const robotId = queueItem.Robot?.Id;
        const queueItemKey = queueItem.Key;
        const reference = queueItem.Reference;

        const results: any = {
          queueItem,
          job: null,
          logs: [],
        };

        if (startProcessing) {
          let jobFilter = `StartTime le ${startProcessing} and (EndTime ge ${endProcessing} or EndTime eq null)`;
          if (robotId) {
            jobFilter += ` and Robot/Id eq ${robotId}`;
          }

          try {
            const jobsData = await client.get('/odata/Jobs', {
              query: {
                $top: 5,
                $filter: jobFilter,
                $orderby: 'StartTime desc',
              },
              folder,
            });

            const jobs = jobsData.value || [];
            if (jobs.length > 0) {
              results.job = jobs[0];
            }
          } catch (jobErr: any) {
            plugin.app.logger.warn(`[plugin-uipath] Job correlation failed: ${jobErr.message}`);
          }

          const logFilters: string[] = [];
          const startBuffer = new Date(new Date(startProcessing).getTime() - 5000).toISOString();
          const endBuffer = new Date(new Date(endProcessing).getTime() + 5000).toISOString();

          if (results.job?.Key) {
            logFilters.push(
              `(JobKey eq '${results.job.Key}' and TimeStamp ge ${startBuffer} and TimeStamp le ${endBuffer})`,
            );
          } else if (robotId) {
            logFilters.push(`(TimeStamp ge ${startBuffer} and TimeStamp le ${endBuffer})`);
          }

          const esc = (val: string) => val.replace(/'/g, "''");
          if (queueItemKey) {
            logFilters.push(`contains(Message, '${esc(queueItemKey)}')`);
          }
          if (reference) {
            logFilters.push(`contains(Message, '${esc(reference)}')`);
          }

          if (logFilters.length > 0) {
            try {
              const logsData = await client.get('/odata/RobotLogs', {
                query: {
                  $top: 200,
                  $filter: logFilters.join(' or '),
                  $orderby: 'TimeStamp asc',
                },
                folder,
              });
              results.logs = logsData.value || [];
            } catch (logErr: any) {
              plugin.app.logger.warn(`[plugin-uipath] Logs correlation failed: ${logErr.message}`);
            }
          }
        }

        ctx.body = results;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
