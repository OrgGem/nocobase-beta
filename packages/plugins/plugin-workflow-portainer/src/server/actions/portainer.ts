/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import type Application from '@nocobase/server';
import { PLUGIN_NAMESPACE, PORTAINER_INSTANCES_COLLECTION, SECRET_MASK } from '../../shared/constants';
import { isLikelySensitiveKey } from '../../shared/env';
import type {
  ID,
  PortainerContainerSummary,
  PortainerInstanceSummary,
  PortainerStackOverview,
} from '../../shared/types';
import { decryptIfNeeded, resolvePortainerInstance } from '../instructions/helpers';
import {
  assertPositiveInt,
  assertValidContainerId,
  clampTimeoutMs,
  PortainerApiError,
  PortainerClient,
  summarizeContainersHealth,
} from '../services/PortainerClient';

function getRequestParam(ctx: Context, key: string): unknown {
  const params = (ctx.action?.params ?? {}) as Record<string, unknown>;
  const values =
    typeof params.values === 'object' && params.values !== null ? (params.values as Record<string, unknown>) : {};
  if (typeof values[key] !== 'undefined') {
    return values[key];
  }
  return params[key];
}

function sendPortainerError(ctx: Context, error: unknown): never {
  if (error instanceof PortainerApiError) {
    const status =
      error.code === 'INVALID_URL' || error.code === 'INVALID_PARAM' || error.code === 'MISSING_API_KEY'
        ? 400
        : error.code === 'INSTANCE_NOT_FOUND'
          ? 404
          : error.status && error.status >= 400 && error.status < 500
            ? error.status
            : 502;
    ctx.throw(status, error.message);
  }
  throw error;
}

