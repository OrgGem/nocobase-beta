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
import aiApiUsageGroupsResource from './resource/ai-api-usage-groups';
import { RateLimiter } from './utils/rate-limiter';
import { invalidateRolePermissionCache } from './middleware/role-permission';
import { invalidateGroupAccessCache } from './utils/user-permissions';
import { validateModelPrice, validateModelMetadata, validateQuotaPolicy } from './validation';
import { AI_API_ACL_SNIPPET } from '../constants';
import {
  FileProcessorService,
  base64FileForwarder,
  httpFileUrlFetcher,
  pdfFileProcessor,
} from './services/file-processor';

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
   * Uses a 1-minute sliding window to enforce rateLimitPerMinute from the user's usage group.
   */
  rateLimiter = new RateLimiter(60_000);

  /**
   * Extensible file processor service. Other plugins can register custom processors
   * to transform file/file_url content blocks before they reach the LLM.
   */
  fileProcessorService = new FileProcessorService();

  private gcInterval: NodeJS.Timeout | null = null;

  async afterAdd() {}

  async beforeLoad() {
    this.app.db.on('aiApiModelPrices.beforeSave', async (model) => {
      await validateModelPrice(this.db, model);
    });
    this.app.db.on('aiApiModelMetadata.beforeSave', (model) => {
      validateModelMetadata(model);
    });
    this.app.db.on('aiApiUsageGroups.beforeSave', async (model, options) => {
      validateQuotaPolicy(model);
      // The partial unique index on isDefault is not supported on MySQL,
      // so enforce single-default-group here as well.
      if (model.get('isDefault')) {
        const filter: Record<string, unknown> = { isDefault: true };
        if (model.get('id')) filter.id = { $ne: model.get('id') };
        const other = await this.db.getRepository('aiApiUsageGroups').findOne({
          filter,
          transaction: options?.transaction,
        });
        if (other) {
          throw new Error('Only one default usage group is allowed.');
        }
      }
    });

    this.app.db.on('aiApiGroupMembers.beforeSave', async (model, options) => {
      const userId = model.get('userId');
      if (!userId) return;
      const existing = await this.db.getRepository('aiApiGroupMembers').findOne({
        filter: { userId },
        transaction: options?.transaction,
      });
      if (existing && existing.get('id') !== model.get('id')) {
        throw new Error('User already belongs to another usage group.');
      }
    });

    this.app.db.on('aiApiUsageGroups.beforeDestroy', async (model, options) => {
      if (model.get('isDefault')) {
        throw new Error('The default usage group cannot be deleted.');
      }
      const members = await this.db.getRepository('aiApiGroupMembers').find({
        filter: { groupId: model.get('id') },
        transaction: options?.transaction,
      });
      if (members.length === 0) return;

      const defaultGroup = await this.db.getRepository('aiApiUsageGroups').findOne({
        filter: { isDefault: true },
        transaction: options?.transaction,
      });
      if (!defaultGroup) {
        throw new Error('Default usage group is missing; cannot reassign members.');
      }

      for (const member of members) {
        await this.db.getRepository('aiApiGroupMembers').update({
          filterByTk: member.get('id'),
          values: { groupId: defaultGroup.get('id') },
          transaction: options?.transaction,
        });
      }
    });
  }

  async load() {
    // Register default file processors. Custom plugins can register additional
    // processors by retrieving this plugin instance and calling
    // `fileProcessorService.register(processor)`.
    this.fileProcessorService.register(base64FileForwarder);
    this.fileProcessorService.register(httpFileUrlFetcher);
    this.fileProcessorService.register(pdfFileProcessor);

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
    this.app.resourceManager.define(aiApiUsageGroupsResource);

    this.app.db.on('aiApiRolePermissions.afterSave', (model) => {
      invalidateRolePermissionCache(model.get('roleName'));
    });
    this.app.db.on('aiApiRolePermissions.afterDestroy', (model) => {
      invalidateRolePermissionCache(model.get('roleName'));
    });

    this.app.db.on('aiApiUsageGroups.afterSave', (model, options) => {
      this.invalidateGroupAccess(model.get('id'), options?.transaction);
    });
    this.app.db.on('aiApiUsageGroups.afterDestroy', (model, options) => {
      this.invalidateGroupAccess(model.get('id'), options?.transaction);
    });

    // 3. Set ACL permissions for admin config + role permissions management
    this.app.acl.registerSnippet({
      name: AI_API_ACL_SNIPPET,
      actions: [
        'aiApiConfig:*',
        'aiApiRolePermissions:*',
        'aiApiModelPrices:*',
        'aiApiModelMetadata:*',
        'aiApiUsageGroups:*',
        'aiApiGroupMembers:*',
        'aiApiGroupQuotaBuckets:list',
        'aiApiGroupQuotaBuckets:get',
        'aiApiUsageRecords:list',
        'aiApiUsageRecords:get',
        'aiApiUsageMonitor:summary',
      ],
    });

    // 4. GC the rate limiter every 5 minutes to evict stale user entries.
    //    .unref() prevents this timer from keeping the process alive on shutdown.
    this.gcInterval = setInterval(() => this.rateLimiter.gc(), 5 * 60 * 1000);
    this.gcInterval.unref();
  }

  /**
   * Drop a group's cached model-access scope on every node.
   *
   * The local call is not redundant: syncMessageManager hardcodes skipSelf, so the publishing
   * node never receives its own message. Passing the transaction defers the broadcast until
   * the write commits, so other nodes cannot re-read the old row and re-cache it.
   */
  private invalidateGroupAccess(groupId: unknown, transaction?: Transactionable['transaction']) {
    invalidateGroupAccessCache(groupId as string | number | bigint);
    this.sendSyncMessage({ type: 'invalidateGroupAccess', groupId }, { transaction });
  }

  /**
   * Received only on the *other* nodes (skipSelf), so this must not re-broadcast.
   */
  async handleSyncMessage(message: { type?: string; groupId?: unknown }) {
    if (message?.type === 'invalidateGroupAccess') {
      invalidateGroupAccessCache(message.groupId as string | number | bigint);
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
          quotaEnabled: false,
          pdfRenderPagesAsImages: false,
          defaultReservationOutputTokens: 4096,
        },
      });
    }

    // Create default usage group on first install
    const defaultGroup = await this.db.getRepository('aiApiUsageGroups').findOne({
      filter: { isDefault: true },
    });
    if (!defaultGroup) {
      await this.db.getRepository('aiApiUsageGroups').create({
        values: {
          name: 'Default',
          isDefault: true,
          quotaMode: 'per_user',
          rateLimitPerMinute: 60,
          enabled: false,
          periodType: 'monthly',
          timezone: 'UTC',
          requestLimit: null,
          totalTokenLimit: null,
          costLimit: null,
          currency: 'USD',
          rejectUnpricedModel: true,
          missingUsageBehavior: 'use_reserved',
          contextOverflowBehavior: 'reject',
          allowedLlmServices: [],
          allowAllModels: true,
          allowedModels: [],
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
