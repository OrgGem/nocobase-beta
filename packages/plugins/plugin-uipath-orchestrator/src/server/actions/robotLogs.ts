/**
 * Robot Logs actions
 *
 * - list:  GET /odata/RobotLogs
 * - count: GET /odata/RobotLogs/$count (with $filter)
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

const MAX_RESOLVED_JOB_KEYS = 10;

function escapeODataString(value: string) {
  return value.replace(/'/g, "''");
}

function uniqueStrings(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function extractJobKeysFromValue(value: any): string[] {
  const found: string[] = [];

  const visit = (current: any, keyName = '') => {
    if (current == null) return;
    if (typeof current === 'string') {
      if (/job_?key|jobkey/i.test(keyName)) {
        found.push(current);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, keyName));
      return;
    }
    if (typeof current === 'object') {
      for (const [key, val] of Object.entries(current)) {
        visit(val, key);
      }
    }
  };

  visit(value);
  return uniqueStrings(found);
}

function buildJobKeyFilter(jobKeys: string[]) {
  return jobKeys.map((key) => `JobKey eq '${escapeODataString(key)}'`).join(' or ');
}

function buildMessageContainsFilter(values: string[]) {
  return values.map((value) => `contains(Message, '${escapeODataString(value)}')`).join(' or ');
}

export function createRobotLogActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);

        // Default: newest first
        if (!query.$orderby) query.$orderby = 'TimeStamp desc';

        const data = await client.get('/odata/RobotLogs', { query, folder });
        ctx.body = {
          data: data.value || data,
          count: data['@odata.count'],
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    search: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, jobKey, message, queueItem, queueItemId, level } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);
        const resolvedJobKeys: string[] = jobKey ? [String(jobKey).trim()] : [];
        const queueTerms: string[] = [];

        if (!query.$orderby) query.$orderby = 'TimeStamp desc';

        const queueLookup = queueItemId || queueItem;
        if (!resolvedJobKeys.length && queueLookup) {
          const lookup = String(queueLookup).trim();
          queueTerms.push(lookup);

          try {
            const queueData = /^\d+$/.test(lookup)
              ? await client.get(`/odata/QueueItems(${lookup})`, { folder })
              : await client.get('/odata/QueueItems', {
                  query: {
                    $top: 5,
                    $filter: `Key eq '${escapeODataString(lookup)}' or Reference eq '${escapeODataString(lookup)}'`,
                  },
                  folder,
                });
            const queueItems = Array.isArray(queueData?.value) ? queueData.value : [queueData];
            for (const item of queueItems) {
              if (item?.Key) queueTerms.push(String(item.Key));
              if (item?.Reference) queueTerms.push(String(item.Reference));
              resolvedJobKeys.push(...extractJobKeysFromValue(item));
            }
          } catch {
            // Queue lookup is best-effort; the message fallback below can still find logs.
          }
        }

        if (!resolvedJobKeys.length && message) {
          const messageLogs = await client.get('/odata/RobotLogs', {
            query: {
              $top: 100,
              $filter: `contains(Message, '${escapeODataString(String(message).trim())}')`,
              $orderby: 'TimeStamp desc',
            },
            folder,
          });
          const logs = Array.isArray(messageLogs?.value) ? messageLogs.value : [];
          resolvedJobKeys.push(...uniqueStrings(logs.map((log: any) => log?.JobKey)));
        }

        if (!resolvedJobKeys.length && queueTerms.length) {
          const queueLogFilter = buildMessageContainsFilter(uniqueStrings(queueTerms));
          if (queueLogFilter) {
            const queueLogs = await client.get('/odata/RobotLogs', {
              query: { $top: 100, $filter: queueLogFilter, $orderby: 'TimeStamp desc' },
              folder,
            });
            const logs = Array.isArray(queueLogs?.value) ? queueLogs.value : [];
            resolvedJobKeys.push(...uniqueStrings(logs.map((log: any) => log?.JobKey)));
          }
        }

        const filterParts: string[] = [];
        if (level) filterParts.push(`Level eq '${escapeODataString(String(level))}'`);

        const limitedJobKeys = uniqueStrings(resolvedJobKeys).slice(0, MAX_RESOLVED_JOB_KEYS);
        if (limitedJobKeys.length) {
          filterParts.push(`(${buildJobKeyFilter(limitedJobKeys)})`);
        } else if (message) {
          filterParts.push(`contains(Message, '${escapeODataString(String(message).trim())}')`);
        } else if (queueTerms.length) {
          const queueLogFilter = buildMessageContainsFilter(uniqueStrings(queueTerms));
          if (queueLogFilter) filterParts.push(`(${queueLogFilter})`);
        }

        if (ctx.action.params.filter) filterParts.push(`(${ctx.action.params.filter})`);
        query.$filter = filterParts.join(' and ') || query.$filter;

        const data = await client.get('/odata/RobotLogs', { query, folder });
        ctx.body = {
          data: data.value || data,
          count: data['@odata.count'],
          jobKeys: limitedJobKeys,
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    count: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        // Build filter for count — e.g., errors in last 24h
        const { filter: odataFilter } = ctx.action.params;
        const query: Record<string, any> = {};
        if (odataFilter) query.$filter = odataFilter;

        const data = await client.get('/odata/RobotLogs/$count', { query, folder });
        ctx.body = { count: typeof data === 'number' ? data : Number(data) || 0 };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
