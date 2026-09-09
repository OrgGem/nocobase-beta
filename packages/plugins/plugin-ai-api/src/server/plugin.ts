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
import { RateLimiter } from './utils/rate-limiter';
import { invalidateRolePermissionCache } from './middleware/role-permission';
import { blockResponseRecordResource } from './middleware/response-record-resource';
import { invalidateGroupAccessCache } from './utils/user-permissions';
import { cleanupExpiredResponseRecords } from './utils/response-store';
import { validateModelPrice, validateModelMetadata, validateQuotaPolicy, validateVirtualModel } from './validation';
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
  private responseCleanupInterval: NodeJS.Timeout | null = null;

  async afterAdd() {}

  async beforeLoad() {
    this.app.db.on('aiApiModelPrices.beforeSave', async (model) => {
      await validateModelPrice(this.db, model);
    });
    this.app.db.on('aiApiModelMetadata.beforeSave', (model) => {
      validateModelMetadata(model);
    });
    this.app.db.on('aiApiVirtualModels.beforeSave', (model) => {
      validateVirtualModel(model);
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
      // The default group is a fallback, not a membership target: an explicit row would pin the
      // user there and make them invisible to any unassigned-users filter. Reject it here so the
      // rule holds whether the row comes from a custom action or a plain aiApiGroupMembers:create.
      const targetGroupId = model.get('groupId');
      if (targetGroupId) {
        const targetGroup = await this.db.getRepository('aiApiUsageGroups').findOne({
          filterByTk: targetGroupId,
          transaction: options?.transaction,
        });
        if (targetGroup?.get('isDefault')) {
          throw new Error('Cannot add members to the default group: users without another group use it automatically.');
        }
      }
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
      // Drop membership rows so the affected users fall back to the default group
      // implicitly. Rows are destroyed one by one to keep the repository-level
      // destroy events firing for any listener that tracks membership changes.
      const members = await this.db.getRepository('aiApiGroupMembers').find({
        filter: { groupId: model.get('id') },
        transaction: options?.transaction,
      });
      for (const member of members) {
        await this.db.getRepository('aiApiGroupMembers').destroy({
          filterByTk: member.get('id'),
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

    // Stored prompts are only exposed through the owner-scoped OpenAI routes. This
    // explicit policy also blocks root, whose generic NocoBase ACL bypass is unconditional.
    this.app.resourceManager.use(blockResponseRecordResource(), {
      tag: 'aiApiResponseRecordsPrivate',
      after: 'auth',
      before: 'acl',
    });

    this.app.db.on('aiApiRolePermissions.afterSave', (model, options) => {
      this.invalidateRolePermissionSync(model.get('roleName'), options?.transaction);
    });
    this.app.db.on('aiApiRolePermissions.afterDestroy', (model, options) => {
      this.invalidateRolePermissionSync(model.get('roleName'), options?.transaction);
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
        'aiApiVirtualModels:*',
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

    // Expired stored responses are removed daily; run once at startup as well.
    this.cleanupResponseRecords();
    this.responseCleanupInterval = setInterval(() => this.cleanupResponseRecords(), 24 * 60 * 60 * 1000);
    this.responseCleanupInterval.unref();
  }

  /**
   * Drop a role's cached permission record on every node.
   *
   * Mirrors invalidateGroupAccess: the local call is not redundant because
   * syncMessageManager hardcodes skipSelf, so the publishing node never receives
   * its own message. Passing the transaction defers the broadcast until the
   * write commits, so other nodes cannot re-read the old row and re-cache it.
   */
  private invalidateRolePermissionSync(roleName: unknown, transaction?: Transactionable['transaction']) {
    invalidateRolePermissionCache(roleName as string | undefined);
    this.sendSyncMessage({ type: 'invalidateRolePermission', roleName }, { transaction });
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
  async handleSyncMessage(message: { type?: string; groupId?: unknown; roleName?: unknown }) {
    if (message?.type === 'invalidateGroupAccess') {
      invalidateGroupAccessCache(message.groupId as string | number | bigint);
    } else if (message?.type === 'invalidateRolePermission') {
      invalidateRolePermissionCache(message.roleName as string | undefined);
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

    // Root and admin get explicit AI API permission rows on fresh installs. There is no
    // built-in role bypass anymore, so without these rows even root/admin would be denied
    // until an admin grants access in Settings → Users & Permissions.
    for (const roleName of ['root', 'admin']) {
      const perm = await this.db.getRepository('aiApiRolePermissions').findOne({
        filter: { roleName },
      });
      if (!perm) {
        await this.db.getRepository('aiApiRolePermissions').create({
          values: { roleName, enabled: true, allowAllEmployees: true, allowedEmployees: [] },
        });
      }
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

  private async cleanupResponseRecords(): Promise<void> {
    try {
      const deleted = await cleanupExpiredResponseRecords({ db: this.db });
      if (deleted > 0) this.app.logger.info(`[ai-api] Cleaned up ${deleted} expired response records`);
    } catch (error) {
      this.app.logger.warn('[ai-api] Failed to clean up expired response records:', error);
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
    if (this.responseCleanupInterval) {
      clearInterval(this.responseCleanupInterval);
      this.responseCleanupInterval = null;
    }
    this.rateLimiter.clear();
  }
}

export default PluginAiApiServer;
