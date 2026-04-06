/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { createAiLlmRouter } from './routes/router';
import aiApiConfigResource from './resource/ai-api-config';
import { RateLimiter } from './utils/rate-limiter';

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

  async beforeLoad() {}

  async load() {
    // 1. Register raw Koa middleware for OpenAI-compatible endpoints
    //    Must run before 'resourcer' so URL paths match OpenAI convention
    this.app.use(createAiLlmRouter(this), { before: 'resourcer' });

    // 2. Register admin config resource
    this.app.resourceManager.define(aiApiConfigResource);

    // 3. Set ACL permissions for admin config + role permissions management
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.configuration`,
      actions: ['aiApiConfig:*', 'aiApiRolePermissions:*'],
    });

    // 4. GC the rate limiter every 5 minutes to evict stale user entries.
    //    .unref() prevents this timer from keeping the process alive on shutdown.
    this.gcInterval = setInterval(() => this.rateLimiter.gc(), 5 * 60 * 1000);
    this.gcInterval.unref();
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
