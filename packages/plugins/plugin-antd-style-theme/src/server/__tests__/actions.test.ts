// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from '@nocobase/database';
import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PluginAntdStyleThemeServer from '../plugin';

describe('plugin-antd-style-theme server actions & seeding', () => {
  let app: MockServer;
  let db: Database;
  let storage: string;
  const previousStorage = process.env.STORAGE_PATH;

  beforeAll(async () => {
    storage = mkdtempSync(join(tmpdir(), 'nocobase-antd-style-theme-test-'));
    process.env.STORAGE_PATH = storage;
    app = await createMockServer({
      registerActions: true,
      acl: true,
      plugins: [
        'error-handler',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'system-settings',
        'field-sort',
        [PluginAntdStyleThemeServer, { name: 'plugin-antd-style-theme' }],
      ],
    });
    db = app.db;
  }, 120000);

  afterAll(async () => {
    await app?.destroy();
    if (previousStorage === undefined) {
      delete process.env.STORAGE_PATH;
    } else {
      process.env.STORAGE_PATH = previousStorage;
    }
    rmSync(storage, { recursive: true, force: true });
  });

  it('seeds all 9 built-in themes with colorSettings and exposes list publicly', async () => {
    const repo = db.getRepository('antdStyleThemeConfig');
    const items = await repo.find({ sort: 'id' });
    expect(items).toHaveLength(9);

    const headerCustomUids = [
      'compact_dark',
      'business_pro',
      'midnight_enterprise',
      'vpbank',
      'tween_one',
      'muse_dashboard',
    ];
    for (const uid of headerCustomUids) {
      const record = items.find((item) => item.get('uid') === uid);
      expect(record, `missing built-in theme ${uid}`).toBeDefined();
      const config = record?.get('config') as { token?: { colorSettings?: string } } | undefined;
      expect(config?.token?.colorSettings).toBe('#F18B62');
    }

    const publicRes = await app.agent().resource('antdStyleThemeConfig').list();
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.data).toHaveLength(9);
  });

  it('allows a logged-in user to persist numeric, stringified, and null themeId via users:updateAntdStyleTheme', async () => {
    const userRepo = db.getRepository('users');
    const user = await userRepo.create({
      values: {
        username: 'theme-tester',
        email: 'theme-tester@example.com',
      },
    });
    const userAgent = await app.agent().login(user);
    const themeRepo = db.getRepository('antdStyleThemeConfig');
    const businessPro = await themeRepo.findOne({ filter: { uid: 'business_pro' } });
    const dark = await themeRepo.findOne({ filter: { uid: 'dark' } });
    const businessProId = businessPro?.get('id') as number;
    const darkId = dark?.get('id') as number;

    const numericRes = await userAgent.resource('users').updateAntdStyleTheme({
      values: { themeId: businessProId },
    });
    expect(numericRes.status).toBe(200);
    let updatedUser = await userRepo.findOne({ filterByTk: user.id });
    expect(updatedUser?.get('systemSettings')).toMatchObject({
      antdStyleThemeId: businessProId,
      themeId: businessProId,
    });

    const stringRes = await userAgent.resource('users').updateAntdStyleTheme({
      values: { themeId: String(darkId) },
    });
    expect(stringRes.status).toBe(200);
    updatedUser = await userRepo.findOne({ filterByTk: user.id });
    expect(updatedUser?.get('systemSettings')).toMatchObject({
      antdStyleThemeId: darkId,
      themeId: darkId,
    });

    const resetRes = await userAgent.resource('users').updateAntdStyleTheme({
      values: { themeId: null },
    });
    expect(resetRes.status).toBe(200);
    updatedUser = await userRepo.findOne({ filterByTk: user.id });
    expect(updatedUser?.get('systemSettings')).toMatchObject({
      antdStyleThemeId: null,
      themeId: null,
    });
  });

  it('rejects unauthenticated, missing, invalid, and non-selectable themes', async () => {
    const anonymousAgent = app.agent();
    const themeRepo = db.getRepository('antdStyleThemeConfig');
    const dark = await themeRepo.findOne({ filter: { uid: 'dark' } });
    const anonRes = await anonymousAgent.resource('users').updateAntdStyleTheme({
      values: { themeId: dark?.get('id') },
    });
    expect(anonRes.status).toBe(401);

    const user = await db.getRepository('users').create({
      values: {
        username: 'theme-validator',
        email: 'theme-validator@example.com',
      },
    });
    const userAgent = await app.agent().login(user);

    const missingRes = await userAgent.resource('users').updateAntdStyleTheme({
      values: { themeId: 999999 },
    });
    expect(missingRes.status).toBe(400);

    for (const invalidThemeId of ['abc', true, 0, -1]) {
      const invalidRes = await userAgent.resource('users').updateAntdStyleTheme({
        values: { themeId: invalidThemeId },
      });
      expect(invalidRes.status).toBe(400);
    }

    const hiddenTheme = await themeRepo.create({
      values: {
        config: { name: 'Hidden Theme' },
        optional: false,
        isBuiltIn: false,
        default: false,
      },
    });
    try {
      const hiddenRes = await userAgent.resource('users').updateAntdStyleTheme({
        values: { themeId: hiddenTheme.get('id') },
      });
      expect(hiddenRes.status).toBe(400);
    } finally {
      await themeRepo.destroy({ filterByTk: hiddenTheme.get('id') });
    }
  });

  it('keeps ensureBuiltinThemes idempotent and preserves a custom default theme', async () => {
    const themeRepo = db.getRepository('antdStyleThemeConfig');
    const vpbank = await themeRepo.findOne({ filter: { uid: 'vpbank' } });
    expect(vpbank).toBeDefined();
    await themeRepo.update({
      filterByTk: vpbank?.get('id'),
      values: { default: true, optional: true },
    });

    const plugin = app.pm.get(PluginAntdStyleThemeServer) as PluginAntdStyleThemeServer;
    await plugin.ensureBuiltinThemes();

    const allThemes = await themeRepo.find();
    expect(allThemes).toHaveLength(9);

    const defaultThemes = await themeRepo.find({ filter: { default: true } });
    expect(defaultThemes).toHaveLength(1);
    expect(defaultThemes[0].get('uid')).toBe('vpbank');
  });
});
