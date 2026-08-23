import { describe, expect, it, vi } from 'vitest';
import { addIndex, listIndexes, removeIndex } from '../utils/indexes';

function makeDb() {
  const showIndex = vi.fn(async () => [{ name: 'idx_users_name' }]);
  const add = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const db = {
    sequelize: { getQueryInterface: () => ({ showIndex, addIndex: add, removeIndex: remove }) },
  };
  return { db, showIndex, add, remove };
}

describe('index utils', () => {
  it('lists indexes for a table', async () => {
    const { db, showIndex } = makeDb();
    await listIndexes(db, 'users');
    expect(showIndex).toHaveBeenCalledWith('users');
  });

  it('adds an index with name and fields', async () => {
    const { db, add } = makeDb();
    await addIndex(db, 'users', { name: 'idx_users_name', fields: ['name'] });
    expect(add).toHaveBeenCalledWith('users', ['name'], { name: 'idx_users_name' });
  });

  it('removes an index', async () => {
    const { db, remove } = makeDb();
    await removeIndex(db, 'users', 'idx_users_name');
    expect(remove).toHaveBeenCalledWith('users', 'idx_users_name');
  });
});
