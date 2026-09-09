/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockDatabase, type Database } from '@nocobase/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rolePermissionsCollection from '../collections/ai-api-role-permissions';
import SeedDefaultRolePermissions from '../migrations/20260902000000-seed-default-role-permissions';

describe('SeedDefaultRolePermissions migration', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createMockDatabase();
    db.collection(rolePermissionsCollection);
    await db.sync({ force: true });
  });

  afterEach(async () => {
    await db.close();
  });

  function makeMigration() {
    const app = { logger: { info: vi.fn(), warn: vi.fn() } };
    const MigrationClass = SeedDefaultRolePermissions as unknown as new (context: { db: Database; app: unknown }) => {
      up: () => Promise<void>;
      down: () => Promise<void>;
    };
    return { migration: new MigrationClass({ db, app }), app, repository: db.getRepository('aiApiRolePermissions') };
  }

  it('seeds enabled permission rows for both root and admin', async () => {
    const { migration, repository } = makeMigration();

    await migration.up();

    for (const roleName of ['root', 'admin']) {
      const row = await repository.findOne({ filter: { roleName } });
      expect(row, `expected a seeded row for ${roleName}`).not.toBeNull();
      expect(row?.get('enabled')).toBe(true);
      expect(row?.get('allowAllEmployees')).toBe(true);
      expect(row?.get('allowedEmployees')).toEqual([]);
    }
    expect(await repository.count()).toBe(2);
  });

  it('is idempotent — rerunning does not duplicate rows', async () => {
    const { migration, repository } = makeMigration();

    await migration.up();
    await migration.up();

    expect(await repository.count()).toBe(2);
  });

  it('leaves a pre-existing admin row untouched and still seeds root', async () => {
    const { migration, repository } = makeMigration();
    await repository.create({
      values: { roleName: 'admin', enabled: false, allowAllEmployees: false, allowedEmployees: ['employee-a'] },
    });

    await migration.up();

    const adminRow = await repository.findOne({ filter: { roleName: 'admin' } });
    expect(adminRow?.get('enabled')).toBe(false);
    expect(adminRow?.get('allowAllEmployees')).toBe(false);
    expect(adminRow?.get('allowedEmployees')).toEqual(['employee-a']);

    const rootRow = await repository.findOne({ filter: { roleName: 'root' } });
    expect(rootRow?.get('enabled')).toBe(true);
    expect(rootRow?.get('allowAllEmployees')).toBe(true);
    expect(await repository.count()).toBe(2);
  });

  it('down() keeps the rows so a rollback does not lock root/admin out', async () => {
    const { migration, repository } = makeMigration();

    await migration.up();
    await migration.down();

    expect(await repository.count()).toBe(2);
  });
});
