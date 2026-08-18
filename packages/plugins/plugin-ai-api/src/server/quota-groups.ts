/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';

export type QuotaMode = 'share' | 'per_user';

export interface AiApiUsageGroup {
  id: string | number | bigint;
  name: string;
  isDefault: boolean;
  quotaMode: QuotaMode;
  rateLimitPerMinute: number;
  enabled: boolean;
  periodType: string;
  timezone: string;
  requestLimit: string | number | bigint | null;
  totalTokenLimit: string | number | bigint | null;
  costLimit: string | null;
  currency: string;
  rejectUnpricedModel: boolean;
  missingUsageBehavior: 'allow' | 'use_reserved';
  contextOverflowBehavior: 'reject' | 'truncate';
  allowedLlmServices: string[];
  allowAllModels: boolean;
  allowedModels: string[];
}

export async function getDefaultGroup(ctx: Context): Promise<AiApiUsageGroup> {
  const existing = await ctx.db.getRepository('aiApiUsageGroups').findOne({
    filter: { isDefault: true },
  });

  if (existing) {
    return modelToGroup(existing);
  }

  const created = await ctx.db.getRepository('aiApiUsageGroups').create({
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

  return modelToGroup(created);
}

export async function resolveUserGroup(
  ctx: Context,
  userId: string | number | bigint | undefined | null,
): Promise<AiApiUsageGroup> {
  if (userId === undefined || userId === null) {
    return getDefaultGroup(ctx);
  }

  const member = await ctx.db.getRepository('aiApiGroupMembers').findOne({
    filter: { userId },
    appends: ['group'],
  });

  if (member && member.get('group')) {
    return modelToGroup(member.get('group'));
  }

  return getDefaultGroup(ctx);
}

export function modelToGroup(model: Model | Record<string, unknown>): AiApiUsageGroup {
  const record =
    typeof (model as Model).get === 'function' ? (model as Model).get() : (model as Record<string, unknown>);
  return {
    id: record.id as string | number | bigint,
    name: (record.name as string) ?? '',
    isDefault: !!record.isDefault,
    quotaMode: (record.quotaMode as QuotaMode) ?? 'per_user',
    rateLimitPerMinute: Number(record.rateLimitPerMinute ?? 60),
    enabled: !!record.enabled,
    periodType: (record.periodType as string) ?? 'monthly',
    timezone: (record.timezone as string) ?? 'UTC',
    requestLimit: (record.requestLimit as string | number | bigint | null) ?? null,
    totalTokenLimit: (record.totalTokenLimit as string | number | bigint | null) ?? null,
    costLimit: (record.costLimit as string | null) ?? null,
    currency: (record.currency as string) ?? 'USD',
    rejectUnpricedModel: !!record.rejectUnpricedModel,
    missingUsageBehavior: (record.missingUsageBehavior as 'allow' | 'use_reserved') ?? 'use_reserved',
    contextOverflowBehavior: (record.contextOverflowBehavior as 'reject' | 'truncate') ?? 'reject',
    allowedLlmServices: stringArray(record.allowedLlmServices),
    allowAllModels: record.allowAllModels !== false,
    allowedModels: stringArray(record.allowedModels),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
