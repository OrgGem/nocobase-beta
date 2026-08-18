/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

interface PermissionSignature {
  allowedLlmServices: string[];
  allowAllModels: boolean;
  allowedModels: string[];
}

/**
 * Model access moved from per-user rows (aiApiUserPermissions) to usage groups.
 * Users with identical grants share one migrated group; quota settings are copied
 * from the default group so migrated users keep the same quota behaviour.
 *
 * The old per-user semantics cannot be fully expressed on groups: an empty grant
 * meant "deny all". Rows that denied everything (enabled=false, no services, or
 * allowAllModels=false with no models) are left unmigrated — those users inherit
 * the default group's open access and a warning is logged.
 */
export default class MigrateUserPermissionsToGroups extends Migration {
  // Must run afterSync: the new allowedLlmServices/allowAllModels/allowedModels
  // columns on aiApiUsageGroups only exist once collections have been synced.
  on = 'afterSync' as const;

  async up() {
    const collection = this.db.getCollection('aiApiUserPermissions');
    if (!collection || !(await collection.existsInDb())) return;

    const repository = this.db.getRepository('aiApiUserPermissions');
    const rows: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const batch = (await repository.find({ page, pageSize: 1000, sort: 'id' })) as unknown[];
      rows.push(...batch);
      if (batch.length < 1000) break;
    }
    if (!rows.length) return;

    const migratable: { userId: unknown; sig: PermissionSignature }[] = [];
    const deniedUserIds: unknown[] = [];

    for (const row of rows) {
      const userId = this.valueOf(row, 'userId');
      if (userId === undefined || userId === null) continue;

      const enabled = this.valueOf(row, 'enabled') !== false;
      const allowedLlmServices = this.stringArray(this.valueOf(row, 'allowedLlmServices'));
      const allowAllModels = this.valueOf(row, 'allowAllModels') !== false;
      const allowedModels = this.stringArray(this.valueOf(row, 'allowedModels'));

      // Old semantics: no services = deny all; allowAllModels=false with no models = deny all.
      const hasEffectiveGrant = allowedLlmServices.length > 0 && (allowAllModels || allowedModels.length > 0);
      if (!enabled || !hasEffectiveGrant) {
        deniedUserIds.push(userId);
        continue;
      }
      migratable.push({ userId, sig: { allowedLlmServices, allowAllModels, allowedModels } });
    }

    if (deniedUserIds.length) {
      this.app.logger.warn(
        `[ai-api] ${deniedUserIds.length} aiApiUserPermissions row(s) denied all access ` +
          `(enabled=false or empty grant) and cannot be migrated to usage groups. These users now ` +
          `inherit the default group's access. Affected userIds: ${deniedUserIds.join(', ')}. ` +
          `Use role permissions to block API access entirely.`,
      );
    }

    if (!migratable.length) return;

    const defaultGroup = await this.db.getRepository('aiApiUsageGroups').findOne({
      filter: { isDefault: true },
    });
    const quotaValues = this.quotaValuesFrom(defaultGroup);

    // Group rows by access signature so users with identical grants share one group.
    const bySignature = new Map<string, { sig: PermissionSignature; userIds: unknown[] }>();
    for (const { userId, sig } of migratable) {
      const key = JSON.stringify({
        allowedLlmServices: [...sig.allowedLlmServices].sort(),
        allowAllModels: sig.allowAllModels,
        allowedModels: [...sig.allowedModels].sort(),
      });
      const entry = bySignature.get(key);
      if (entry) {
        entry.userIds.push(userId);
      } else {
        bySignature.set(key, { sig, userIds: [userId] });
      }
    }

    let index = 0;
    for (const { sig, userIds } of bySignature.values()) {
      index += 1;
      const group = await this.db.getRepository('aiApiUsageGroups').create({
        values: {
          ...quotaValues,
          name: `Migrated permissions ${index}`,
          isDefault: false,
          quotaMode: 'per_user',
          allowedLlmServices: sig.allowedLlmServices,
          allowAllModels: sig.allowAllModels,
          allowedModels: sig.allowedModels,
        },
      });
      const groupId = this.valueOf(group, 'id');

      for (const userId of userIds) {
        const existing = await this.db.getRepository('aiApiGroupMembers').findOne({ filter: { userId } });
        if (existing) {
          await this.db.getRepository('aiApiGroupMembers').update({
            filterByTk: this.valueOf(existing, 'id'),
            values: { groupId },
          });
        } else {
          await this.db.getRepository('aiApiGroupMembers').create({ values: { groupId, userId } });
        }
      }
    }

    this.app.logger.info(
      `[ai-api] Migrated ${migratable.length} aiApiUserPermissions row(s) into ${bySignature.size} usage group(s).`,
    );
  }

  async down() {
    // The legacy rows are never modified, so rolling back only means removing the
    // migrated groups and their memberships.
    const groups = (await this.db.getRepository('aiApiUsageGroups').find({
      filter: { 'name.$startsWith': 'Migrated permissions' },
    })) as unknown[];
    for (const group of groups) {
      const groupId = this.valueOf(group, 'id');
      await this.db.getRepository('aiApiGroupMembers').destroy({ filter: { groupId } });
      await this.db.getRepository('aiApiUsageGroups').destroy({ filterByTk: groupId });
    }
  }

  private quotaValuesFrom(defaultGroup: unknown): Record<string, unknown> {
    if (!defaultGroup) {
      return {
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
      };
    }
    return {
      rateLimitPerMinute: Number(this.valueOf(defaultGroup, 'rateLimitPerMinute') ?? 60),
      enabled: !!this.valueOf(defaultGroup, 'enabled'),
      periodType: this.valueOf(defaultGroup, 'periodType') ?? 'monthly',
      timezone: this.valueOf(defaultGroup, 'timezone') ?? 'UTC',
      requestLimit: this.valueOf(defaultGroup, 'requestLimit') ?? null,
      totalTokenLimit: this.valueOf(defaultGroup, 'totalTokenLimit') ?? null,
      costLimit: this.valueOf(defaultGroup, 'costLimit') ?? null,
      currency: this.valueOf(defaultGroup, 'currency') ?? 'USD',
      rejectUnpricedModel: !!this.valueOf(defaultGroup, 'rejectUnpricedModel'),
      missingUsageBehavior: this.valueOf(defaultGroup, 'missingUsageBehavior') ?? 'use_reserved',
      contextOverflowBehavior: this.valueOf(defaultGroup, 'contextOverflowBehavior') ?? 'reject',
    };
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  }

  private valueOf(model: unknown, name: string): unknown {
    if (!model) return undefined;
    if (typeof (model as Record<string, unknown>).get === 'function') {
      return (model as Record<string, unknown>).get(name);
    }
    return (model as Record<string, unknown>)[name];
  }
}
