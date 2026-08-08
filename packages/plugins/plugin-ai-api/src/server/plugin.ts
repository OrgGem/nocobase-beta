/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import type { Transactionable } from '@nocobase/database';
import { createAiLlmRouter, AI_LLM_PREFIX } from './routes/router';
import aiApiConfigResource from './resource/ai-api-config';
import aiApiUsageMonitorResource from './resource/ai-api-usage-monitor';
import aiApiUserPermissionsResource from './resource/ai-api-user-permissions';
import { RateLimiter } from './utils/rate-limiter';
import { invalidateRolePermissionCache } from './middleware/role-permission';
import { invalidateUserPermissionCache } from './utils/user-permissions';
import { validateModelPrice, validateModelMetadata, validateQuotaPolicy } from './validation';
import { AI_API_ACL_SNIPPET, AI_API_USER_PERMISSIONS_SNIPPET } from '../constants';

// Ensure dayjs timezone + utc plugins are loaded.
// Some Docker builds ship an older @nocobase/utils whose dayjs.js does not
// extend the 'timezone' plugin, causing utcOffset(value) to behave as a
// getter (returns a number) instead of a setter (returns a dayjs instance).
// That breaks parse-filter.js's utc2unit() → "m.startOf is not a function".
// Extending here patches the shared CommonJS dayjs module instance for the
// entire Node.js process before any AIEmployee call is made.
import dayjsLib from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc';
import timezonePlugin from 'dayjs/plugin/timezone';
(dayjsLib as any).extend(utcPlugin);
(dayjsLib as any).extend(timezonePlugin);

export class PluginAiApiServer extends Plugin {
  /**
   * Singleton rate limiter — lives for the entire plugin lifetime, shared across all requests.
   * Uses a 1-minute sliding window to enforce rateLimitPerMinute from aiApiConfig.
   */
  rateLimiter = new RateLimiter(60_000);

  private gcInterval: NodeJS.Timeout | null = null;

  async afterAdd() {}

  async beforeLoad() {
    this.app.db.on('aiApiModelPrices.beforeSave', async (model) => {
      await validateModelPrice(this.db, model);
    });
    this.app.db.on('aiApiModelMetadata.beforeSave', (model) => {
      validateModelMetadata(model);
    });
    this.app.db.on('aiApiUserQuotaPolicies.beforeSave', (model) => {
      validateQuotaPolicy(model);
    });
  }

  async load() {
    // 1. Claim body parsing for our own routes before the core bodyParser runs.
    //    Core registers koa-bodyparser with a global REQUEST_BODY_LIMIT (10mb by
    //    default) much earlier in the stack, so without this the gateway's own
    //    configurable limit is unreachable: an oversized vision request would be
    //    rejected by core with a non-OpenAI error shape. `disableBodyParser` makes
    //    koa-bodyparser skip the request, leaving ctx.request.body undefined so
    //    createAiLlmRouter reads and caps the raw stream itself.
    this.app.use(
      async (ctx, next) => {
        if (ctx.path.startsWith(AI_LLM_PREFIX)) ctx.disableBodyParser = true;
        await next();
      },
      { tag: 'aiApiDisableBodyParser', before: 'bodyParser' },
    );

    // 2. Register raw Koa middleware for OpenAI-compatible endpoints
    //    Must run before 'resourcer' so URL paths match OpenAI convention
    // OIDC access tokens must first pass through plugin-idp-oauth, which validates
    // issuer/audience/scope and rewrites them to a NocoBase internal token.
    this.app.use(createAiLlmRouter(this), { after: 'idp-oauth-resource-auth', before: 'resourcer' });

    // 2. Register admin config resource
    this.app.resourceManager.define(aiApiConfigResource);
    this.app.resourceManager.define(aiApiUsageMonitorResource);
    this.app.resourceManager.define(aiApiUserPermissionsResource);

    this.app.db.on('aiApiRolePermissions.afterSave', (model) => {
      invalidateRolePermissionCache(model.get('roleName'));
    });
    this.app.db.on('aiApiRolePermissions.afterDestroy', (model) => {
      invalidateRolePermissionCache(model.get('roleName'));
    });

    this.app.db.on('aiApiUserPermissions.afterSave', (model, options) => {
      this.revokeUserPermissions(model.get('userId'), options?.transaction);
    });
    this.app.db.on('aiApiUserPermissions.afterDestroy', (model, options) => {
      this.revokeUserPermissions(model.get('userId'), options?.transaction);
    });

    // 3. Set ACL permissions for admin config + role permissions management
    this.app.acl.registerSnippet({
      name: AI_API_ACL_SNIPPET,
      actions: [
        'aiApiConfig:*',
        'aiApiRolePermissions:*',
        'aiApiModelPrices:*',
        'aiApiModelMetadata:*',
        'aiApiUserQuotaPolicies:*',
        'aiApiUserQuotaBuckets:list',
        'aiApiUserQuotaBuckets:get',
        'aiApiUsageRecords:list',
        'aiApiUsageRecords:get',
        'aiApiUsageMonitor:summary',
      ],
    });

    // Per-user LLM grants are a separate child permission: handing out model access is a
    // stronger capability than editing gateway settings, so it ticks independently.
    // The wildcard also covers `listUsers`, which backs the page's user picker — without it
    // the page would depend on `pm.plugin-users` and break for a role holding only this snippet.
    this.app.acl.registerSnippet({
      name: AI_API_USER_PERMISSIONS_SNIPPET,
      actions: ['aiApiUserPermissions:*'],
    });

    // 4. GC the rate limiter every 5 minutes to evict stale user entries.
    //    .unref() prevents this timer from keeping the process alive on shutdown.
    this.gcInterval = setInterval(() => this.rateLimiter.gc(), 5 * 60 * 1000);
    this.gcInterval.unref();
  }

  /**
   * Drop a user's cached LLM scope on every node.
   *
   * The local call is not redundant: syncMessageManager hardcodes skipSelf, so the publishing
   * node never receives its own message. Passing the transaction defers the broadcast until
   * the write commits, so other nodes cannot re-read the old row and re-cache it.
   */
  private revokeUserPermissions(userId: unknown, transaction?: Transactionable['transaction']) {
    invalidateUserPermissionCache(userId as string | number | bigint);
    this.sendSyncMessage({ type: 'invalidateUserPermissions', userId }, { transaction });
  }

  /**
   * Received only on the *other* nodes (skipSelf), so this must not re-broadcast.
   */
  async handleSyncMessage(message: { type?: string; userId?: unknown }) {
    if (message?.type === 'invalidateUserPermissions') {
      invalidateUserPermissionCache(message.userId as string | number | bigint);
    }
  }

  async install() {
    // Create default config record on first install
    const existing = await this.db.getRepository('aiApiConfig').findOne();
    if (!existing) {
      await this.db.getRepository('aiApiConfig').create({
        values: {
          defaultAiEmployee: '',
          enabledLlmServices: [],
          rateLimitPerMinute: 60,
          quotaEnabled: false,
          defaultReservationOutputTokens: 4096,
        },
      });
    }
  }

  async afterEnable() {}

  async afterDisable() {}

  async remove() {
    // Clean up the GC timer so we don't leak resources during hot-reload
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
    this.rateLimiter.clear();
  }
}

export default PluginAiApiServer;
