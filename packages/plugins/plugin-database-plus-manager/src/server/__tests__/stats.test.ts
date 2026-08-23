import { describe, expect, it } from 'vitest';
import { getStats, listCollections } from '../utils/stats';

function makeCollection(tableName = 'users') {
  return {
    tableName: () => tableName,
    model: { primaryKeyAttribute: 'id', getTableName: () => tableName },
  };
}

function makeStatsDb() {
  return {
    getCollection: () => makeCollection(),
    getRepository: () => ({
      getEstimatedRowCount: async () => 123,
      count: async () => 120,
    }),
    queryInterface: {
      collectionTableExists: async () => true,
      listViews: async () => [{ name: 'v_users' }],
      showTableDefinition: async () => ({ columns: [] }),
      getAutoIncrementInfo: async () => ({ currentVal: 120 }),
    },
  };
}

describe('stats utils', () => {
  it('builds collection stats', async () => {
    const stats = await getStats(makeStatsDb(), 'users');
    expect(stats.tableName).toBe('users');
    expect(stats.tableExists).toBe(true);
    expect(stats.estimatedRowCount).toBe(123);
    expect(stats.rowCount).toBe(120);
    expect(stats.autoIncrement).toEqual({ currentVal: 120 });
  });

  it('lists only non-system collections', async () => {
    const db = {
      getCollection: (name: string) => makeCollection(name),
      getRepository: () => ({
        getEstimatedRowCount: async () => 10,
        find: async () => [
          { get: () => ({ name: 'users', title: 'Users' }) },
          { get: () => ({ name: 'roles', title: 'Roles', options: { origin: 'system' } }) },
        ],
      }),
    };
    const list = await listCollections(db);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('users');
  });
});
