/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context, Next } from '@nocobase/actions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function updateTheme(ctx: Context, next: Next) {
  const { currentUser } = ctx.state;
  if (!currentUser) {
    ctx.throw(401);
  }

  const rawValues = ctx.action.params?.values as unknown;
  const values = isRecord(rawValues) ? rawValues : {};
  const rawThemeId = values.themeId;

  let resolvedThemeId: number | string | null;
  if (rawThemeId === null) {
    resolvedThemeId = null;
  } else if (
    (typeof rawThemeId === 'number' && Number.isInteger(rawThemeId) && rawThemeId > 0) ||
    (typeof rawThemeId === 'string' && /^\d+$/.test(rawThemeId.trim()))
  ) {
    const filterByTk = typeof rawThemeId === 'string' ? rawThemeId.trim() : rawThemeId;
    const themeRepo = ctx.db.getRepository('antdStyleThemeConfig');
    const themeRecord = themeRepo ? await themeRepo.findOne({ filterByTk }) : null;
    if (!themeRecord) {
      ctx.throw(400, 'Theme not found');
    }
    if (!themeRecord.get('optional') && !themeRecord.get('default')) {
      ctx.throw(400, 'Theme is not selectable');
    }
    const persistedId = themeRecord.get('id');
    resolvedThemeId = typeof persistedId === 'number' || typeof persistedId === 'string' ? persistedId : null;
  } else {
    ctx.throw(400, 'Invalid themeId');
  }

  const userRepo = ctx.db.getRepository('users');
  const user = await userRepo.findOne({ filterByTk: currentUser.id });
  if (!user) {
    ctx.throw(404, 'User not found');
  }

  const rawSettings = user.get('systemSettings');
  const prevSettings = isRecord(rawSettings) ? rawSettings : {};
  const nextSettings = {
    ...prevSettings,
    antdStyleThemeId: resolvedThemeId,
    themeId: resolvedThemeId,
  };

  await userRepo.update({
    filterByTk: currentUser.id,
    values: {
      systemSettings: nextSettings,
    },
  });

  ctx.body = nextSettings;
  await next();
}
