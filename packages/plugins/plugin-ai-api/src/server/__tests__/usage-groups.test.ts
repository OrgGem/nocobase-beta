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
