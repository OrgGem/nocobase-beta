/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { ResourceOptions } from '@nocobase/resourcer';

const MAX_PAGE_SIZE = 100;

/**
 * Minimal user directory for the permission page's user picker.
 *
 * The page is gated by AI_API_USER_PERMISSIONS_SNIPPET, but `users:list` belongs to
 * `pm.plugin-users`. Calling it would force every permission admin to also be a user admin,
 * so this action exposes only the identity fields the picker renders — never password hashes,
 * roles or any other user column.
 */
const aiApiUserPermissionsResource: ResourceOptions = {
  name: 'aiApiUserPermissions',
  actions: {
    async listUsers(ctx, next) {
      const params = ctx.action.params || {};
      const keyword = typeof params.keyword === 'string' ? params.keyword.trim() : '';
      const page = Math.max(1, Number(params.page) || 1);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.pageSize) || 50));

      const filter: Record<string, unknown> = keyword
        ? {
            $or: [
              { nickname: { $includes: keyword } },
              { username: { $includes: keyword } },
              { email: { $includes: keyword } },
            ],
          }
        : {};

      // A user already holding a grant is excluded so the picker cannot produce a duplicate
      // that the unique index on userId would reject at save time.
      if (params.excludeGranted) {
        const granted = await ctx.db.getRepository('aiApiUserPermissions').find({ fields: ['userId'] });
        const ids = granted.map((row) => row.get('userId')).filter((id) => id !== null && id !== undefined);
        if (ids.length) filter.id = { $notIn: ids };
      }

      const [rows, count] = await ctx.db.getRepository('users').findAndCount({
        filter,
        fields: ['id', 'nickname', 'username', 'email'],
        sort: ['nickname', 'id'],
        offset: (page - 1) * pageSize,
        limit: pageSize,
      });

      // Use the canonical { rows, ...meta } action shape. NocoBase's dataWrapping
      // middleware turns this into { data, meta } on the wire; returning that wire
      // shape here would make it wrap a second time.
      ctx.body = {
        rows: rows.map((row) => ({
          id: row.get('id'),
          nickname: row.get('nickname'),
          username: row.get('username'),
          email: row.get('email'),
        })),
        count,
        page,
        pageSize,
      };
      await next();
    },
  },
};

export default aiApiUserPermissionsResource;