export function createPortainerResourceActions(app: Application) {
  return {
    async listInstances(ctx: Context, next: Next) {
      const repo = app.db.getRepository(PORTAINER_INSTANCES_COLLECTION);
      const rows = await repo.find({
        filter: { enabled: true },
        sort: ['-isDefault', 'id'],
      });
      const items: PortainerInstanceSummary[] = rows.map((row) => ({
        id: Number(row.get('id')),
        name: String(row.get('name') ?? ''),
        baseUrl: String(row.get('baseUrl') ?? ''),
        isDefault: Boolean(row.get('isDefault')),
        enabled: Boolean(row.get('enabled')),
        defaultTimeoutMs: Number(row.get('defaultTimeoutMs') ?? 600_000),
        lastHealthStatus: (row.get('lastHealthStatus') as string | null) ?? null,
        lastVersion: (row.get('lastVersion') as string | null) ?? null,
      }));
      ctx.body = items;
      await next();
    },

    async testConnection(ctx: Context, next: Next) {
      const filterByTk = (getRequestParam(ctx, 'filterByTk') ?? getRequestParam(ctx, 'instanceId')) as ID | undefined;
      try {
        const instance = await resolvePortainerInstance(app, filterByTk ?? null);
        const status = await instance.client.getStatus();
        const endpoints = await instance.client.listEndpoints();
        const version = String(status?.Version ?? 'unknown');

        await app.db.getRepository(PORTAINER_INSTANCES_COLLECTION).update({
          filterByTk: instance.id,
          values: {
            lastHealthStatus: 'ok',
            lastVersion: version,
            lastCheckedAt: new Date(),
          },
        });

        ctx.body = {
          ok: true,
          instanceId: instance.id,
          version,
          endpointCount: endpoints.length,
          endpoints,
        };
      } catch (error) {
        if (filterByTk) {
          const numId = Number(filterByTk);
          if (Number.isSafeInteger(numId) && numId > 0) {
            await app.db
              .getRepository(PORTAINER_INSTANCES_COLLECTION)
              .update({
                filterByTk: numId,
                values: {
                  lastHealthStatus: 'error',
                  lastCheckedAt: new Date(),
                },
              })
              .catch(() => {});
          }
        }
        sendPortainerError(ctx, error);
      }
      await next();
    },

    async testConnectionDraft(ctx: Context, next: Next) {
      try {
        const baseUrl = String(getRequestParam(ctx, 'baseUrl') ?? '').trim();
        let apiKey = String(getRequestParam(ctx, 'apiKey') ?? '').trim();
        const instanceId = getRequestParam(ctx, 'id') ?? getRequestParam(ctx, 'instanceId');
        const allowInsecureTls = Boolean(getRequestParam(ctx, 'allowInsecureTls'));
        const timeoutMs = clampTimeoutMs(Number(getRequestParam(ctx, 'defaultTimeoutMs') ?? 15_000), 15_000);

        if ((!apiKey || apiKey === SECRET_MASK) && instanceId) {
          const existing = await app.db
            .getRepository(PORTAINER_INSTANCES_COLLECTION)
            .findOne({ filterByTk: Number(instanceId) });
          if (existing) {
            apiKey = await decryptIfNeeded(app, existing.get('apiKey'));
          }
        }

        const client = new PortainerClient({ baseUrl, apiKey, allowInsecureTls, timeoutMs });
        const status = await client.getStatus();
        const endpoints = await client.listEndpoints();
        ctx.body = {
          ok: true,
          version: String(status?.Version ?? 'unknown'),
          endpointCount: endpoints.length,
          endpoints,
        };
      } catch (error) {
        sendPortainerError(ctx, error);
      }
      await next();
    },

    async listEndpoints(ctx: Context, next: Next) {
      const instanceId = getRequestParam(ctx, 'instanceId') as ID | undefined;
      try {
        const instance = await resolvePortainerInstance(app, instanceId ?? null);
        ctx.body = await instance.client.listEndpoints();
      } catch (error) {
        sendPortainerError(ctx, error);
      }
      await next();
    },

    async listStacks(ctx: Context, next: Next) {
      const instanceId = getRequestParam(ctx, 'instanceId') as ID | undefined;
      const rawEndpointId = getRequestParam(ctx, 'endpointId');
      try {
        const instance = await resolvePortainerInstance(app, instanceId ?? null);
        const endpointId =
          rawEndpointId !== null && typeof rawEndpointId !== 'undefined' && String(rawEndpointId).trim() !== ''
            ? assertPositiveInt(rawEndpointId as ID, 'Environment (Endpoint) ID')
            : null;
        ctx.body = await instance.client.listStacks(endpointId);
      } catch (error) {
        sendPortainerError(ctx, error);
      }
      await next();
    },

    async getStackDetail(ctx: Context, next: Next) {
      const instanceId = getRequestParam(ctx, 'instanceId') as ID | undefined;
      const rawStackId = getRequestParam(ctx, 'stackId');
      const maskValues =
        getRequestParam(ctx, 'includeValues') !== true && getRequestParam(ctx, 'includeValues') !== 'true';
      try {
        if (rawStackId === null || typeof rawStackId === 'undefined' || String(rawStackId).trim() === '') {
          ctx.throw(400, ctx.t('Stack ID is required', { ns: PLUGIN_NAMESPACE }));
        }
        const instance = await resolvePortainerInstance(app, instanceId ?? null);
        const stackId = assertPositiveInt(rawStackId as ID, 'Stack ID');
        const detail = await instance.client.getStackDetail(stackId);
        ctx.body = {
          ...detail,
          env: detail.env.map((pair) => ({
            name: pair.name,
            value: maskValues || isLikelySensitiveKey(pair.name) ? '' : pair.value,
            hasExistingValue: pair.value.length > 0,
            sensitive: isLikelySensitiveKey(pair.name),
          })),
        };
      } catch (error) {
        sendPortainerError(ctx, error);
      }
      await next();
    },

    async getStackOverview(ctx: Context, next: Next) {
      const instanceId = getRequestParam(ctx, 'instanceId') as ID | undefined;
      const rawStackId = getRequestParam(ctx, 'stackId');
      const includeStatsParam = getRequestParam(ctx, 'includeStats');
      const includeFileParam = getRequestParam(ctx, 'includeFile');
      const includeStats = includeStatsParam !== false && includeStatsParam !== 'false';
      const includeFile = includeFileParam !== false && includeFileParam !== 'false';

      try {
        if (rawStackId === null || typeof rawStackId === 'undefined' || String(rawStackId).trim() === '') {
          ctx.throw(400, ctx.t('Stack ID is required', { ns: PLUGIN_NAMESPACE }));
        }
        const instance = await resolvePortainerInstance(app, instanceId ?? null);
        const stackId = assertPositiveInt(rawStackId as ID, 'Stack ID');

        const [detail, stackFileContent] = await Promise.all([
          instance.client.getStackDetail(stackId),
          includeFile ? instance.client.getStackFile(stackId).catch(() => '') : Promise.resolve(''),
        ]);

        const baseContainers = await instance.client
          .listStackContainers(detail.endpointId, detail.name)
          .catch((): PortainerContainerSummary[] => []);

        const containers: PortainerContainerSummary[] = includeStats
          ? await Promise.all(
              baseContainers.map(async (container) => {
                if (container.state !== 'running') {
                  return { ...container, stats: null };
                }
                const stats = await instance.client
                  .getContainerLiveStats(detail.endpointId, container.id)
                  .catch(() => null);
                return { ...container, stats };
              }),
            )
          : baseContainers;

        const health = summarizeContainersHealth(containers);
        let totalCpuPercent = 0;
        let totalMemUsageBytes = 0;
        let memLimitBytes = 0;
        let totalNetRxBytes = 0;
        let totalNetTxBytes = 0;

        for (const item of containers) {
          if (item.stats) {
            totalCpuPercent += item.stats.cpuPercent;
            totalMemUsageBytes += item.stats.memUsageBytes;
            if (item.stats.memLimitBytes > memLimitBytes) {
              memLimitBytes = item.stats.memLimitBytes;
            }
            totalNetRxBytes += item.stats.netRxBytes;
            totalNetTxBytes += item.stats.netTxBytes;
          }
        }

        const totalMemPercent =
          memLimitBytes > 0 ? Math.round(((totalMemUsageBytes / memLimitBytes) * 100 + Number.EPSILON) * 100) / 100 : 0;

        const overview: PortainerStackOverview = {
          detail: {
            ...detail,
            env: detail.env.map((pair) => {
              const sensitive = isLikelySensitiveKey(pair.name);
              return {
                name: pair.name,
                value: sensitive ? SECRET_MASK : pair.value,
                hasExistingValue: pair.value.length > 0,
                sensitive,
              };
            }),
          },
          stackFileContent,
          containers,
          summary: {
            ...health,
            totalCpuPercent: Math.round((totalCpuPercent + Number.EPSILON) * 100) / 100,
            totalMemUsageBytes,
            memLimitBytes,
            totalMemPercent,
            totalNetRxBytes,
            totalNetTxBytes,
          },
          sampledAt: new Date().toISOString(),
        };

        ctx.body = overview;
      } catch (error) {
        sendPortainerError(ctx, error);
      }
      await next();
    },

    async getContainerLogs(ctx: Context, next: Next) {
      const instanceId = getRequestParam(ctx, 'instanceId') as ID | undefined;
      const rawEndpointId = getRequestParam(ctx, 'endpointId');
      const rawContainerId = getRequestParam(ctx, 'containerId');
      const rawTail = getRequestParam(ctx, 'tail');

      try {
        const instance = await resolvePortainerInstance(app, instanceId ?? null);
        const endpointId = assertPositiveInt(rawEndpointId as ID, 'Environment (Endpoint) ID');
        const containerId = assertValidContainerId(String(rawContainerId ?? ''));
        const tail = Math.min(1000, Math.max(10, Math.trunc(Number(rawTail) || 100)));
        const logs = await instance.client.getContainerLogs(endpointId, containerId, tail);
        ctx.body = {
          containerId,
          tail,
          logs,
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        sendPortainerError(ctx, error);
      }
      await next();
    },

    async controlStack(ctx: Context, next: Next) {
      const instanceId = getRequestParam(ctx, 'instanceId') as ID | undefined;
      const rawEndpointId = getRequestParam(ctx, 'endpointId');
      const rawStackId = getRequestParam(ctx, 'stackId');
      const operation = String(getRequestParam(ctx, 'operation') ?? '')
        .trim()
        .toLowerCase();

      try {
        if (operation !== 'start' && operation !== 'stop') {
          ctx.throw(400, ctx.t('Operation must be start or stop', { ns: PLUGIN_NAMESPACE }));
        }
        const instance = await resolvePortainerInstance(app, instanceId ?? null);
        const endpointId = assertPositiveInt(rawEndpointId as ID, 'Environment (Endpoint) ID');
        const stackId = assertPositiveInt(rawStackId as ID, 'Stack ID');

        const initial =
          operation === 'start'
            ? await instance.client.startStack(stackId, endpointId)
            : await instance.client.stopStack(stackId, endpointId);
        const settled = await instance.client.waitForStackSettlement(stackId, initial, { timeoutMs: 60_000 });

        ctx.body = {
          ok: true,
          stackId,
          endpointId,
          operation,
          status: Number(settled?.Status ?? (operation === 'start' ? 1 : 2)),
        };
      } catch (error) {
        sendPortainerError(ctx, error);
      }
      await next();
    },
  };
}
