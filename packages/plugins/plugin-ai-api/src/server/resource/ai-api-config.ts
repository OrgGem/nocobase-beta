/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ResourceOptions } from '@nocobase/resourcer';

/**
 * Resource for managing AI API configuration via NocoBase admin UI.
 * Singleton config pattern (same as aiSettings in plugin-ai).
 *
 * Uses custom action name 'save' instead of 'update' because NocoBase's
 * built-in middleware requires filter/filterByTk for the standard 'update' action.
 */
const aiApiConfigResource: ResourceOptions = {
  name: 'aiApiConfig',
  actions: {
    async get(ctx, next) {
      let config = await ctx.db.getRepository('aiApiConfig').findOne();
      if (!config) {
        config = await ctx.db.getRepository('aiApiConfig').create({
          values: {
            mode: 'llm',
            defaultAiEmployee: '',
            defaultLlmService: '',
            enabledLlmServices: [],
            rateLimitPerMinute: 60,
            quotaEnabled: false,
            defaultReservationOutputTokens: 4096,
            options: {},
          },
        });
      }
      ctx.body = config;
      await next();
    },

    async save(ctx, next) {
      const values = ctx.action.params.values || (ctx.request.body as any) || {};
      const repo = ctx.db.getRepository('aiApiConfig');
      let config = await repo.findOne();

      if (!config) {
        config = await repo.create({
          values: {
            mode: values.mode ?? 'llm',
            defaultAiEmployee: values.defaultAiEmployee ?? '',
            defaultLlmService: values.defaultLlmService ?? '',
            enabledLlmServices: values.enabledLlmServices ?? [],
            rateLimitPerMinute: values.rateLimitPerMinute ?? 60,
            quotaEnabled: values.quotaEnabled ?? false,
            defaultReservationOutputTokens: values.defaultReservationOutputTokens ?? 4096,
            options: values.options ?? {},
          },
        });
      } else {
        const updateData: Record<string, any> = {};
        if (values.mode !== undefined) updateData.mode = values.mode;
        if (values.defaultAiEmployee !== undefined) updateData.defaultAiEmployee = values.defaultAiEmployee;
        if (values.defaultLlmService !== undefined) updateData.defaultLlmService = values.defaultLlmService;
        if (values.enabledLlmServices !== undefined) updateData.enabledLlmServices = values.enabledLlmServices;
        if (values.rateLimitPerMinute !== undefined) updateData.rateLimitPerMinute = values.rateLimitPerMinute;
        if (values.quotaEnabled !== undefined) updateData.quotaEnabled = values.quotaEnabled;
        if (values.defaultReservationOutputTokens !== undefined) {
          updateData.defaultReservationOutputTokens = values.defaultReservationOutputTokens;
        }
        if (values.options !== undefined) updateData.options = values.options;

        await config.update(updateData);
      }

      ctx.body = config;
      await next();
    },
  },
};

export default aiApiConfigResource;
