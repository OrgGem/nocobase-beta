/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';

const USER_SUMMARY_FIELDS = ['id', 'username', 'nickname', 'email'];

async function getByUser(ctx: Context, next: () => Promise<void>) {
  const { userId } = ctx.action.params;
  if (!userId) {
    ctx.throw(400, 'userId is required');
  }
  const member = await ctx.db.getRepository('aiApiGroupMembers').findOne({
    filter: { userId },
    appends: ['group'],
  });

  if (member && member.get('group')) {
    ctx.body = member.get('group');
    return next();
  }

  const defaultGroup = await ctx.db.getRepository('aiApiUsageGroups').findOne({
    filter: { isDefault: true },
  });

  if (!defaultGroup) {
    ctx.throw(404, 'Default group not found');
  }

  ctx.body = defaultGroup;
  return next();
}

async function listUnassignedUsers(ctx: Context, next: () => Promise<void>) {
  const { page = 1, pageSize = 20, keyword } = ctx.action.params;

  const memberRows = (await ctx.db.getRepository('aiApiGroupMembers').find({
    fields: ['userId'],
    pageSize: 10000,
  })) as unknown[];
  const assignedUserIds = memberRows.map((row) => {
    const value = (row as Record<string, unknown>).get?.('userId') ?? (row as Record<string, unknown>).userId;
    return String(value);
  });

  const where: Record<string, unknown> = {};
  if (keyword) {
    where.$or = [
      { username: { $includes: keyword } },
      { email: { $includes: keyword } },
      { nickname: { $includes: keyword } },
    ];
  }
  if (assignedUserIds.length > 0) {
    where.id = { $notIn: assignedUserIds };
  }

  const repository = ctx.db.getRepository('users');
  const [rows, count] = await repository.findAndCount({
    filter: where,
    fields: USER_SUMMARY_FIELDS,
    page: Number(page),
    pageSize: Number(pageSize),
  });

  ctx.body = { rows, count };
  return next();
}

async function searchUsers(ctx: Context, next: () => Promise<void>) {
  const { keyword, pageSize = 20 } = ctx.action.params;

  const where: Record<string, unknown> = {};
  if (keyword) {
    where.$or = [
      { username: { $includes: keyword } },
      { email: { $includes: keyword } },
      { nickname: { $includes: keyword } },
    ];
  }

  const [rows, count] = await ctx.db.getRepository('users').findAndCount({
    filter: where,
    fields: USER_SUMMARY_FIELDS,
    page: 1,
    pageSize: Number(pageSize),
  });

  ctx.body = { rows, count };
  return next();
}

async function addMember(ctx: Context, next: () => Promise<void>) {
  const { groupId, userId } = ctx.action.params.values || ctx.action.params || {};
  if (!groupId || !userId) {
    ctx.throw(400, 'groupId and userId are required');
  }

  const group = await ctx.db.getRepository('aiApiUsageGroups').findOne({
    filterByTk: groupId,
  });
  if (!group) {
    ctx.throw(404, 'Usage group not found');
  }
  // The default group is a fallback, not a membership target: an explicit row would
  // pin the user there and hide them from listUnassignedUsers forever.
  if (group.get('isDefault')) {
    ctx.throw(400, 'Cannot add members to the default group: users without another group use it automatically');
  }

  const existing = await ctx.db.getRepository('aiApiGroupMembers').findOne({
    filter: { userId },
  });
  if (existing) {
    ctx.throw(409, 'User already belongs to a group');
  }

  const member = await ctx.db.getRepository('aiApiGroupMembers').create({
    values: { groupId, userId },
  });
  ctx.body = member;
  return next();
}

async function removeMember(ctx: Context, next: () => Promise<void>) {
  const { groupId, userId } = ctx.action.params.values || ctx.action.params || {};
  if (!groupId || !userId) {
    ctx.throw(400, 'groupId and userId are required');
  }

  const member = await ctx.db.getRepository('aiApiGroupMembers').findOne({
    filter: { groupId, userId },
  });
  if (!member) {
    ctx.throw(404, 'Member not found');
  }

  await ctx.db.getRepository('aiApiGroupMembers').destroy({
    filterByTk: member.get('id'),
  });
  ctx.body = member;
  return next();
}

export default {
  name: 'aiApiUsageGroups',
  actions: {
    getByUser: {
      handler: getByUser,
    },
    listUnassignedUsers: {
      handler: listUnassignedUsers,
    },
    searchUsers: {
      handler: searchUsers,
    },
    addMember: {
      handler: addMember,
    },
    removeMember: {
      handler: removeMember,
    },
  },
};
