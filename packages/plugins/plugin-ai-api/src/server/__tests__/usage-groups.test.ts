import type { Context } from '@nocobase/actions';
import { createMockDatabase, type Database } from '@nocobase/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUserGroup, getDefaultGroup } from '../quota-groups';

describe('AI API usage groups', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createMockDatabase();
    db.collection({
      name: 'aiApiUsageGroups',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'isDefault', type: 'boolean' },
        { name: 'quotaMode', type: 'string' },
        { name: 'rateLimitPerMinute', type: 'integer' },
        { name: 'enabled', type: 'boolean' },
        { name: 'periodType', type: 'string' },
        { name: 'timezone', type: 'string' },
        { name: 'requestLimit', type: 'bigInt' },
        { name: 'totalTokenLimit', type: 'bigInt' },
        { name: 'costLimit', type: 'decimal', precision: 20, scale: 8 },
        { name: 'currency', type: 'string' },
        { name: 'rejectUnpricedModel', type: 'boolean' },
        { name: 'missingUsageBehavior', type: 'string' },
        { name: 'contextOverflowBehavior', type: 'string' },
        { name: 'allowedLlmServices', type: 'json' },
        { name: 'allowAllModels', type: 'boolean' },
        { name: 'allowedModels', type: 'json' },
      ],
    });
    db.collection({
      name: 'aiApiGroupMembers',
      fields: [
        { name: 'groupId', type: 'bigInt' },
        {
          name: 'group',
          type: 'belongsTo',
          target: 'aiApiUsageGroups',
          targetKey: 'id',
          foreignKey: 'groupId',
        },
        { name: 'userId', type: 'bigInt' },
      ],
      indexes: [{ fields: ['userId'], unique: true }],
    });
    await db.sync({ force: true });
  });

  afterEach(async () => {
    await db.close();
  });

  function context(): Context {
    return { db, request: {}, state: {} } as unknown as Context;
  }

  it('creates the default group lazily with open model access', async () => {
    const group = await getDefaultGroup(context());
    expect(group.name).toBe('Default');
    expect(group.isDefault).toBe(true);
    expect(group.quotaMode).toBe('per_user');
    // The default group must never lock everyone out: empty lists mean "no narrowing".
    expect(group.allowedLlmServices).toEqual([]);
    expect(group.allowAllModels).toBe(true);
    expect(group.allowedModels).toEqual([]);

    const second = await getDefaultGroup(context());
    expect(second.id).toBe(group.id);
  });

  it('resolves an unassigned user to the default group', async () => {
    const group = await resolveUserGroup(context(), 99);
    expect(group.name).toBe('Default');
    expect(group.isDefault).toBe(true);
  });

  it('resolves an assigned user to their explicit group', async () => {
    const custom = await db.getRepository('aiApiUsageGroups').create({
      values: {
        name: 'Pro',
        isDefault: false,
        quotaMode: 'share',
        rateLimitPerMinute: 120,
        enabled: true,
        periodType: 'monthly',
        timezone: 'UTC',
        currency: 'USD',
        rejectUnpricedModel: true,
        missingUsageBehavior: 'use_reserved',
        contextOverflowBehavior: 'reject',
      },
    });
    await db.getRepository('aiApiGroupMembers').create({
      values: { groupId: custom.get('id'), userId: 42 },
    });

    const group = await resolveUserGroup(context(), 42);
    expect(group.name).toBe('Pro');
    expect(group.quotaMode).toBe('share');
  });

  it('carries the model access fields through group resolution', async () => {
    const custom = await db.getRepository('aiApiUsageGroups').create({
      values: {
        name: 'Restricted',
        isDefault: false,
        quotaMode: 'per_user',
        rateLimitPerMinute: 60,
        enabled: false,
        periodType: 'monthly',
        timezone: 'UTC',
        currency: 'USD',
        rejectUnpricedModel: true,
        missingUsageBehavior: 'use_reserved',
        contextOverflowBehavior: 'reject',
        allowedLlmServices: ['svc'],
        allowAllModels: false,
        allowedModels: ['svc/model-a'],
      },
    });
    await db.getRepository('aiApiGroupMembers').create({
      values: { groupId: custom.get('id'), userId: 43 },
    });

    const group = await resolveUserGroup(context(), 43);
    expect(group.allowedLlmServices).toEqual(['svc']);
    expect(group.allowAllModels).toBe(false);
    expect(group.allowedModels).toEqual(['svc/model-a']);
  });

  it('rejects adding a member to the default group via the beforeSave guard', async () => {
    // Mirror the plugin.ts aiApiGroupMembers.beforeSave hook: adding a member to the
    // default group is rejected because the default group is a fallback, not a target.
    const defaultGroup = await db.getRepository('aiApiUsageGroups').create({
      values: {
        name: 'Default',
        isDefault: true,
        quotaMode: 'per_user',
        rateLimitPerMinute: 60,
        enabled: false,
        periodType: 'monthly',
        timezone: 'UTC',
        currency: 'USD',
        rejectUnpricedModel: true,
        missingUsageBehavior: 'use_reserved',
        contextOverflowBehavior: 'reject',
      },
    });

    db.on('aiApiGroupMembers.beforeSave', async (model) => {
      const targetGroupId = model.get('groupId');
      if (!targetGroupId) return;
      const targetGroup = await db.getRepository('aiApiUsageGroups').findOne({ filterByTk: targetGroupId });
      if (targetGroup?.get('isDefault')) {
        throw new Error('Cannot add members to the default group.');
      }
    });

    await expect(
      db.getRepository('aiApiGroupMembers').create({ values: { groupId: defaultGroup.get('id'), userId: 7 } }),
    ).rejects.toThrow('Cannot add members to the default group');
  });

  it('drops members of a deleted group so they fall back to the default group', async () => {
    // Mirror the plugin.ts aiApiUsageGroups.beforeDestroy hook: deleting a non-default
    // group destroys its member rows, and affected users resolve to the default group
    // implicitly instead of being reassigned to an explicit default membership.
    await db.getRepository('aiApiUsageGroups').create({
      values: {
        name: 'Default',
        isDefault: true,
        quotaMode: 'per_user',
        rateLimitPerMinute: 60,
        enabled: false,
        periodType: 'monthly',
        timezone: 'UTC',
        currency: 'USD',
        rejectUnpricedModel: true,
        missingUsageBehavior: 'use_reserved',
        contextOverflowBehavior: 'reject',
      },
    });
    const custom = await db.getRepository('aiApiUsageGroups').create({
      values: {
        name: 'Pro',
        isDefault: false,
        quotaMode: 'share',
        rateLimitPerMinute: 120,
        enabled: true,
        periodType: 'monthly',
        timezone: 'UTC',
        currency: 'USD',
        rejectUnpricedModel: true,
        missingUsageBehavior: 'use_reserved',
        contextOverflowBehavior: 'reject',
      },
    });
    await db.getRepository('aiApiGroupMembers').create({
      values: { groupId: custom.get('id'), userId: 55 },
    });

    db.on('aiApiUsageGroups.beforeDestroy', async (model, options) => {
      if (model.get('isDefault')) {
        throw new Error('The default usage group cannot be deleted.');
      }
      const members = await db.getRepository('aiApiGroupMembers').find({
        filter: { groupId: model.get('id') },
        transaction: options?.transaction,
      });
      for (const member of members) {
        await db.getRepository('aiApiGroupMembers').destroy({
          filterByTk: member.get('id'),
          transaction: options?.transaction,
        });
      }
    });

    await db.getRepository('aiApiUsageGroups').destroy({ filterByTk: custom.get('id') });

    const remaining = await db.getRepository('aiApiGroupMembers').findOne({ filter: { userId: 55 } });
    expect(remaining).toBeNull();
    // With no explicit membership, the user now resolves to the default group.
    const resolved = await resolveUserGroup(context(), 55);
    expect(resolved.name).toBe('Default');
    expect(resolved.isDefault).toBe(true);
  });
  it('drops non-string entries from the access lists', async () => {
    const custom = await db.getRepository('aiApiUsageGroups').create({
      values: {
        name: 'Messy',
        isDefault: false,
        quotaMode: 'per_user',
        rateLimitPerMinute: 60,
        enabled: false,
        periodType: 'monthly',
        timezone: 'UTC',
        currency: 'USD',
        rejectUnpricedModel: true,
        missingUsageBehavior: 'use_reserved',
        contextOverflowBehavior: 'reject',
        allowedLlmServices: ['svc', null, 42],
        allowAllModels: false,
        allowedModels: [{ k: 1 }, 'svc/model-a'],
      },
    });
    await db.getRepository('aiApiGroupMembers').create({
      values: { groupId: custom.get('id'), userId: 44 },
    });

    const group = await resolveUserGroup(context(), 44);
    expect(group.allowedLlmServices).toEqual(['svc']);
    expect(group.allowedModels).toEqual(['svc/model-a']);
  });
});
