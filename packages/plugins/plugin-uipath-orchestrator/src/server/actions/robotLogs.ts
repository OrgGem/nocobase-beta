/**
 * Robot Logs actions
 *
 * - list:  GET /odata/RobotLogs
 * - count: GET /odata/RobotLogs/$count (with $filter)
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';
import { fetch as undiciFetch } from 'undici';

const MAX_RESOLVED_JOB_KEYS = 10;
const DEFAULT_ES_INDEX = 'default-robotlogs-*';

type EsConfig = {
  nodes: string[];
  index: string;
  username?: string;
  password?: string;
};

type EsLogSource = Record<string, any>;

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

function parseEsNodes(value: unknown): string[] {
  if (!value || typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
    }
  } catch {
    // Fallback to comma/newline separated nodes.
  }

  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function resolveEsConfig(plugin: PluginUiPathOrchestratorServer, instanceId: unknown): Promise<EsConfig | null> {
  const repo = plugin.db.getRepository('uipathInstances');
  let instance: any;

  if (instanceId) {
    instance = await repo.findOne({ filter: { id: Number(instanceId) } });
  }
  if (!instance) {
    instance = await repo.findOne({ filter: { isDefault: true, enabled: true } });
  }
  if (!instance) {
    instance = await repo.findOne({ filter: { enabled: true } });
  }
  if (!instance?.get('esEnabled')) {
    return null;
  }

  const nodes = parseEsNodes(instance.get('esNodes'));
  if (!nodes.length) {
    return null;
  }

  return {
    nodes,
    index: (instance.get('esIndex') as string) || DEFAULT_ES_INDEX,
    username: instance.get('esUsername') as string,
    password: instance.get('esPassword') as string,
  };
}

function addExactFieldFilter(filters: unknown[], fields: string[], value: unknown) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  filters.push({
    bool: {
      should: fields.map((field) => ({ term: { [field]: String(value) } })),
      minimum_should_match: 1,
    },
  });
}

function buildEsSearchBody(params: Record<string, any>) {
  const filters: unknown[] = [];
  const must: unknown[] = [];
  const top = Number(params.top || 100);

  addExactFieldFilter(filters, ['Level.keyword', 'level.keyword', 'Level', 'level'], params.level);
  addExactFieldFilter(filters, ['JobKey.keyword', 'jobKey.keyword', 'job_key.keyword', 'JobKey'], params.jobKey);

  const messageTerms = [params.message, params.queueItem, params.queueItemId]
    .map((item) => (item === undefined || item === null ? '' : String(item).trim()))
    .filter(Boolean);

  for (const term of messageTerms) {
    must.push({
      multi_match: {
        query: term,
        fields: [
          'Message',
          'message',
          'JobKey',
          'jobKey',
          'QueueItemId',
          'queueItemId',
          'QueueItemKey',
          'queueItemKey',
          'Reference',
          'reference',
        ],
        lenient: true,
      },
    });
  }

  return {
    size: Number.isFinite(top) ? top : 100,
    query: {
      bool: {
        filter: filters,
        must,
      },
    },
    sort: [{ TimeStamp: { order: 'desc', unmapped_type: 'date' } }],
  };
}

function firstValue(source: EsLogSource, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

async function searchEsLogs(plugin: PluginUiPathOrchestratorServer, config: EsConfig, params: Record<string, any>) {
  const node = config.nodes[0].replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (config.username || config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username || ''}:${config.password || ''}`).toString(
      'base64',
    )}`;
  }

  const response = await undiciFetch(`${node}/${config.index}/_search`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildEsSearchBody(params)),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Elasticsearch log search error ${response.status}: ${text}`);
  }

  const body = (await response.json()) as any;
  const hits = Array.isArray(body?.hits?.hits) ? body.hits.hits : [];
  const rows = hits.map((hit: any) => {
    const source = (hit._source || {}) as EsLogSource;
    return {
      ...source,
      Id: firstValue(source, ['Id', 'id']) || hit._id,
      Level: firstValue(source, ['Level', 'level']),
      TimeStamp: firstValue(source, ['TimeStamp', 'timeStamp', 'timestamp', '@timestamp']),
      ProcessName: firstValue(source, ['ProcessName', 'processName', 'process_name']),
      RobotName: firstValue(source, ['RobotName', 'robotName', 'robot_name']),
      MachineName: firstValue(source, ['MachineName', 'machineName', 'machine_name']),
      Message: firstValue(source, ['Message', 'message']),
      JobKey: firstValue(source, ['JobKey', 'jobKey', 'job_key']),
    };
  });
  const total = typeof body?.hits?.total === 'number' ? body.hits.total : body?.hits?.total?.value;

  plugin.app.logger.debug(`[plugin-uipath] Robot logs loaded from Elasticsearch: ${rows.length}`);

  return {
    data: rows,
    count: total,
    jobKeys: uniqueStrings(rows.map((row: any) => row?.JobKey || row?.jobKey)),
  };
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
        const esConfig = await resolveEsConfig(plugin, instanceId);
        if (esConfig && !ctx.action.params.filter) {
          try {
            ctx.body = await searchEsLogs(plugin, esConfig, ctx.action.params);
            await next();
            return;
          } catch (error) {
            plugin.app.logger.warn(`[plugin-uipath] Elasticsearch log search failed, falling back to OData: ${error}`);
          }
        }

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

    traceQueueItem: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, logId, timeStamp, jobKey } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        let targetTimeStamp = timeStamp;
        let targetJobKey = jobKey;

        if (logId && (!targetTimeStamp || !targetJobKey)) {
          const logData = await client.get(`/odata/RobotLogs(${logId})`, { folder });
          if (logData) {
            targetTimeStamp = logData.TimeStamp;
            targetJobKey = logData.JobKey;
          }
        }

        if (!targetTimeStamp) {
          throw new Error('TimeStamp is required for queue item correlation');
        }

        // Correlate: Find queue items processed during this timestamp
        // StartProcessing <= targetTimeStamp <= EndProcessing
        const queueFilter = `StartProcessing le ${targetTimeStamp} and EndProcessing ge ${targetTimeStamp}`;

        const queueData = await client.get('/odata/QueueItems', {
          query: {
            $top: 10,
            $filter: queueFilter,
            $expand: 'Robot',
            $orderby: 'StartProcessing desc',
          },
          folder,
        });

        ctx.body = {
          log: { TimeStamp: targetTimeStamp, JobKey: targetJobKey },
          queueItems: queueData.value || [],
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
