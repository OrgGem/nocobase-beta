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
import type { ID, PortainerInstanceSummary } from '../../shared/types';
import { decryptIfNeeded, resolvePortainerInstance } from '../instructions/helpers';
import { assertPositiveInt, clampTimeoutMs, PortainerApiError, PortainerClient } from '../services/PortainerClient';

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
  };
}
