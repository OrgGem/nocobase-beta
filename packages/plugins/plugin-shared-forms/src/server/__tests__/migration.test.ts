/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import AddV2Config from '../migrations/20261026000000-add-v2-config';

describe('Shared Forms V2 column migration with schema stubs', () => {
  it('adds one nullable JSON column and safely skips repeated upgrades', async () => {
    const columns: Record<string, unknown> = {};
    const addColumn = vi.fn(async (_table: string, name: string, options: unknown) => {
      columns[name] = options;
    });
    const queryInterface = { describeTable: async () => columns, addColumn };
    const db = {
      getCollection: () => ({ existsInDb: async () => true, getTableNameWithSchema: () => 'prefixed_sharedForms' }),
      sequelize: { getQueryInterface: () => queryInterface },
    };
    const migration = new AddV2Config({ db } as unknown as ConstructorParameters<typeof AddV2Config>[0]);
    await migration.up();
    await migration.up();
    expect(addColumn).toHaveBeenCalledTimes(1);
    expect(addColumn).toHaveBeenCalledWith(
      'prefixed_sharedForms',
      'v2Config',
      expect.objectContaining({ allowNull: true }),
    );
  });
});
