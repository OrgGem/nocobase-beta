// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from '@nocobase/database';
import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PluginAntdStyleThemeServer from '../plugin';
import SeedNocoBaseStudioThemes from '../migrations/20261120000000-seed-studio-themes';
import RenameStudioToVPBankThemes from '../migrations/20261120010000-rename-studio-to-vpbank-themes';

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

  it('seeds all 11 built-in themes with VPBank Light defaults, colorSettings, and exposes list publicly', async () => {
    const repo = db.getRepository('antdStyleThemeConfig');
    const items = await repo.find({ sort: 'id' });
    expect(items).toHaveLength(11);

    const headerCustomUids = [
      'compact_dark',
      'business_pro',
      'midnight_enterprise',
      'vpbank',
      'tween_one',
      'muse_dashboard',
      'vpbank_light',
      'vpbank_dark',
    ];
    for (const uid of headerCustomUids) {
      const record = items.find((item) => item.get('uid') === uid);
      expect(record, `missing built-in theme ${uid}`).toBeDefined();
      const config = record?.get('config') as { token?: { colorSettings?: string } } | undefined;
      expect(config?.token?.colorSettings).toBe('#F18B62');
    }

    const vpbankLight = items.find((item) => item.get('uid') === 'vpbank_light');
    const vpbankDark = items.find((item) => item.get('uid') === 'vpbank_dark');
    expect(vpbankLight?.get('default')).toBe(true);
    expect(vpbankLight?.get('config')).toMatchObject({
      name: 'VPBank Light',
      algorithm: 'compactAlgorithm',
      token: {
        colorPrimary: '#00B74F',
        colorBgLayout: '#fafafa',
        colorBgSider: '#ffffff',
        colorBgSiderMenuActive: '#E6FFED',
        colorTextSiderMenuActive: '#009A44',
        siderWidth: 230,
      },
      components: {
        Tabs: {
          inkBarColor: '#00B74F',
          itemSelectedColor: '#009A44',
        },
        Table: {
          rowSelectedBg: '#E6FFED',
        },
      },
    });
    expect((vpbankLight?.get('config') as { token?: { globalStyle?: string } })?.token?.globalStyle).toContain(
      'backdrop-filter: blur(20px)',
    );
    expect(vpbankDark?.get('config')).toMatchObject({
      name: 'VPBank Dark',
      algorithm: ['compactAlgorithm', 'darkAlgorithm'],
      token: {
        colorPrimary: '#00D15B',
        colorBgLayout: '#070707',
        colorBgSider: '#121212',
        colorBgSiderMenuActive: '#0F2E1E',
        colorTextSiderMenuActive: '#34D399',
        siderWidth: 230,
      },
      components: {
        Button: {
          primaryColor: '#042312',
        },
        Tabs: {
          inkBarColor: '#00D15B',
          itemSelectedColor: '#34D399',
        },
      },
    });

    const publicRes = await app.agent().resource('antdStyleThemeConfig').list();
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.data).toHaveLength(11);
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
    expect(allThemes).toHaveLength(11);

    const defaultThemes = await themeRepo.find({ filter: { default: true } });
    expect(defaultThemes).toHaveLength(1);
    expect(defaultThemes[0].get('uid')).toBe('vpbank');
  });

  it('seeds missing VPBank Studio themes in upgrade migration without overriding an existing default theme', async () => {
    const themeRepo = db.getRepository('antdStyleThemeConfig');
    await themeRepo.destroy({
      filter: {
        uid: {
          $in: ['vpbank_light', 'vpbank_dark'],
        },
      },
    });
    expect(await themeRepo.count()).toBe(9);

    const migration = new SeedNocoBaseStudioThemes({
      app,
      db,
      sequelize: db.sequelize,
      queryInterface: db.sequelize.getQueryInterface(),
      context: {} as never,
    } as never);
    await migration.up();
    // Idempotent second run
    await migration.up();

    expect(await themeRepo.count()).toBe(11);
    const vpbankLight = await themeRepo.findOne({ filter: { uid: 'vpbank_light' } });
    const vpbankDark = await themeRepo.findOne({ filter: { uid: 'vpbank_dark' } });
    expect(vpbankLight).toBeDefined();
    expect(vpbankDark).toBeDefined();
    expect(vpbankLight?.get('default')).toBe(false);

    const defaultThemes = await themeRepo.find({ filter: { default: true } });
    expect(defaultThemes).toHaveLength(1);
    expect(defaultThemes[0].get('uid')).toBe('vpbank');
  });

  it('renames legacy nocobase_studio themes in-place to VPBank Light/Dark while preserving id and default flag', async () => {
    const themeRepo = db.getRepository('antdStyleThemeConfig');
    const lightRow = await themeRepo.findOne({ filter: { uid: 'vpbank_light' } });
    const darkRow = await themeRepo.findOne({ filter: { uid: 'vpbank_dark' } });
    const lightId = lightRow?.get('id');
    const darkId = darkRow?.get('id');

    await lightRow?.update({
      uid: 'nocobase_studio',
      config: { name: 'NocoBase Studio', token: { colorPrimary: '#002ad1' } },
      default: true,
    });
    await darkRow?.update({
      uid: 'nocobase_studio_dark',
      config: { name: 'NocoBase Studio Dark', token: { colorPrimary: '#8ca9ff' } },
    });

    const migration = new RenameStudioToVPBankThemes({
      app,
      db,
      sequelize: db.sequelize,
      queryInterface: db.sequelize.getQueryInterface(),
      context: {} as never,
    } as never);
    await migration.up();
    await migration.up();

    const migratedLight = await themeRepo.findOne({ filter: { uid: 'vpbank_light' } });
    const migratedDark = await themeRepo.findOne({ filter: { uid: 'vpbank_dark' } });
    expect(migratedLight?.get('id')).toBe(lightId);
    expect(migratedLight?.get('default')).toBe(true);
    expect(migratedLight?.get('config')).toMatchObject({
      name: 'VPBank Light',
      token: { colorPrimary: '#00B74F' },
    });
    expect(migratedDark?.get('id')).toBe(darkId);
    expect(migratedDark?.get('config')).toMatchObject({
      name: 'VPBank Dark',
      token: { colorPrimary: '#00D15B' },
    });
    expect(await themeRepo.findOne({ filter: { uid: 'nocobase_studio' } })).toBeNull();
    expect(await themeRepo.findOne({ filter: { uid: 'nocobase_studio_dark' } })).toBeNull();
  });
});
